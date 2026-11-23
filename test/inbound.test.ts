import { describe, it, expect } from "vitest";
import { handleInbound, applyCalendarUpdate } from "../src/inbound";
import { upsertEvent } from "../src/db";
import type { CalEvent, Env } from "../src/types";

// --- in-memory D1 stub -------------------------------------------------

interface Row {
  [k: string]: unknown;
}

function fakeD1() {
  const events = new Map<string, Row>();
  const emails = new Map<string, Row>();
  const kv = new Map<string, string>();

  const exec = (sql: string, binds: unknown[]) => {
    if (sql.startsWith("INSERT INTO calendar_events")) {
      const [
        uid, summary, description, location, dtstart, dtend, all_day,
        organizer_email, organizer_name, attendees, status, my_partstat,
        is_own, sequence, raw_ics, source_email_id, updated_at,
      ] = binds as [string, ...unknown[]];
      const ex = events.get(uid);
      if (ex) {
        Object.assign(ex, {
          summary, description, location, dtstart, dtend, all_day,
          organizer_email, organizer_name, attendees, status, sequence,
          raw_ics, updated_at,
          my_partstat: my_partstat ?? ex.my_partstat,
          is_own: Math.max(ex.is_own as number, is_own as number),
          source_email_id: source_email_id ?? ex.source_email_id,
        });
      } else {
        events.set(uid, {
          uid, summary, description, location, dtstart, dtend, all_day,
          organizer_email, organizer_name, attendees, status, my_partstat,
          is_own, sequence, raw_ics, source_email_id, updated_at,
          reminder_sent: 0, created_at: updated_at,
        });
      }
      return;
    }
    if (sql.startsWith("INSERT INTO emails")) {
      const [id] = binds as [string];
      emails.set(id, {
        id, direction: binds[1], from_address: binds[2],
        to_addresses: binds[3], cc_addresses: binds[4], subject: binds[5],
        body_text: binds[6], body_html: binds[7], raw: binds[8],
        message_id: binds[9], in_reply_to: binds[10],
        has_calendar: binds[11], calendar_method: binds[12],
        event_uid: binds[13], read: 0, received_at: binds[14],
      });
      return;
    }
    if (sql.startsWith("UPDATE calendar_events SET attendees")) {
      const ex = events.get(binds[2] as string);
      if (ex) {
        ex.attendees = binds[0];
        ex.updated_at = binds[1];
      }
      return;
    }
    if (sql.startsWith("UPDATE calendar_events SET my_partstat")) {
      const ex = events.get(binds[2] as string);
      if (ex) {
        ex.my_partstat = binds[0];
        ex.updated_at = binds[1];
      }
      return;
    }
    if (sql.startsWith("UPDATE calendar_events SET source_email_id")) {
      const ex = events.get(binds[1] as string);
      if (ex && ex.source_email_id == null) ex.source_email_id = binds[0];
      return;
    }
    if (sql.startsWith("UPDATE calendar_events SET reminder_sent")) {
      const ex = events.get(binds[1] as string);
      if (ex) ex.reminder_sent = binds[0];
      return;
    }
    if (sql.startsWith("DELETE FROM calendar_events")) {
      events.delete(binds[0] as string);
      return;
    }
    if (sql.startsWith("INSERT INTO kv")) {
      kv.set(binds[0] as string, binds[1] as string);
      return;
    }
    if (sql.startsWith("UPDATE emails SET read")) {
      const ex = emails.get(binds[1] as string);
      if (ex) ex.read = binds[0];
      return;
    }
    if (sql.startsWith("DELETE FROM emails")) {
      emails.delete(binds[0] as string);
      return;
    }
    throw new Error(`fakeD1: unhandled SQL ${sql}`);
  };

  const query = (sql: string, binds: unknown[]): Row[] => {
    if (sql.startsWith("SELECT * FROM calendar_events WHERE uid"))
      return events.has(binds[0] as string) ? [events.get(binds[0] as string)!] : [];
    if (sql.startsWith("SELECT * FROM emails WHERE id"))
      return emails.has(binds[0] as string) ? [emails.get(binds[0] as string)!] : [];
    if (sql.startsWith("SELECT * FROM calendar_events"))
      return [...events.values()];
    if (sql.startsWith("SELECT value FROM kv"))
      return kv.has(binds[0] as string)
        ? [{ value: kv.get(binds[0] as string)! }]
        : [];
    if (sql.startsWith("SELECT * FROM emails"))
      return [...emails.values()];
    throw new Error(`fakeD1: unhandled SQL ${sql}`);
  };

  const prepare = (sql: string) => {
    const norm = sql.replace(/\s+/g, " ").trim();
    const binds: unknown[] = [];
    const stmt = {
      bind(...b: unknown[]) {
        binds.push(...b);
        return stmt;
      },
      async run() {
        exec(norm, binds);
        return { success: true };
      },
      async first<T>() {
        return (query(norm, binds)[0] ?? null) as T;
      },
      async all<T>() {
        return { results: query(norm, binds) as T[] };
      },
    };
    return stmt;
  };

  return { events, emails, db: { prepare } as unknown as D1Database };
}

// --- helpers -----------------------------------------------------------

const ICS = (uid: string, method: string, extra = "") =>
  `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//test//EN\r
METHOD:${method}\r
BEGIN:VEVENT\r
UID:${uid}\r
DTSTAMP:20261101T120000Z\r
DTSTART:20261201T170000Z\r
DTEND:20261201T180000Z\r
${extra}END:VEVENT\r
END:VCALENDAR\r
`;

const mimeEmail = (opts: {
  from: string;
  to?: string;
  ics?: string;
  method?: string;
  plainBodyWithIcs?: string;
}) => {
  const { from, to = "amir@devartslab.com", ics, method, plainBodyWithIcs } = opts;
  let text: string;
  if (ics) {
    text = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: invite`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="b"`,
      ``,
      `--b`,
      `Content-Type: text/plain`,
      ``,
      `body`,
      `--b`,
      `Content-Type: text/calendar; method=${method || "REQUEST"}`,
      `Content-Disposition: attachment; filename="invite.ics"`,
      ``,
      ics,
      `--b--`,
      ``,
    ].join("\r\n");
  } else {
    text = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: hi`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain`,
      ``,
      plainBodyWithIcs || "hello",
      ``,
    ].join("\r\n");
  }
  const raw = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return { raw, from } as unknown as ForwardableEmailMessage;
};

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const makeEnv = () => {
  const { events, emails, db } = fakeD1();
  const env = {
    DB: db,
    EMAIL: { send: async () => {} },
    MAIL_DOMAIN: "devartslab.com",
    PRIMARY_ADDRESS: "amir@devartslab.com",
    DISPLAY_NAME: "Amir",
    EXTRA_IDENTITIES: "secret@devartslab.com=Secret Alias",
    CALENDAR_NAME: "Cal",
    CALENDAR_TZ: "UTC",
    AUTO_ACCEPT_INVITES: "false",
    INVITE_REMINDER_MINUTES: "0",
    SESSION_TTL_HOURS: "24",
    UI_PASSWORD: "x",
    SESSION_SECRET: "y",
  } as unknown as Env;
  return { env, events, emails };
};

const baseEvent = (uid: string, organizer: string): CalEvent => ({
  uid,
  summary: "Original",
  description: "",
  location: "",
  dtstart: Date.UTC(2026, 11, 1, 17),
  dtend: Date.UTC(2026, 11, 1, 18),
  allDay: false,
  organizerEmail: organizer,
  attendees: [],
  status: "CONFIRMED",
  sequence: 0,
});

// --- tests --------------------------------------------------------------

describe("applyCalendarUpdate", () => {
  it("rejects a REQUEST on an own event, even from the 'organizer' field", async () => {
    const { env } = makeEnv();
    await upsertEvent(env, baseEvent("u1", "amir@devartslab.com"), {
      isOwn: true,
    });
    const forged = {
      ...baseEvent("u1", "mallory@evil.com"),
      summary: "Hijacked",
      attendees: [{ email: "mallory@evil.com" }],
    };
    const r = await applyCalendarUpdate(
      env,
      "mallory@evil.com",
      "REQUEST",
      forged,
      "",
    );
    expect(r.applied).toBe(false);
    const { getEvent } = await import("../src/db");
    const stored = await getEvent(env, "u1");
    expect(stored?.summary).toBe("Original");
    expect(stored?.organizerEmail).toBe("amir@devartslab.com");
    expect(stored?.attendees).toEqual([]);
  });

  it("rejects a CANCEL on an own event", async () => {
    const { env } = makeEnv();
    await upsertEvent(env, baseEvent("u2", "amir@devartslab.com"), {
      isOwn: true,
    });
    const r = await applyCalendarUpdate(
      env,
      "mallory@evil.com",
      "CANCEL",
      baseEvent("u2", "mallory@evil.com"),
      "",
    );
    expect(r.applied).toBe(false);
    const { getEvent } = await import("../src/db");
    expect((await getEvent(env, "u2"))?.status).toBe("CONFIRMED");
  });

  it("rejects a REQUEST on a stored invite from a non-organizer sender", async () => {
    const { env } = makeEnv();
    await upsertEvent(env, baseEvent("u3", "jane@example.com"), {});
    const r = await applyCalendarUpdate(
      env,
      "mallory@evil.com",
      "REQUEST",
      { ...baseEvent("u3", "mallory@evil.com"), summary: "Hijacked" },
      "",
    );
    expect(r.applied).toBe(false);
    const { getEvent } = await import("../src/db");
    const stored = await getEvent(env, "u3");
    expect(stored?.summary).toBe("Original");
    expect(stored?.organizerEmail).toBe("jane@example.com");
  });

  it("applies a REQUEST update from the stored organizer", async () => {
    const { env } = makeEnv();
    await upsertEvent(env, baseEvent("u4", "jane@example.com"), {});
    const r = await applyCalendarUpdate(
      env,
      "jane@example.com",
      "REQUEST",
      { ...baseEvent("u4", "jane@example.com"), summary: "Moved", sequence: 1 },
      "",
    );
    expect(r.applied).toBe(true);
    expect(r.needsReply).toBe(true);
    const { getEvent } = await import("../src/db");
    expect((await getEvent(env, "u4"))?.summary).toBe("Moved");
  });

  it("applies a CANCEL from the stored organizer", async () => {
    const { env } = makeEnv();
    await upsertEvent(env, baseEvent("u5", "jane@example.com"), {});
    const r = await applyCalendarUpdate(
      env,
      "jane@example.com",
      "CANCEL",
      baseEvent("u5", "jane@example.com"),
      "",
    );
    expect(r.applied).toBe(true);
    const { getEvent } = await import("../src/db");
    expect((await getEvent(env, "u5"))?.status).toBe("CANCELLED");
  });

  it("REPLY updates only the sender's own PARTSTAT, only on own events", async () => {
    const { env } = makeEnv();
    const own = {
      ...baseEvent("u6", "amir@devartslab.com"),
      attendees: [
        { email: "bob@example.com", partstat: "NEEDS-ACTION" },
        { email: "carol@example.com", partstat: "NEEDS-ACTION" },
      ],
    };
    await upsertEvent(env, own, { isOwn: true });

    // Carol replies: only her row changes.
    let r = await applyCalendarUpdate(
      env,
      "carol@example.com",
      "REPLY",
      { ...own, attendees: [{ email: "carol@example.com", partstat: "DECLINED" }] },
      "",
    );
    expect(r.applied).toBe(true);
    const { getEvent } = await import("../src/db");
    let stored = (await getEvent(env, "u6"))!;
    expect(stored.attendees.find((a) => a.email === "carol@example.com")?.partstat).toBe("DECLINED");
    expect(stored.attendees.find((a) => a.email === "bob@example.com")?.partstat).toBe("NEEDS-ACTION");

    // Mallory can't set Bob's status: she only matches herself.
    r = await applyCalendarUpdate(
      env,
      "mallory@evil.com",
      "REPLY",
      { ...own, attendees: [{ email: "bob@example.com", partstat: "DECLINED" }] },
      "",
    );
    expect(r.applied).toBe(false);
    stored = (await getEvent(env, "u6"))!;
    expect(stored.attendees.find((a) => a.email === "bob@example.com")?.partstat).toBe("NEEDS-ACTION");

    // And REPLY does nothing at all on events we didn't send.
    const inbound = {
      ...baseEvent("u7", "jane@example.com"),
      attendees: [{ email: "amir@devartslab.com", partstat: "NEEDS-ACTION" }],
    };
    await upsertEvent(env, inbound, {});
    r = await applyCalendarUpdate(
      env,
      "mallory@evil.com",
      "REPLY",
      { ...inbound, attendees: [{ email: "amir@devartslab.com", partstat: "DECLINED" }] },
      "",
    );
    expect(r.applied).toBe(false);
    stored = (await getEvent(env, "u7"))!;
    expect(stored.attendees[0].partstat).toBe("NEEDS-ACTION");
  });
});

describe("handleInbound", () => {
  it("stores a fresh REQUEST and leaves an own event untouched by a spoofed one", async () => {
    const { env, events } = makeEnv();
    await upsertEvent(env, baseEvent("own-uid", "amir@devartslab.com"), {
      isOwn: true,
    });

    // Attacker reuses the UID in a REQUEST naming themselves organizer.
    const msg = mimeEmail({
      from: "mallory@evil.com",
      ics: ICS(
        "own-uid",
        "REQUEST",
        "ORGANIZER:mailto:mallory@evil.com\r\nSUMMARY:Hijacked\r\n",
      ),
      method: "REQUEST",
    });
    await handleInbound(msg, env, ctx);
    const row = events.get("own-uid")!;
    expect(row.summary).toBe("Original");
    expect(row.organizer_email).toBe("amir@devartslab.com");

    // A brand-new UID from the same sender still lands as a normal invite.
    const msg2 = mimeEmail({
      from: "mallory@evil.com",
      ics: ICS(
        "new-uid",
        "REQUEST",
        "ORGANIZER:mailto:mallory@evil.com\r\nSUMMARY:Legit invite\r\n",
      ),
      method: "REQUEST",
    });
    await handleInbound(msg2, env, ctx);
    expect(events.get("new-uid")?.summary).toBe("Legit invite");
  });

  it("ignores a VCALENDAR block pasted into a plain-text body", async () => {
    const { env, events } = makeEnv();
    const msg = mimeEmail({
      from: "mallory@evil.com",
      plainBodyWithIcs: `see below\r\n${ICS(
        "body-uid",
        "REQUEST",
        "ORGANIZER:mailto:mallory@evil.com\r\nSUMMARY:Inline\r\n",
      )}`,
    });
    await handleInbound(msg, env, ctx);
    expect(events.has("body-uid")).toBe(false);
  });
});
