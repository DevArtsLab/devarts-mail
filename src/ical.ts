// Minimal RFC 5545 iCalendar parser + generator.
// Covers what Google Calendar / Outlook send us: VCALENDAR with
// METHOD REQUEST / REPLY / CANCEL and VEVENT components.

import type { Attendee, CalEvent, ParsedCalendar } from "./types";

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/** Unfold folded content lines (continuation lines start with space/tab). */
function unfold(raw: string): string[] {
  const physical = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of physical) {
    if (!line.length) continue;
    if ((line[0] === " " || line[0] === "\t") && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

interface PropLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): PropLine | null {
  const m = line.match(/^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=(?:"[^"]*"|[^;:,]*))*):(.*)$/s);
  if (!m) return null;
  const params: Record<string, string> = {};
  const paramRe = /;([A-Za-z0-9-]+)=("([^"]*)"|[^;:,]*)/g;
  let p: RegExpExecArray | null;
  while ((p = paramRe.exec(m[2]))) {
    params[p[1].toUpperCase()] = p[3] !== undefined ? p[3] : p[2];
  }
  return { name: m[1].toUpperCase(), params, value: m[3] };
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function escapeText(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// Date / time handling
// ---------------------------------------------------------------------------

/** Milliseconds offset of `tz` at `epoch` (Intl-based). */
function tzOffsetMs(tz: string, epoch: number): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(new Date(epoch)).map((p) => [p.type, p.value])
    );
    const asUTC = Date.UTC(
      +parts.year, +parts.month - 1, +parts.day,
      +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second
    );
    return asUTC - epoch;
  } catch {
    return 0;
  }
}

/**
 * Parse an iCal DATE or DATE-TIME into epoch ms.
 * Handles: 20261001 | 20261001T150000Z | 20261001T150000 (floating -> UTC-ish,
 * or interpreted in TZID when the property carries one).
 */
export function parseIcalDate(
  value: string,
  params: Record<string, string> = {}
): { epoch: number; allDay: boolean } {
  const v = value.trim();
  const allDay = params["VALUE"] === "DATE" || /^\d{8}$/.test(v);

  const y = +v.slice(0, 4), mo = +v.slice(4, 6), d = +v.slice(6, 8);
  const h = v.length > 9 ? +v.slice(9, 11) : 0;
  const mi = v.length > 9 ? +v.slice(11, 13) : 0;
  const s = v.length > 9 ? +v.slice(13, 15) : 0;

  if (allDay) return { epoch: Date.UTC(y, mo - 1, d), allDay: true };
  if (v.endsWith("Z")) return { epoch: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };

  const tzid = params["TZID"];
  if (tzid) {
    // Wall time in `tzid` -> epoch. Two-pass offset correction.
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    const off1 = tzOffsetMs(tzid, guess);
    const epoch = guess - off1;
    const off2 = tzOffsetMs(tzid, epoch);
    return { epoch: guess - off2, allDay: false };
  }
  // Floating time: treat as UTC (pragmatic default).
  return { epoch: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
}

export function formatIcalDate(epoch: number, allDay = false): string {
  const d = new Date(epoch);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  if (allDay) return date;
  return `${date}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseIcs(raw: string): ParsedCalendar {
  const lines = unfold(raw);
  const cal: ParsedCalendar = { events: [] };
  let ev: CalEvent | null = null;
  let inEvent = false;

  for (const line of lines) {
    const prop = parseLine(line);
    if (!prop) continue;

    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VEVENT") {
      inEvent = true;
      ev = {
        uid: "", summary: "", description: "", location: "",
        dtstart: 0, dtend: 0, allDay: false,
        attendees: [], status: "CONFIRMED", sequence: 0,
      };
      continue;
    }
    if (prop.name === "END" && prop.value.toUpperCase() === "VEVENT") {
      if (ev) cal.events.push(ev);
      ev = null; inEvent = false;
      continue;
    }

    if (!inEvent || !ev) {
      if (prop.name === "METHOD") cal.method = prop.value.toUpperCase();
      if (prop.name === "PRODID") cal.prodid = prop.value;
      continue;
    }

    const val = unescapeText(prop.value.trim());
    switch (prop.name) {
      case "UID": ev.uid = prop.value.trim(); break;
      case "SUMMARY": ev.summary = val; break;
      case "DESCRIPTION": ev.description = val; break;
      case "LOCATION": ev.location = val; break;
      case "STATUS": ev.status = prop.value.toUpperCase(); break;
      case "SEQUENCE": ev.sequence = parseInt(prop.value, 10) || 0; break;
      case "RRULE": ev.recurrence = prop.value; break;
      case "DTSTART": {
        const { epoch, allDay } = parseIcalDate(prop.value, prop.params);
        ev.dtstart = epoch; ev.allDay = allDay;
        break;
      }
      case "DTEND": {
        const { epoch } = parseIcalDate(prop.value, prop.params);
        ev.dtend = epoch;
        break;
      }
      case "ORGANIZER": {
        ev.organizerEmail = prop.value.replace(/^mailto:/i, "");
        if (prop.params["CN"]) ev.organizerName = prop.params["CN"];
        break;
      }
      case "ATTENDEE": {
        ev.attendees.push({
          email: prop.value.replace(/^mailto:/i, ""),
          name: prop.params["CN"],
          partstat: prop.params["PARTSTAT"],
          role: prop.params["ROLE"],
          rsvp: prop.params["RSVP"],
        });
        break;
      }
    }
  }

  // Fallback end = start + 1h when DTEND is missing
  for (const e of cal.events) {
    if (!e.dtend && e.dtstart) e.dtend = e.dtstart + 3600_000;
  }
  return cal;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Fold a content line to <=75 octets (ASCII-safe approximation). */
function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    parts.push(rest.slice(0, 74));
    rest = " " + rest.slice(74);
  }
  parts.push(rest);
  return parts.join("\r\n");
}

function prop(name: string, value: string, params = ""): string {
  return foldLine(`${name}${params}:${value}`);
}

function eventProps(e: CalEvent): string[] {
  const lines = [
    prop("UID", e.uid),
    prop("DTSTAMP", formatIcalDate(Date.now())),
    prop("DTSTART", formatIcalDate(e.dtstart, e.allDay), e.allDay ? ";VALUE=DATE" : ""),
    prop("DTEND", formatIcalDate(e.dtend, e.allDay), e.allDay ? ";VALUE=DATE" : ""),
    prop("SEQUENCE", String(e.sequence)),
    prop("STATUS", e.status),
  ];
  if (e.summary) lines.push(prop("SUMMARY", escapeText(e.summary)));
  if (e.description) lines.push(prop("DESCRIPTION", escapeText(e.description)));
  if (e.location) lines.push(prop("LOCATION", escapeText(e.location)));
  if (e.recurrence) lines.push(prop("RRULE", e.recurrence));
  if (e.organizerEmail) {
    const cn = e.organizerName ? `;CN=${e.organizerName}` : "";
    lines.push(prop("ORGANIZER", `mailto:${e.organizerEmail}`, cn));
  }
  for (const a of e.attendees) {
    const ps = [
      a.role ? `ROLE=${a.role}` : "ROLE=REQ-PARTICIPANT",
      a.partstat ? `PARTSTAT=${a.partstat}` : "PARTSTAT=NEEDS-ACTION",
      a.rsvp ? `RSVP=${a.rsvp}` : "RSVP=TRUE",
      a.name ? `CN=${a.name}` : "",
    ].filter(Boolean).join(";");
    lines.push(prop("ATTENDEE", `mailto:${a.email}`, ";" + ps));
  }
  return lines;
}

function wrapCalendar(method: string, body: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    prop("PRODID", "-//DevArts Lab//devarts-mail//EN"),
    prop("VERSION", "2.0"),
    prop("CALSCALE", "GREGORIAN"),
    prop("METHOD", method),
    ...body,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** METHOD:REQUEST — we organize and invite attendees. */
export function buildInviteIcs(e: CalEvent): string {
  return wrapCalendar("REQUEST", [
    "BEGIN:VEVENT",
    ...eventProps(e),
    "END:VEVENT",
  ]);
}

/** METHOD:CANCEL — cancel an event we organized. */
export function buildCancelIcs(e: CalEvent): string {
  return wrapCalendar("CANCEL", [
    "BEGIN:VEVENT",
    ...eventProps({ ...e, status: "CANCELLED" }),
    "END:VEVENT",
  ]);
}

/**
 * METHOD:REPLY — respond to an invite as `me`.
 * This is what makes the organizer (e.g. Google Calendar) record
 * "amir@devartslab.com: Accepted".
 */
export function buildReplyIcs(e: CalEvent, me: { email: string; name: string }, partstat: string): string {
  const reply: CalEvent = {
    ...e,
    attendees: [{
      email: me.email,
      name: me.name,
      partstat,
      role: "REQ-PARTICIPANT",
      rsvp: "FALSE",
    }],
  };
  return wrapCalendar("REPLY", [
    "BEGIN:VEVENT",
    ...eventProps(reply),
    "END:VEVENT",
  ]);
}

/** METHOD:PUBLISH-style standalone .ics export (for downloads/sharing). */
export function buildExportIcs(events: CalEvent[], calName: string): string {
  const body: string[] = [
    prop("X-WR-CALNAME", escapeText(calName)),
    prop("X-WR-TIMEZONE", "UTC"),
  ];
  for (const e of events) {
    body.push("BEGIN:VEVENT", ...eventProps(e), "END:VEVENT");
  }
  return wrapCalendar("PUBLISH", body);
}

export function newUid(domain: string): string {
  return `${crypto.randomUUID()}@${domain}`;
}
