-- devarts-mail attio sync: record which identity answered an invite so
-- multi-alias mailboxes show the correct per-attendee RSVP in Attio.
ALTER TABLE calendar_events ADD COLUMN my_rsvp_addr TEXT;
