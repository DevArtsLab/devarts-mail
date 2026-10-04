// REST API consumed by the built-in UI (public/).

import type { Env, CalEvent, RsvpStatus } from "./types";
import * as db from "./db";
import { sendMail } from "./mail";
import { respondToInvite } from "./inbound";
import {
  signSession,
  verifySession,
  sessionCookie,
  clearCookie,
  safeEqual,
} from "./auth";
import { buildInviteIcs, buildCancelIcs, buildExportIcs, newUid } from "./ical";
import { findIdentity, listIdentities, primaryIdentity } from "./identities";

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

const err = (msg: string, status = 400) => json({ error: msg }, { status });

async function requireAuth(env: Env, req: Request): Promise<Response | null> {
  if (await verifySession(env, req)) return null;
  return err("unauthorized", 401);
}

export async function handleApi(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method;

  // ---- public endpoints ----
  if (path === "/api/login" && method === "POST") {
    const { password } = await req
      .json<{ password?: string }>()
      .catch(() => ({}) as any);
    if (!password || !safeEqual(password, env.UI_PASSWORD || ""))
      return err("invalid password", 401);
    const token = await signSession(env);
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(token) } });
  }
  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, { headers: { "Set-Cookie": clearCookie() } });
  }
  if (path === "/api/session") {
    return json({ authed: await verifySession(env, req) });
  }

  // ---- everything below requires auth ----
  const authErr = await requireAuth(env, req);
  if (authErr) return authErr;

  if (path === "/api/config") {
    return json({
      primaryAddress: env.PRIMARY_ADDRESS,
      displayName: env.DISPLAY_NAME,
      calendarName: env.CALENDAR_NAME,
      autoAccept: env.AUTO_ACCEPT_INVITES === "true",
      identities: listIdentities(env),
    });
  }

  // ---- emails ----
  if (path === "/api/emails" && method === "GET") {
    const box = url.searchParams.get("box") === "out" ? "out" : "in";
    const address = url.searchParams.get("address") || undefined;
    return json({ emails: await db.listEmails(env, box, address) });
  }

  const emailMatch = path.match(/^\/api\/emails\/([0-9a-f-]{36})(\/read|\/rsvp)?$/);
  if (emailMatch) {
    const [, id, action] = emailMatch;
    const email = await db.getEmail(env, id);
    if (!email) return err("not found", 404);

    if (!action && method === "GET") {
      if (!email.read) await db.markEmailRead(env, id);
      return json({ email });
    }
    if (!action && method === "DELETE") {
      await db.deleteEmail(env, id);
      return json({ ok: true });
    }
    if (action === "/read" && method === "POST") {
      await db.markEmailRead(env, id);
      return json({ ok: true });
    }
    if (action === "/rsvp" && method === "POST") {
      if (!email.event_uid) return err("email has no invite");
      const { status } = await req.json<{ status: RsvpStatus }>();
      if (!["ACCEPTED", "DECLINED", "TENTATIVE"].includes(status))
        return err("bad status");
      const result = await respondToInvite(env, email.event_uid, status, email.id);
      const ev = await db.getEvent(env, email.event_uid);
      return json({ ok: true, sent: result.sent, sendError: result.error, event: ev });
    }
  }

  // ---- send mail ----
  if (path === "/api/send" && method === "POST") {
    const body = await req.json<{
      to: string;
      subject: string;
      text?: string;
      html?: string;
      from?: string;
      inReplyTo?: string;
    }>();
    if (!body.to || !body.subject) return err("to and subject required");
    const identity = body.from ? findIdentity(env, body.from) : primaryIdentity(env);
    if (!identity) return err("unknown sender address");
    const toList = body.to
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const messageId = await sendMail(env, {
      from: identity,
      to: toList,
      subject: body.subject,
      text: body.text,
      html: body.html,
      inReplyTo: body.inReplyTo,
      references: body.inReplyTo,
    });
    await db.insertEmail(env, {
      direction: "out",
      from: identity.address,
      to: toList,
      subject: body.subject,
      text: body.text,
      html: body.html,
      messageId,
      inReplyTo: body.inReplyTo,
    });
    return json({ ok: true, messageId });
  }

  // ---- calendar ----
  if (path === "/api/events" && method === "GET") {
    const start = parseInt(url.searchParams.get("start") || "0", 10);
    const end = parseInt(url.searchParams.get("end") || "0", 10);
    const events =
      start && end ? await db.listEvents(env, start, end) : await db.listAllEvents(env);
    return json({ events });
  }

  if (path === "/api/events" && method === "POST") {
    const b = await req.json<
      Partial<CalEvent> & { sendInvites?: boolean; organizer?: string }
    >();
    if (!b.summary || !b.dtstart || !b.dtend)
      return err("summary, dtstart, dtend required");
    const organizer = b.organizer
      ? findIdentity(env, b.organizer)
      : primaryIdentity(env);
    if (!organizer) return err("unknown organizer address");
    const ev: CalEvent = {
      uid: newUid(env.MAIL_DOMAIN),
      summary: b.summary,
      description: b.description || "",
      location: b.location || "",
      dtstart: b.dtstart,
      dtend: b.dtend,
      allDay: !!b.allDay,
      organizerEmail: organizer.address,
      organizerName: organizer.name,
      attendees: (b.attendees || []).map((a) => ({
        ...a,
        partstat: "NEEDS-ACTION",
        rsvp: "TRUE",
      })),
      status: "CONFIRMED",
      sequence: 0,
    };
    await db.upsertEvent(env, ev, { isOwn: true });
    if (b.sendInvites && ev.attendees.length) {
      await sendInviteEmails(env, ev);
    }
    return json({ ok: true, event: ev });
  }

  const evMatch = path.match(/^\/api\/events\/([^/]+)(\/ics|\/rsvp)?$/);
  if (evMatch) {
    const [, rawUid, action] = evMatch;
    const uid = decodeURIComponent(rawUid);
    const existing = await db.getEvent(env, uid);
    if (!existing) return err("not found", 404);

    if (action === "/ics" && method === "GET") {
      const ics = buildExportIcs([existing], env.CALENDAR_NAME);
      return new Response(ics, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": `attachment; filename="event.ics"`,
        },
      });
    }

    if (action === "/rsvp" && method === "POST") {
      const { status } = await req.json<{ status: RsvpStatus }>();
      if (!["ACCEPTED", "DECLINED", "TENTATIVE"].includes(status))
        return err("bad status");
      const result = await respondToInvite(env, uid, status);
      return json({ ok: true, sent: result.sent, sendError: result.error });
    }

    if (!action && method === "PUT") {
      const b = await req.json<Partial<CalEvent> & { sendUpdates?: boolean }>();
      const updated: CalEvent = {
        ...existing,
        summary: b.summary ?? existing.summary,
        description: b.description ?? existing.description,
        location: b.location ?? existing.location,
        dtstart: b.dtstart ?? existing.dtstart,
        dtend: b.dtend ?? existing.dtend,
        allDay: b.allDay ?? existing.allDay,
        attendees: b.attendees ?? existing.attendees,
        sequence: existing.sequence + 1,
      };
      await db.upsertEvent(env, updated, { isOwn: existing.isOwn });
      if (b.sendUpdates && existing.isOwn && updated.attendees.length) {
        await sendInviteEmails(env, updated);
      }
      return json({ ok: true, event: updated });
    }

    if (!action && method === "DELETE") {
      const notify = url.searchParams.get("notify") === "1";
      if (notify && existing.isOwn && existing.attendees.length) {
        await sendCancelEmails(env, existing);
      }
      await db.deleteEventRow(env, uid);
      return json({ ok: true });
    }
  }

  // full calendar export
  if (path === "/api/calendar.ics" && method === "GET") {
    const events = await db.listAllEvents(env);
    return new Response(buildExportIcs(events, env.CALENDAR_NAME), {
      headers: { "Content-Type": "text/calendar; charset=utf-8" },
    });
  }

  return err("not found", 404);
}

async function sendInviteEmails(env: Env, ev: CalEvent): Promise<void> {
  const ics = buildInviteIcs(ev);
  const sender = findIdentity(env, ev.organizerEmail) || primaryIdentity(env);
  for (const a of ev.attendees) {
    await sendMail(env, {
      from: sender,
      to: a.email,
      subject: `Invitation: ${ev.summary}`,
      text: `${sender.name} invited you to "${ev.summary}".`,
      ics: { data: ics, method: "REQUEST" },
    });
  }
}

async function sendCancelEmails(env: Env, ev: CalEvent): Promise<void> {
  const ics = buildCancelIcs(ev);
  const sender = findIdentity(env, ev.organizerEmail) || primaryIdentity(env);
  for (const a of ev.attendees) {
    await sendMail(env, {
      from: sender,
      to: a.email,
      subject: `Cancelled: ${ev.summary}`,
      text: `"${ev.summary}" has been cancelled.`,
      ics: { data: ics, method: "CANCEL" },
    });
  }
}
