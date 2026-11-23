export interface Env {
  DB: D1Database;
  EMAIL: SendEmail;
  ASSETS: Fetcher;

  // vars (wrangler.jsonc)
  MAIL_DOMAIN: string;
  PRIMARY_ADDRESS: string;
  DISPLAY_NAME: string;
  /** Extra send/receive identities (secret): "addr=Display Name;addr2=Name2" */
  EXTRA_IDENTITIES?: string;
  CALENDAR_NAME: string;
  CALENDAR_TZ: string;
  AUTO_ACCEPT_INVITES: string;
  INVITE_REMINDER_MINUTES: string;
  SESSION_TTL_HOURS: string;

  // secrets (.dev.vars / wrangler secret)
  UI_PASSWORD: string;
  SESSION_SECRET: string;
  /** Personal Gmail that receives read-only PUBLISH copies of invites. */
  GCAL_FORWARD_TO?: string;
  /** "true" to mirror emails/events into Attio (needs ATTIO_ACCESS_TOKEN). */
  ATTIO_SYNC_ENABLED?: string;
  /** Attio workspace access token (secret). */
  ATTIO_ACCESS_TOKEN?: string;
  /** Comma-separated extra "self" addresses excluded from sync (e.g. Gmail). */
  ATTIO_IGNORE_ADDRESSES?: string;
}

export type RsvpStatus = "ACCEPTED" | "DECLINED" | "TENTATIVE";

export interface Attendee {
  email: string;
  name?: string;
  partstat?: string;
  role?: string;
  rsvp?: string;
}

export interface CalEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  dtstart: number; // epoch ms
  dtend: number;
  allDay: boolean;
  organizerEmail?: string;
  organizerName?: string;
  attendees: Attendee[];
  status: string; // CONFIRMED | TENTATIVE | CANCELLED
  sequence: number;
  recurrence?: string;
}

export interface ParsedCalendar {
  method?: string; // REQUEST | REPLY | CANCEL | PUBLISH ...
  prodid?: string;
  events: CalEvent[];
}

export interface StoredEmail {
  id: string;
  direction: "in" | "out";
  from_address: string;
  to_addresses: string; // JSON
  cc_addresses: string;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  raw: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  has_calendar: number;
  calendar_method: string | null;
  event_uid: string | null;
  read: number;
  received_at: number;
  /** Set once the email has been mirrored to Attio. */
  attio_synced_at?: number | null;
  /** JSON map of participant address -> Attio note_id (see attio.ts). */
  attio_notes?: string | null;
  /** List view only: first chars of body_text (not present on getEmail). */
  snippet?: string;
}
