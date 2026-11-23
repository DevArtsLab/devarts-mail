// Attio CRM sync: mirror stored emails and calendar events into Attio.
// Attio's native sync only supports Google/Microsoft mailboxes, so anything
// flowing through this worker (any provider via Email Routing) is pushed
// over the REST API: emails -> notes on person records, events -> meetings.
// Called from the */10m cron; pending rows are picked up until marked, so
// first deploy backfills history over successive runs.

import type { CalEvent, Env, StoredEmail } from "./types";
import { listIdentities, primaryIdentity } from "./identities";
import {
  emailsPendingAttio,
  markEmailAttioAttempted,
  markEmailAttioSynced,
  eventsPendingAttio,
  markEventAttioAttempted,
  saveEmailAttioNotes,
  setEventAttioSynced,
  enqueueAttioDelete,
  pendingAttioDeletes,
  removeAttioDelete,
  removeAttioDeleteRef,
  deferAttioDelete,
} from "./db";

const BASE = "https://api.attio.com/v2";
const EMAIL_BATCH = 40;
const EVENT_BATCH = 20;
const DELETE_BATCH = 50;
/** Failed syncs back off this long before the next attempt. */
const RETRY_DELAY_MS = 30 * 60 * 1000;
/** Attio rejects meeting descriptions over 10,000 chars. */
const MAX_MEETING_DESC = 9000;
const MAX_BODY_CHARS = 4000;
const MAX_PARTICIPANTS = 20;
/**
 * Max Attio API calls per cron run. Workers Free allows ~50 subrequests
 * per invocation; stay well under so one run cannot exhaust the budget.
 */
const SUBREQUEST_BUDGET = 45;
/** Cap on the Location metadata line so status/UID always fit. */
const MAX_LOCATION_CHARS = 500;

/** Thrown when the per-run Attio call budget is exhausted. */
class BudgetExhaustedError extends Error {}

/** Remaining Attio API calls for this cron run (undefined = unlimited). */
interface AttioBudget {
  remaining: number;
}

/** Domains that never become a company record. */
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "mail.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "fastmail.com",
  "hey.com",
  "yandex.com",
]);

function attioEnabled(env: Env): boolean {
  return env.ATTIO_SYNC_ENABLED === "true" && !!env.ATTIO_ACCESS_TOKEN;
}

export async function syncAttio(env: Env): Promise<void> {
  if (!attioEnabled(env)) return;
  const retryBefore = Date.now() - RETRY_DELAY_MS;
  const budget: AttioBudget = { remaining: SUBREQUEST_BUDGET };
  await syncEmails(env, retryBefore, budget);
  await syncEvents(env, retryBefore, budget);
  await syncPendingDeletes(env, budget);
}

/** Drain the queue of remote deletes that failed after local removal. */
export async function syncPendingDeletes(
  env: Env,
  budget?: AttioBudget,
): Promise<void> {
  const now = Date.now();
  for (const d of await pendingAttioDeletes(env, DELETE_BATCH, now)) {
    if (budget && budget.remaining <= 0) break;
    const path = `/${d.kind === "note" ? "notes" : "meetings"}/${d.remote_id}`;
    try {
      await attioDelete(env, path, budget);
      await removeAttioDelete(env, d.id);
    } catch (e) {
      if (e instanceof BudgetExhaustedError) break;
      const attempts = d.attempts + 1;
      await deferAttioDelete(env, d.id, attempts, now + attempts * RETRY_DELAY_MS);
      console.error("attio pending delete failed:", d.remote_id, e);
    }
  }
}

/** Remove the Attio notes created for an email (called on local delete). */
export async function deleteAttioEmailNotes(env: Env, e: StoredEmail): Promise<void> {
  if (!attioEnabled(env)) return;
  for (const noteId of Object.values(parseNoteMap(e.attio_notes))) {
    await deleteOrQueue(env, "note", noteId);
  }
}

/** Remove the Attio meeting for an event (called on local delete). */
export async function deleteAttioMeeting(
  env: Env,
  ev: { attioMeetingId?: string | null },
): Promise<void> {
  if (!attioEnabled(env) || !ev.attioMeetingId) return;
  await deleteOrQueue(env, "meeting", ev.attioMeetingId);
}

/**
 * DELETE a remote object. The ID is queued BEFORE the attempt so a worker
 * crash mid-delete still leaves a retry path; on success the queue row
 * is removed again.
 */
async function deleteOrQueue(
  env: Env,
  kind: "note" | "meeting",
  remoteId: string,
  budget?: AttioBudget,
): Promise<void> {
  const path = `/${kind === "note" ? "notes" : "meetings"}/${remoteId}`;
  await enqueueAttioDelete(env, kind, remoteId).catch((e) =>
    console.error("attio delete enqueue failed:", remoteId, e),
  );
  try {
    await attioDelete(env, path, budget);
    await removeAttioDeleteRef(env, kind, remoteId);
  } catch (err) {
    console.error(`attio ${kind} delete failed:`, remoteId, err);
    // Stays queued; syncPendingDeletes retries with backoff.
  }
}

// ---------------------------------------------------------------------------
// emails -> notes on person records (+ company records for real domains)
// ---------------------------------------------------------------------------

async function syncEmails(
  env: Env,
  retryBefore: number,
  budget: AttioBudget,
): Promise<void> {
  for (const email of await emailsPendingAttio(env, EMAIL_BATCH, retryBefore)) {
    if (budget.remaining <= 0) break;
    // addr -> note_id for notes already created; retries skip these so a
    // partial failure never produces duplicate notes in Attio.
    const noted = parseNoteMap(email.attio_notes);
    let failed = false;
    try {
      const external = externalAddresses(env, email);
      const pending = external.filter((a) => !(a in noted));
      if (pending.length === 0) {
        await markEmailAttioSynced(env, email.id);
        continue;
      }
      const { title, content } = buildEmailNote(env, email);
      for (const addr of pending.slice(0, MAX_PARTICIPANTS)) {
        if (budget.remaining <= 0) break;
        try {
          const personId = await upsertPerson(env, addr, budget);
          if (!personId) throw new Error("no record_id in person response");
          const res = await attioFetch(
            env,
            "POST",
            "/notes",
            {
              data: {
                parent_object: "people",
                parent_record_id: personId,
                title,
                format: "plaintext",
                content,
              },
            },
            budget,
          );
          const noteId = res?.data?.id?.note_id;
          if (!noteId) throw new Error("no note_id in note response");
          noted[addr] = noteId;
          await saveEmailAttioNotes(env, email.id, noted);
        } catch (e) {
          if (e instanceof BudgetExhaustedError) break;
          // Stays unnoted and is retried on the next run; participants
          // that already succeeded are skipped, so no duplicates.
          failed = true;
          console.error("attio note sync failed:", email.id, addr, e);
        }
      }
      if (external.every((a) => a in noted)) {
        await markEmailAttioSynced(env, email.id);
      } else if (failed) {
        // Back off so permanent failures cannot starve the batch.
        await markEmailAttioAttempted(env, email.id);
      }
    } catch (e) {
      if (e instanceof BudgetExhaustedError) break;
      console.error("attio email sync failed:", email.id, e);
      await markEmailAttioAttempted(env, email.id).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// calendar events -> meetings
// ---------------------------------------------------------------------------

async function syncEvents(
  env: Env,
  retryBefore: number,
  budget: AttioBudget,
): Promise<void> {
  for (const ev of await eventsPendingAttio(env, EVENT_BATCH, retryBefore)) {
    if (budget.remaining <= 0) break;
    try {
      if (ev.status === "CANCELLED") {
        if (ev.attioMeetingId) {
          await attioDelete(env, `/meetings/${ev.attioMeetingId}`, budget);
        }
        await setEventAttioSynced(env, ev.uid, null);
        continue;
      }
      // Attio meetings are immutable: PATCH only appends linked records,
      // so any change means create a replacement, then remove the old one.
      // Create FIRST: if Attio rejects the payload the existing meeting
      // stays intact instead of leaving the event with no meeting.
      const oldId = ev.attioMeetingId;
      const linked = oldId ? await meetingLinkedRecords(env, oldId, budget) : [];
      const res = await attioFetch(
        env,
        "POST",
        "/meetings",
        { data: buildMeetingBody(env, ev) },
        budget,
      );
      const meetingId = res?.data?.id?.meeting_id;
      if (!meetingId) throw new Error("no meeting_id in response");
      if (linked.length) {
        // Migrate explicit record links (e.g. deals) to the replacement.
        await attioFetch(
          env,
          "PATCH",
          `/meetings/${meetingId}`,
          { data: { linked_records: linked } },
          budget,
        ).catch((e) =>
          console.error("attio linked-records migrate failed:", meetingId, e),
        );
      }
      // Queue the old meeting BEFORE marking synced: if the worker dies
      // here, the cron still deletes the stale meeting.
      if (oldId) await enqueueAttioDelete(env, "meeting", oldId);
      await setEventAttioSynced(env, ev.uid, meetingId);
      if (oldId) await deleteOrQueue(env, "meeting", oldId, budget);
    } catch (e) {
      if (e instanceof BudgetExhaustedError) break;
      console.error("attio event sync failed:", ev.uid, e);
      await markEventAttioAttempted(env, ev.uid).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// payload builders (exported for tests)
// ---------------------------------------------------------------------------

export function buildEmailNote(
  env: Env,
  e: StoredEmail,
): { title: string; content: string } {
  const dir = e.direction === "in" ? "in" : "out";
  const subject = e.subject || "(no subject)";
  const to = parseAddrs(e.to_addresses).join(", ");
  const cc = parseAddrs(e.cc_addresses).join(", ");
  // HTML-only mail has no body_text; fall back to a text rendering.
  const body = (e.body_text || "").trim() || htmlToText(e.body_html || "");
  return {
    title: `Email ${dir}: ${subject}`.slice(0, 200),
    content: [
      `Direction: ${dir === "in" ? "inbound" : "outbound"}`,
      `From: ${e.from_address}`,
      to ? `To: ${to}` : "",
      cc ? `Cc: ${cc}` : "",
      `Date: ${new Date(e.received_at).toISOString()}`,
      e.message_id ? `Message-ID: ${e.message_id}` : "",
      "",
      body.length > MAX_BODY_CHARS
        ? `${body.slice(0, MAX_BODY_CHARS)}\n[truncated]`
        : body,
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}

interface MeetingBody {
  title: string;
  description: string;
  start: { datetime: string; timezone: string } | { date: string };
  end: { datetime: string; timezone: string } | { date: string };
  is_all_day: boolean;
  participants: {
    email_address?: string;
    name?: string;
    is_organizer: boolean;
    status: "accepted" | "tentative" | "declined" | "pending";
  }[];
}

export function buildMeetingBody(
  env: Env,
  ev: CalEvent & { myPartstat?: string | null },
): MeetingBody {
  const tz = env.CALENDAR_TZ || "UTC";
  const iso = (ms: number) => new Date(ms).toISOString();
  const day = (ms: number) => iso(ms).slice(0, 10);
  const selfAddrs = new Set(listIdentities(env).map((i) => i.address.toLowerCase()));

  const participants: MeetingBody["participants"] = [];
  if (ev.organizerEmail) {
    participants.push({
      email_address: ev.organizerEmail,
      name: ev.organizerName || undefined,
      is_organizer: true,
      status: "accepted",
    });
  }
  for (const a of ev.attendees) {
    if (!a.email || a.email === ev.organizerEmail) continue;
    // Our own RSVP lives in my_partstat, not the ICS attendee PARTSTAT.
    const isSelf = selfAddrs.has(a.email.toLowerCase());
    participants.push({
      email_address: a.email,
      name: a.name || undefined,
      is_organizer: false,
      status:
        isSelf && ev.myPartstat ? mapPartstat(ev.myPartstat) : mapPartstat(a.partstat),
    });
  }
  // Attio requires at least one participant: personal events get us.
  if (participants.length === 0) {
    const self = primaryIdentity(env);
    participants.push({
      email_address: self.address,
      name: self.name,
      is_organizer: false,
      status: "accepted",
    });
  }

  // Metadata goes last but must survive truncation: budget the free-form
  // notes so location/status/UID always fit under Attio's 10k limit.
  const meta = [
    ev.location ? `Location: ${ev.location.slice(0, MAX_LOCATION_CHARS)}` : "",
    `Status: ${ev.status}`,
    `UID: ${ev.uid}`,
  ]
    .filter(Boolean)
    .join("\n");
  const TRUNCATED = "\n[truncated]";
  const notesBudget = MAX_MEETING_DESC - meta.length - 1;
  const rawNotes = ev.description || "";
  // Reserve marker space only when truncation is actually needed; fall
  // back to a one-char marker if even that cannot fit.
  const marker = notesBudget >= TRUNCATED.length ? TRUNCATED : "\n…";
  const notes =
    rawNotes.length <= notesBudget
      ? rawNotes
      : notesBudget >= marker.length
        ? `${rawNotes.slice(0, notesBudget - marker.length)}${marker}`
        : "";
  const desc = [notes, meta].filter(Boolean).join("\n");

  return {
    title: ev.summary || "(untitled event)",
    description:
      desc.length > MAX_MEETING_DESC ? desc.slice(0, MAX_MEETING_DESC) : desc,
    is_all_day: ev.allDay,
    start: ev.allDay
      ? { date: day(ev.dtstart) }
      : { datetime: iso(ev.dtstart), timezone: tz },
    // All-day end dates are exclusive: same-day events still end "tomorrow".
    end: ev.allDay
      ? { date: day(Math.max(ev.dtend, ev.dtstart + 86_400_000)) }
      : { datetime: iso(ev.dtend), timezone: tz },
    participants,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mapPartstat(p?: string): "accepted" | "tentative" | "declined" | "pending" {
  switch ((p || "").toUpperCase()) {
    case "ACCEPTED":
      return "accepted";
    case "TENTATIVE":
      return "tentative";
    case "DECLINED":
      return "declined";
    default:
      return "pending";
  }
}

function parseNoteMap(json?: string | null): Record<string, string> {
  try {
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
}

function parseAddrs(json: string): string[] {
  try {
    return JSON.parse(json || "[]");
  } catch {
    return [];
  }
}

function domainOf(addr: string): string {
  return addr.split("@")[1]?.toLowerCase() || "";
}

/** Crude HTML -> text for notes when only body_html was stored. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Participants that are not us: drops our identities and MAIL_DOMAIN. */
export function externalAddresses(env: Env, e: StoredEmail): string[] {
  const self = new Set(listIdentities(env).map((i) => i.address));
  for (const part of (env.ATTIO_IGNORE_ADDRESSES || "").split(",")) {
    const a = part.trim().toLowerCase();
    if (a) self.add(a);
  }
  const all = [
    e.from_address,
    ...parseAddrs(e.to_addresses),
    ...parseAddrs(e.cc_addresses),
  ];
  const seen = new Set<string>();
  return all
    .map((a) => (a || "").trim().toLowerCase())
    .filter((a) => {
      if (!a || self.has(a) || seen.has(a)) return false;
      if (domainOf(a) === env.MAIL_DOMAIN.toLowerCase()) return false;
      seen.add(a);
      return true;
    });
}

async function attioFetch(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  budget?: AttioBudget,
): Promise<any> {
  if (budget) {
    if (budget.remaining <= 0)
      throw new BudgetExhaustedError("attio call budget exhausted");
    budget.remaining--;
  }
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.ATTIO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const err = new Error(
      `Attio ${method} ${path}: ${r.status} ${await r.text()}`,
    ) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

/** Explicit record links on a meeting, in PATCH linked_records shape. */
async function meetingLinkedRecords(
  env: Env,
  meetingId: string,
  budget?: AttioBudget,
): Promise<{ object: string; record_id: string }[]> {
  try {
    const res = await attioFetch(
      env,
      "GET",
      `/meetings/${meetingId}`,
      undefined,
      budget,
    );
    const raw = res?.data?.linked_records;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r: any) => ({
        object: r.object || r.target_object,
        record_id: r.record_id || r.target_record_id,
      }))
      .filter((r) => r.object && r.record_id);
  } catch (e) {
    console.error("attio meeting read failed:", meetingId, e);
    return [];
  }
}

/** DELETE that tolerates 404 (resource already gone in Attio). */
async function attioDelete(
  env: Env,
  path: string,
  budget?: AttioBudget,
): Promise<void> {
  try {
    await attioFetch(env, "DELETE", path, undefined, budget);
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
}

async function upsertPerson(
  env: Env,
  email: string,
  budget?: AttioBudget,
): Promise<string | null> {
  const emailValue = { email_addresses: [{ email_address: email }] };
  const res = await attioFetch(
    env,
    "PUT",
    "/objects/people/records?matching_attribute=email_addresses",
    { data: { values: emailValue } },
    budget,
  );
  const record = res?.data;
  const recordId = record?.id?.record_id ?? null;
  if (!recordId) return null;

  // Link work-domain people to a company, but only when the record has
  // no company yet — never overwrite one set manually in Attio.
  const dom = domainOf(email);
  const company = record?.values?.company;
  const hasCompany = Array.isArray(company) ? company.length > 0 : company != null;
  if (dom && !FREEMAIL_DOMAINS.has(dom) && record?.values && !hasCompany) {
    await attioFetch(
      env,
      "PUT",
      "/objects/people/records?matching_attribute=email_addresses",
      {
        data: {
          values: {
            ...emailValue,
            company: [
              {
                target_object: "companies",
                target_record_reference: {
                  match: { domains: [dom] },
                  if_unmatched: "create",
                  if_multiple_matches: "error",
                  create: { name: dom },
                },
              },
            ],
          },
        },
      },
      budget,
    );
  }
  return recordId;
}
