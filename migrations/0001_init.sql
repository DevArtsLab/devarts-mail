-- devarts-mail initial schema
-- emails: every inbound + outbound message we process
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  from_address TEXT NOT NULL,
  to_addresses TEXT NOT NULL DEFAULT '[]',   -- JSON array
  cc_addresses TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  raw TEXT,                                 -- full raw MIME (inbound only)
  message_id TEXT,
  in_reply_to TEXT,
  has_calendar INTEGER NOT NULL DEFAULT 0,
  calendar_method TEXT,                     -- REQUEST | REPLY | CANCEL | ...
  event_uid TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,             -- epoch ms
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(direction, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_event ON emails(event_uid);

-- calendar_events: the independent "DevArts Lab" calendar
CREATE TABLE IF NOT EXISTS calendar_events (
  uid TEXT PRIMARY KEY,                     -- iCal UID
  summary TEXT,
  description TEXT,
  location TEXT,
  dtstart INTEGER NOT NULL,                 -- epoch ms
  dtend INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  organizer_email TEXT,
  organizer_name TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',     -- JSON [{email,name,partstat,role}]
  status TEXT NOT NULL DEFAULT 'CONFIRMED', -- CONFIRMED|TENTATIVE|CANCELLED
  my_partstat TEXT,                         -- NEEDS-ACTION|ACCEPTED|DECLINED|TENTATIVE (for invites)
  is_own INTEGER NOT NULL DEFAULT 0,        -- 1 = created in DevArts Lab calendar
  sequence INTEGER NOT NULL DEFAULT 0,
  raw_ics TEXT,
  source_email_id TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_events_start ON calendar_events(dtstart);

-- generic key/value for app state (last cron run, counters, settings)
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
