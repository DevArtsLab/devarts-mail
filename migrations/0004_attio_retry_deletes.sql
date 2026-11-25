-- devarts-mail attio sync: retry backoff + durable remote-delete queue.
-- attio_attempted_at: set when a sync attempt fails; pending queries skip
-- rows until the backoff window passes so permanent failures cannot
-- starve the batch.
ALTER TABLE emails ADD COLUMN attio_attempted_at INTEGER;
ALTER TABLE calendar_events ADD COLUMN attio_attempted_at INTEGER;

-- Remote deletes (notes/meetings) that failed after the local row was
-- already removed. The cron drains this queue with backoff.
CREATE TABLE IF NOT EXISTS attio_deletion_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- 'note' | 'meeting'
  remote_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, remote_id)
);
