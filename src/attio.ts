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
  markEmailAttioSynced,
  eventsPendingAttio,
  saveEmailAttioNotes,
  setEventAttioSynced,
} from "./db";

const BASE = "https://api.attio.com/v2";
const EMAIL_BATCH = 40;
const EVENT_BATCH = 20;
const MAX_BODY_CHARS = 4000;
const MAX_PARTICIPANTS = 20;

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
  await syncEmails(env);
  await syncEvents(env);
}

/** Remove the Attio notes created for an email (called on local delete). */
export async function deleteAttioEmailNotes(env: Env, e: StoredEmail): Promise<void> {
  if (!attioEnabled(env)) return;
  for (const noteId of Object.values(parseNoteMap(e.attio_notes))) {
    try {
      await attioDelete(env, `/notes/${noteId}`);
    } catch (err) {
      console.error("attio note delete failed:", noteId, err);
    }
  }
}

/** Remove the Attio meeting for an event (called on local delete). */
export async function deleteAttioMeeting(
  env: Env,
  ev: { attioMeetingId?: string | null },
): Promise<void> {
  if (!attioEnabled(env) || !ev.attioMeetingId) return;
  try {
    await attioDelete(env, `/meetings/${ev.attioMeetingId}`);
  } catch (err) {
    console.error("attio meeting delete failed:", ev.attioMeetingId, err);
  }
}

// ---------------------------------------------------------------------------
// emails -> notes on person records (+ company records for real domains)
// ---------------------------------------------------------------------------

async function syncEmails(env: Env): Promise<void> {
  for (const email of await emailsPendingAttio(env, EMAIL_BATCH)) {
    // addr -> note_id for notes already created; retries skip these so a
    // partial failure never produces duplicate notes in Attio.
    const noted = parseNoteMap(email.attio_notes);
    try {
      const external = externalAddresses(env, email);
      const pending = external.filter((a) => !(a in noted));
      if (pending.length === 0) {
        await markEmailAttioSynced(env, email.id);
        continue;
      }
      const { title, content } = buildEmailNote(env, email);
      for (const addr of pending.slice(0, MAX_PARTICIPANTS)) {
        try {
          const personId = await upsertPerson(env, addr);
          if (!personId) throw new Error("no record_id in person response");
          const res = await attioFetch(env, "POST", "/notes", {
            data: {
              parent_object: "people",
              parent_record_id: personId,
              title,
              format: "plaintext",
              content,
            },
          });
          const noteId = res?.data?.id?.note_id;
          if (!noteId) throw new Error("no note_id in note response");
          noted[addr] = noteId;
          await saveEmailAttioNotes(env, email.id, noted);
        } catch (e) {
          // Stays unnoted and is retried on the next run; participants
          // that already succeeded are skipped, so no duplicates.
          console.error("attio note sync failed:", email.id, addr, e);
        }
      }
      if (external.every((a) => a in noted)) {
        await markEmailAttioSynced(env, email.id);
      }
    } catch (e) {
      console.error("attio email sync failed:", email.id, e);
    }
  }
}

// ---------------------------------------------------------------------------
// calendar events -> meetings
// ---------------------------------------------------------------------------

async function syncEvents(env: Env): Promise<void> {
  for (const ev of await eventsPendingAttio(env, EVENT_BATCH)) {
    try {
      if (ev.status === "CANCELLED") {
        if (ev.attioMeetingId) {
          await attioDelete(env, `/meetings/${ev.attioMeetingId}`);
        }
        await setEventAttioSynced(env, ev.uid, null);
        continue;
      }
      const body = { data: buildMeetingBody(env, ev) };
      let meetingId = ev.attioMeetingId;
      if (meetingId) {
        try {
          await attioFetch(env, "PATCH", `/meetings/${meetingId}`, body);
        } catch (e) {
          // Meeting gone in Attio: fall through and re-create it.
          if ((e as { status?: number }).status !== 404) throw e;
          meetingId = null;
        }
      }
      if (!meetingId) {
        const res = await attioFetch(env, "POST", "/meetings", body);
        meetingId = res?.data?.id?.meeting_id;
        if (!meetingId) throw new Error("no meeting_id in response");
      }
      await setEventAttioSynced(env, ev.uid, meetingId);
    } catch (e) {
      console.error("attio event sync failed:", ev.uid, e);
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
  const body = (e.body_text || "").trim();
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

export function buildMeetingBody(env: Env, ev: CalEvent): MeetingBody {
  const tz = env.CALENDAR_TZ || "UTC";
  const iso = (ms: number) => new Date(ms).toISOString();
  const day = (ms: number) => iso(ms).slice(0, 10);

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
    participants.push({
      email_address: a.email,
      name: a.name || undefined,
      is_organizer: false,
      status: mapPartstat(a.partstat),
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

  return {
    title: ev.summary || "(untitled event)",
    description: [
      ev.description || "",
      ev.location ? `Location: ${ev.location}` : "",
      `Status: ${ev.status}`,
      `UID: ${ev.uid}`,
    ]
      .filter(Boolean)
      .join("\n"),
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
): Promise<any> {
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

/** DELETE that tolerates 404 (resource already gone in Attio). */
async function attioDelete(env: Env, path: string): Promise<void> {
  try {
    await attioFetch(env, "DELETE", path);
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
}

async function upsertPerson(env: Env, email: string): Promise<string | null> {
  const values: Record<string, unknown> = {
    email_addresses: [{ email_address: email }],
  };
  // Link work-domain people to a company record, created on first sight.
  const dom = domainOf(email);
  if (dom && !FREEMAIL_DOMAINS.has(dom)) {
    values.company = [
      {
        target_object: "companies",
        target_record_reference: {
          match: { domains: [dom] },
          if_unmatched: "create",
          if_multiple_matches: "error",
          create: { name: dom },
        },
      },
    ];
  }
  const res = await attioFetch(
    env,
    "PUT",
    "/objects/people/records?matching_attribute=email_addresses",
    { data: { values } },
  );
  return res?.data?.id?.record_id ?? null;
}
