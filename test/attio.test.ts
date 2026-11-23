import { describe, it, expect, vi } from "vitest";
import {
  externalAddresses,
  buildEmailNote,
  buildMeetingBody,
  syncPendingDeletes,
  FREEMAIL_DOMAINS,
} from "../src/attio";
import type { Env, StoredEmail, CalEvent } from "../src/types";

const env = {
  MAIL_DOMAIN: "devartslab.com",
  PRIMARY_ADDRESS: "amir@devartslab.com",
  DISPLAY_NAME: "Amir | DevArts Lab",
  EXTRA_IDENTITIES: "sales@devartslab.com=Sales",
  ATTIO_IGNORE_ADDRESSES: "personal@example.com",
  CALENDAR_TZ: "America/New_York",
} as unknown as Env;

const mail = (over: Partial<StoredEmail>): StoredEmail => ({
  id: "e1",
  direction: "in",
  from_address: "me@acme.com",
  to_addresses: '["amir@devartslab.com"]',
  cc_addresses: "[]",
  subject: "Hello",
  body_text: "hi there",
  body_html: null,
  raw: null,
  message_id: "<m1@acme.com>",
  in_reply_to: null,
  has_calendar: 0,
  calendar_method: null,
  event_uid: null,
  read: 0,
  received_at: 1730000000000,
  ...over,
});

describe("externalAddresses", () => {
  it("keeps only non-self participants", () => {
    const e = mail({
      to_addresses: '["amir@devartslab.com","me@acme.com"]',
      cc_addresses: '["sales@devartslab.com","bob@corp.io","personal@example.com"]',
    });
    expect(externalAddresses(env, e)).toEqual(["me@acme.com", "bob@corp.io"]);
  });

  it("drops addresses on our own domain", () => {
    const e = mail({ from_address: "x@devartslab.com", to_addresses: '["a@b.co"]' });
    expect(externalAddresses(env, e)).toEqual(["a@b.co"]);
  });

  it("dedupes participants", () => {
    const e = mail({
      to_addresses: '["me@acme.com"]',
      cc_addresses: '["me@acme.com"]',
    });
    expect(externalAddresses(env, e)).toEqual(["me@acme.com"]);
  });
});

describe("buildEmailNote", () => {
  it("formats headers and body", () => {
    const { title, content } = buildEmailNote(env, mail({}));
    expect(title).toBe("Email in: Hello");
    expect(content).toContain("From: me@acme.com");
    expect(content).toContain("To: amir@devartslab.com");
    expect(content).toContain("hi there");
  });

  it("truncates long bodies", () => {
    const { content } = buildEmailNote(env, mail({ body_text: "x".repeat(9000) }));
    expect(content).toContain("[truncated]");
    expect(content.length).toBeLessThan(4500);
  });
});

describe("buildMeetingBody", () => {
  const ev = (over: Partial<CalEvent>): CalEvent => ({
    uid: "u1",
    summary: "Kickoff",
    description: "discuss roadmap",
    location: "Zoom",
    dtstart: Date.UTC(2026, 10, 15, 17, 0, 0),
    dtend: Date.UTC(2026, 10, 15, 18, 0, 0),
    allDay: false,
    organizerEmail: "me@acme.com",
    organizerName: "Me",
    attendees: [
      { email: "amir@devartslab.com", partstat: "ACCEPTED" },
      { email: "bob@corp.io", partstat: "NEEDS-ACTION" },
    ],
    status: "CONFIRMED",
    sequence: 0,
    ...over,
  });

  it("maps organizer and attendee statuses", () => {
    const b = buildMeetingBody(env, ev({}));
    expect(b.title).toBe("Kickoff");
    expect(b.is_all_day).toBe(false);
    expect(b.participants[0]).toMatchObject({
      email_address: "me@acme.com",
      is_organizer: true,
      status: "accepted",
    });
    expect(b.participants[1].status).toBe("accepted");
    expect(b.participants[2].status).toBe("pending");
  });

  it("falls back to self when there are no participants", () => {
    const b = buildMeetingBody(env, ev({ organizerEmail: undefined, attendees: [] }));
    expect(b.participants).toHaveLength(1);
    expect(b.participants[0].email_address).toBe("amir@devartslab.com");
  });

  it("keeps location/status/UID when notes exceed the length budget", () => {
    const b = buildMeetingBody(
      env,
      ev({ description: "x".repeat(20000), location: "Room 4" }),
    );
    expect(b.description.length).toBeLessThanOrEqual(9000);
    expect(b.description).toContain("Location: Room 4");
    expect(b.description).toContain("Status: CONFIRMED");
    expect(b.description).toContain("UID: u1");
    expect(b.description).toContain("[truncated]");
  });

  it("preserves all notes when notes plus metadata fit exactly", () => {
    // meta = "Location: Room 4\nStatus: CONFIRMED\nUID: u1" = 42 chars,
    // plus one joining newline => notes budget is 8957.
    const b = buildMeetingBody(
      env,
      ev({ description: "y".repeat(8957), location: "Room 4" }),
    );
    expect(b.description).not.toContain("[truncated]");
    expect(b.description).toContain("y".repeat(8957));
    expect(b.description).toContain("Location: Room 4");
  });

  it("applies RSVP only to the identity that answered", () => {
    const b = buildMeetingBody(
      env,
      ev({
        attendees: [
          { email: "amir@devartslab.com", partstat: "NEEDS-ACTION" },
          { email: "sales@devartslab.com", partstat: "NEEDS-ACTION" },
          { email: "bob@corp.io", partstat: "NEEDS-ACTION" },
        ],
        myPartstat: "DECLINED",
        myRsvpAddr: "amir@devartslab.com",
      } as Partial<CalEvent>),
    );
    const byEmail = Object.fromEntries(
      b.participants.map((p) => [p.email_address, p.status]),
    );
    expect(byEmail["amir@devartslab.com"]).toBe("declined");
    // The other mailbox identity keeps its original ICS status.
    expect(byEmail["sales@devartslab.com"]).toBe("pending");
    expect(byEmail["bob@corp.io"]).toBe("pending");
  });

  it("uses exclusive date end for all-day events", () => {
    const start = Date.UTC(2026, 10, 15);
    const b = buildMeetingBody(env, ev({ allDay: true, dtstart: start, dtend: start }));
    expect(b.start).toEqual({ date: "2026-11-15" });
    expect(b.end).toEqual({ date: "2026-11-16" });
  });
});

describe("syncPendingDeletes", () => {
  function mockEnv(queueRows: unknown[], runs: string[]) {
    return {
      ATTIO_SYNC_ENABLED: "true",
      ATTIO_ACCESS_TOKEN: "tok",
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: unknown[]) => ({
            all: async () => ({
              results: sql.includes("FROM attio_deletion_queue") ? queueRows : [],
            }),
            run: async () => {
              runs.push(sql);
              return { success: true };
            },
            first: async () => null,
          }),
        }),
      },
    } as unknown as Env;
  }

  it("clears a queued note deletion when Attio already deleted it (404)", async () => {
    const runs: string[] = [];
    const env = mockEnv(
      [{ id: 1, kind: "note", remote_id: "note-1", attempts: 0 }],
      runs,
    );
    const fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await syncPendingDeletes(env);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.attio.com/v2/notes/note-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(runs.some((s) => s.includes("DELETE FROM attio_deletion_queue"))).toBe(true);
  });

  it("keeps the queue row and defers when Attio rejects the delete", async () => {
    const runs: string[] = [];
    const env = mockEnv(
      [{ id: 2, kind: "meeting", remote_id: "mtg-1", attempts: 0 }],
      runs,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    try {
      await syncPendingDeletes(env);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(runs.some((s) => s.includes("UPDATE attio_deletion_queue"))).toBe(true);
    expect(runs.some((s) => s.includes("DELETE FROM attio_deletion_queue"))).toBe(
      false,
    );
  });
});

describe("FREEMAIL_DOMAINS", () => {
  it("covers common consumer mailboxes", () => {
    for (const d of ["gmail.com", "outlook.com", "icloud.com", "proton.me"]) {
      expect(FREEMAIL_DOMAINS.has(d)).toBe(true);
    }
    expect(FREEMAIL_DOMAINS.has("perscholas.org")).toBe(false);
  });
});
