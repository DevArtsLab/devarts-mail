// Inbound email handler: parse -> store -> calendar side-effects.

import type { Env } from "./types";
import { parseInbound, sendMail } from "./mail";
import { parseIcs, buildReplyIcs } from "./ical";
import {
  insertEmail,
  upsertEvent,
  getEvent,
  getEmail,
  linkEventSource,
  setMyPartstat,
  setAttendeePartstat,
} from "./db";

export async function handleInbound(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const parsed = await parseInbound(message.raw);

  let eventUid: string | null = null;
  let method: string | null = null;
  let needsReply: { uid: string } | null = null;

  if (parsed.calendar) {
    const cal = parseIcs(parsed.calendar.ics);
    method = (parsed.calendar.method || cal.method || "").toUpperCase() || null;
    const ev = cal.events[0];

    if (ev?.uid) {
      eventUid = ev.uid;

      if (method === "REQUEST") {
        // New or updated invite: store it, mark RSVP pending.
        const existing = await getEvent(env, ev.uid);
        await upsertEvent(env, ev, {
          myPartstat:
            existing?.myPartstat === "ACCEPTED" &&
            ev.sequence <= (existing.sequence ?? 0)
              ? "ACCEPTED" // silent update to an accepted event
              : "NEEDS-ACTION",
          rawIcs: parsed.calendar.ics,
        });
        needsReply = { uid: ev.uid };
      } else if (method === "CANCEL") {
        await upsertEvent(
          env,
          { ...ev, status: "CANCELLED" },
          { rawIcs: parsed.calendar.ics },
        );
      } else if (method === "REPLY") {
        // Someone replied to an invite WE sent: record their PARTSTAT.
        for (const a of ev.attendees) {
          if (a.partstat) await setAttendeePartstat(env, ev.uid, a.email, a.partstat);
        }
      } else if (method) {
        await upsertEvent(env, ev, { rawIcs: parsed.calendar.ics });
      }
    }
  }

  const emailId = await insertEmail(env, {
    direction: "in",
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html,
    raw: parsed.raw,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    hasCalendar: !!parsed.calendar,
    calendarMethod: method,
    eventUid,
  });

  if (eventUid) await linkEventSource(env, eventUid, emailId);

  // Auto-accept invites when enabled and it's a fresh invite.
  if (needsReply && env.AUTO_ACCEPT_INVITES === "true") {
    ctx.waitUntil(respondToInvite(env, needsReply.uid, "ACCEPTED", emailId));
  }
}

/** Send an iCal METHOD:REPLY to the organizer and record our response. */
export async function respondToInvite(
  env: Env,
  uid: string,
  partstat: "ACCEPTED" | "DECLINED" | "TENTATIVE",
  sourceEmailId?: string,
): Promise<{ sent: boolean; error?: string }> {
  const ev = await getEvent(env, uid);
  if (!ev || !ev.organizerEmail) return { sent: false, error: "no organizer" };

  // Thread the reply onto the original invite so Gmail correlates it.
  let inReplyTo: string | undefined;
  const srcId = sourceEmailId || ev.sourceEmailId;
  if (srcId) {
    const orig = await getEmail(env, srcId);
    inReplyTo = orig?.message_id || undefined;
  }

  const ics = buildReplyIcs(
    ev,
    { email: env.PRIMARY_ADDRESS, name: env.DISPLAY_NAME },
    partstat,
  );
  const verb =
    partstat === "ACCEPTED"
      ? "Accepted"
      : partstat === "DECLINED"
        ? "Declined"
        : "Tentative";

  let sent = true;
  let error: string | undefined;
  try {
    const messageId = await sendMail(env, {
      to: ev.organizerEmail,
      subject: `${verb}: ${ev.summary}`,
      text: `${env.DISPLAY_NAME} has ${verb.toLowerCase()} this invitation.`,
      ics: { data: ics, method: "REPLY", filename: "invite.ics" },
      inReplyTo,
      references: inReplyTo,
    });
    await insertEmail(env, {
      direction: "out",
      from: env.PRIMARY_ADDRESS,
      to: [ev.organizerEmail],
      subject: `${verb}: ${ev.summary}`,
      text: `${env.DISPLAY_NAME} has ${verb.toLowerCase()} this invitation.`,
      messageId,
      inReplyTo: inReplyTo || null,
      hasCalendar: true,
      calendarMethod: "REPLY",
      eventUid: uid,
    });
  } catch (e) {
    sent = false;
    error = String(e);
    console.error("respondToInvite send failed:", e);
  }

  // Record our answer regardless — the calendar state is ours.
  await setMyPartstat(env, uid, partstat);
  return { sent, error };
}
