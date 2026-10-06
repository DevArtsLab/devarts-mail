// D1 data access: emails + calendar_events + kv.

import type { CalEvent, Env, StoredEmail } from "./types";

// ---------------------------------------------------------------------------
// emails
// ---------------------------------------------------------------------------

export async function insertEmail(
  env: Env,
  e: {
    direction: "in" | "out";
    from: string;
    to: string[];
    cc?: string[];
    subject: string;
    text?: string;
    html?: string;
    raw?: string;
    messageId?: string | null;
    inReplyTo?: string | null;
    hasCalendar?: boolean;
    calendarMethod?: string | null;
    eventUid?: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO emails (id, direction, from_address, to_addresses, cc_addresses,
       subject, body_text, body_html, raw, message_id, in_reply_to,
       has_calendar, calendar_method, event_uid, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      e.direction,
      e.from,
      JSON.stringify(e.to),
      JSON.stringify(e.cc || []),
      e.subject,
      e.text || null,
      e.html || null,
      e.raw || null,
      e.messageId || null,
      e.inReplyTo || null,
      e.hasCalendar ? 1 : 0,
      e.calendarMethod || null,
      e.eventUid || null,
      Date.now(),
    )
    .run();
  return id;
}

export async function listEmails(
  env: Env,
  direction: "in" | "out",
  address?: string,
  limit = 100,
): Promise<StoredEmail[]> {
  const cols = `id, direction, from_address, to_addresses, cc_addresses, subject,
            has_calendar, calendar_method, event_uid, read, received_at,
            substr(COALESCE(body_text, ''), 1, 200) AS snippet`;
  if (address) {
    const like = `%"${address.toLowerCase()}"%`;
    // inbound: addressed to us (to/cc); outbound: sent from us.
    const where =
      direction === "in"
        ? `(to_addresses LIKE ? OR cc_addresses LIKE ?)`
        : `LOWER(from_address) = ?`;
    const binds =
      direction === "in" ? [like, like, limit] : [address.toLowerCase(), limit];
    const r = await env.DB.prepare(
      `SELECT ${cols} FROM emails WHERE direction = ? AND ${where}
       ORDER BY received_at DESC LIMIT ?`,
    )
      .bind(direction, ...binds)
      .all<StoredEmail>();
    return r.results || [];
  }
  const r = await env.DB.prepare(
    `SELECT ${cols} FROM emails WHERE direction = ? ORDER BY received_at DESC LIMIT ?`,
  )
    .bind(direction, limit)
    .all<StoredEmail>();
  return r.results || [];
}

export async function getEmail(env: Env, id: string): Promise<StoredEmail | null> {
  return env.DB.prepare(`SELECT * FROM emails WHERE id = ?`)
    .bind(id)
    .first<StoredEmail>();
}

export async function markEmailRead(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE emails SET read = 1 WHERE id = ?`).bind(id).run();
}

export async function deleteEmail(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM emails WHERE id = ?`).bind(id).run();
}

// ---------------------------------------------------------------------------
// calendar_events
// ---------------------------------------------------------------------------

interface EventRow {
  uid: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  dtstart: number;
  dtend: number;
  all_day: number;
  organizer_email: string | null;
  organizer_name: string | null;
  attendees: string;
  status: string;
  my_partstat: string | null;
  is_own: number;
  sequence: number;
  raw_ics: string | null;
  source_email_id: string | null;
  reminder_sent: number;
  updated_at: number;
  created_at: number;
}

export function rowToEvent(r: EventRow): CalEvent & {
  myPartstat: string | null;
  isOwn: boolean;
  sourceEmailId: string | null;
  reminderSent: boolean;
} {
  return {
    uid: r.uid,
    summary: r.summary || "",
    description: r.description || "",
    location: r.location || "",
    dtstart: r.dtstart,
    dtend: r.dtend,
    allDay: !!r.all_day,
    organizerEmail: r.organizer_email || undefined,
    organizerName: r.organizer_name || undefined,
    attendees: JSON.parse(r.attendees || "[]"),
    status: r.status,
    sequence: r.sequence,
    myPartstat: r.my_partstat,
    isOwn: !!r.is_own,
    sourceEmailId: r.source_email_id,
    reminderSent: !!r.reminder_sent,
  };
}

export async function upsertEvent(
  env: Env,
  e: CalEvent,
  opts: {
    myPartstat?: string | null;
    isOwn?: boolean;
    rawIcs?: string;
    sourceEmailId?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO calendar_events
       (uid, summary, description, location, dtstart, dtend, all_day,
        organizer_email, organizer_name, attendees, status, my_partstat,
        is_own, sequence, raw_ics, source_email_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET
        summary=excluded.summary, description=excluded.description,
        location=excluded.location, dtstart=excluded.dtstart, dtend=excluded.dtend,
        all_day=excluded.all_day, organizer_email=excluded.organizer_email,
        organizer_name=excluded.organizer_name, attendees=excluded.attendees,
        status=excluded.status, sequence=excluded.sequence,
        raw_ics=excluded.raw_ics, updated_at=excluded.updated_at,
        my_partstat = COALESCE(excluded.my_partstat, calendar_events.my_partstat),
        is_own = MAX(calendar_events.is_own, excluded.is_own),
        source_email_id = COALESCE(excluded.source_email_id, calendar_events.source_email_id)`,
  )
    .bind(
      e.uid,
      e.summary,
      e.description,
      e.location,
      e.dtstart,
      e.dtend,
      e.allDay ? 1 : 0,
      e.organizerEmail || null,
      e.organizerName || null,
      JSON.stringify(e.attendees),
      e.status,
      opts.myPartstat ?? null,
      opts.isOwn ? 1 : 0,
      e.sequence,
      opts.rawIcs || null,
      opts.sourceEmailId || null,
      Date.now(),
    )
    .run();
}

export async function listEvents(env: Env, startMs: number, endMs: number) {
  const r = await env.DB.prepare(
    `SELECT * FROM calendar_events
     WHERE dtstart < ? AND dtend > ?
     ORDER BY dtstart ASC`,
  )
    .bind(endMs, startMs)
    .all<EventRow>();
  return (r.results || []).map(rowToEvent);
}

export async function listAllEvents(env: Env) {
  const r = await env.DB.prepare(
    `SELECT * FROM calendar_events ORDER BY dtstart ASC`,
  ).all<EventRow>();
  return (r.results || []).map(rowToEvent);
}

export async function getEvent(env: Env, uid: string) {
  const r = await env.DB.prepare(`SELECT * FROM calendar_events WHERE uid = ?`)
    .bind(uid)
    .first<EventRow>();
  return r ? rowToEvent(r) : null;
}

export async function deleteEventRow(env: Env, uid: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM calendar_events WHERE uid = ?`).bind(uid).run();
}

export async function setMyPartstat(
  env: Env,
  uid: string,
  partstat: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE calendar_events SET my_partstat = ?, updated_at = ? WHERE uid = ?`,
  )
    .bind(partstat, Date.now(), uid)
    .run();
}

export async function setAttendeePartstat(
  env: Env,
  uid: string,
  email: string,
  partstat: string,
): Promise<void> {
  const ev = await getEvent(env, uid);
  if (!ev) return;
  const attendees = ev.attendees.map((a) =>
    a.email.toLowerCase() === email.toLowerCase() ? { ...a, partstat } : a,
  );
  await env.DB.prepare(
    `UPDATE calendar_events SET attendees = ?, updated_at = ? WHERE uid = ?`,
  )
    .bind(JSON.stringify(attendees), Date.now(), uid)
    .run();
}

/** Events starting within the reminder window that haven't been reminded. */
export async function eventsNeedingReminder(env: Env, nowMs: number, windowMs: number) {
  const r = await env.DB.prepare(
    `SELECT * FROM calendar_events
     WHERE reminder_sent = 0 AND status != 'CANCELLED'
       AND dtstart > ? AND dtstart <= ?
       AND (my_partstat IS NULL OR my_partstat IN ('ACCEPTED','TENTATIVE'))`,
  )
    .bind(nowMs, nowMs + windowMs)
    .all<EventRow>();
  return (r.results || []).map(rowToEvent);
}

export async function linkEventSource(
  env: Env,
  uid: string,
  emailId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE calendar_events SET source_email_id = ? WHERE uid = ? AND source_email_id IS NULL`,
  )
    .bind(emailId, uid)
    .run();
}

export async function markReminderSent(env: Env, uid: string): Promise<void> {
  await env.DB.prepare(`UPDATE calendar_events SET reminder_sent = 1 WHERE uid = ?`)
    .bind(uid)
    .run();
}

// ---------------------------------------------------------------------------
// kv
// ---------------------------------------------------------------------------

export async function kvGet(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT value FROM kv WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return r?.value ?? null;
}

export async function kvSet(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, value)
    .run();
}
