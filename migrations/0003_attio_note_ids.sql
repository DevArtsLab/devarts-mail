-- devarts-mail attio sync: per-recipient Attio note IDs for each synced
-- email. JSON object { "addr": "note_uuid" }; makes cron retries
-- idempotent and lets email deletion remove the Attio copies.
ALTER TABLE emails ADD COLUMN attio_notes TEXT;
