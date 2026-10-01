import { describe, it, expect } from "vitest";
import {
  parseIcs,
  buildReplyIcs,
  buildInviteIcs,
  parseIcalDate,
  formatIcalDate,
  newUid,
} from "../src/ical";

const GOOGLE_REQUEST = `BEGIN:VCALENDAR\r
PRODID:-//Google Inc//Google Calendar 70.9054//EN\r
VERSION:2.0\r
CALSCALE:GREGORIAN\r
METHOD:REQUEST\r
BEGIN:VEVENT\r
DTSTART:20261015T170000Z\r
DTEND:20261015T180000Z\r
DTSTAMP:20261001T120000Z\r
ORGANIZER;CN=Jane Doe:mailto:jane@example.com\r
UID:abc123@google.com\r
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=\r
 TRUE;CN=Amir;X-NUM-GUESTS=0:mailto:amir@devartslab.com\r
SUMMARY:Project kickoff\r
LOCATION:Zoom\r
DESCRIPTION:Line one\\nLine two\r
SEQUENCE:0\r
STATUS:CONFIRMED\r
END:VEVENT\r
END:VCALENDAR\r
`;

describe("parseIcs", () => {
  it("parses a Google Calendar REQUEST", () => {
    const cal = parseIcs(GOOGLE_REQUEST);
    expect(cal.method).toBe("REQUEST");
    expect(cal.events).toHaveLength(1);
    const ev = cal.events[0];
    expect(ev.uid).toBe("abc123@google.com");
    expect(ev.summary).toBe("Project kickoff");
    expect(ev.organizerEmail).toBe("jane@example.com");
    expect(ev.attendees[0].email).toBe("amir@devartslab.com");
    expect(ev.dtstart).toBe(Date.UTC(2026, 9, 15, 17, 0, 0));
    expect(ev.description).toBe("Line one\nLine two");
  });
});

describe("buildReplyIcs", () => {
  it("emits METHOD:REPLY with our PARTSTAT", () => {
    const cal = parseIcs(GOOGLE_REQUEST);
    const ics = buildReplyIcs(
      cal.events[0],
      { email: "amir@devartslab.com", name: "Amir" },
      "ACCEPTED",
    );
    const flat = ics.replace(/\r\n[ \t]/g, ""); // unfold
    expect(flat).toContain("METHOD:REPLY");
    expect(flat).toContain("UID:abc123@google.com");
    expect(flat).toMatch(
      /ATTENDEE;[^:]*PARTSTAT=ACCEPTED[^:]*:mailto:amir@devartslab\.com/,
    );
    expect(ics).toContain("ORGANIZER");
    // round-trips
    const back = parseIcs(ics);
    expect(back.method).toBe("REPLY");
    expect(back.events[0].attendees[0].partstat).toBe("ACCEPTED");
  });
});

describe("buildInviteIcs", () => {
  it("round-trips an invite we create", () => {
    const ev = {
      uid: newUid("devartslab.com"),
      summary: "Demo",
      description: "",
      location: "",
      dtstart: Date.UTC(2026, 9, 20, 16),
      dtend: Date.UTC(2026, 9, 20, 17),
      allDay: false,
      organizerEmail: "amir@devartslab.com",
      organizerName: "Amir",
      attendees: [{ email: "bob@example.com", partstat: "NEEDS-ACTION", rsvp: "TRUE" }],
      status: "CONFIRMED",
      sequence: 0,
    };
    const back = parseIcs(buildInviteIcs(ev)).events[0];
    expect(back.uid).toBe(ev.uid);
    expect(back.dtstart).toBe(ev.dtstart);
    expect(back.attendees[0].email).toBe("bob@example.com");
  });
});

describe("dates", () => {
  it("handles UTC, floating, all-day, and TZID", () => {
    expect(parseIcalDate("20261001T120000Z").epoch).toBe(Date.UTC(2026, 9, 1, 12));
    expect(parseIcalDate("20261001T120000").epoch).toBe(Date.UTC(2026, 9, 1, 12));
    const ad = parseIcalDate("20261001", { VALUE: "DATE" });
    expect(ad.allDay).toBe(true);
    // 12:00 wall time in Los Angeles (PDT, UTC-7)
    const la = parseIcalDate("20261001T120000", { TZID: "America/Los_Angeles" });
    expect(la.epoch).toBe(Date.UTC(2026, 9, 1, 19));
    // format round-trip
    expect(formatIcalDate(Date.UTC(2026, 9, 1, 12))).toBe("20261001T120000Z");
  });
});
