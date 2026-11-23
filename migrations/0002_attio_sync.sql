-- devarts-mail attio sync: track what has been mirrored to Attio.
-- emails: synced once (fire-and-mark); retried while attio_synced_at IS NULL.
ALTER TABLE emails ADD COLUMN attio_synced_at INTEGER;

-- events: attio_meeting_id = remote meeting UUID; re-synced when updated_at
-- is newer than attio_synced_at.
ALTER TABLE calendar_events ADD COLUMN attio_meeting_id TEXT;
ALTER TABLE calendar_events ADD COLUMN attio_synced_at INTEGER;
