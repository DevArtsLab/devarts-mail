# ADR 0001: Attio CRM sync via REST API push

Status: proposed (trial)
Date: 2026-11-22

## Context

devarts-mail receives mail through Cloudflare Email Routing and stores it
in D1. Attio's native mailbox sync only supports Google Workspace and
Microsoft 365 accounts, so mail flowing through this worker is invisible
to Attio. The lab wants CRM records (people, companies, meetings, notes)
for the addresses it corresponds with, without moving mail to a paid
Google/Microsoft mailbox.

## Decision

Push stored emails and calendar events to the Attio REST API from the
existing `*/10m` cron in `src/attio.ts`:

- Emails become notes on person records, one per external participant,
  tracked per-recipient in `emails.attio_notes` so retries are
  idempotent.
- Calendar events become Attio meetings; Attio meetings are immutable,
  so updates are delete + recreate with linked records migrated.
- Sync state lives in dedicated `attio_*` columns plus an
  `attio_deletion_queue` table for remote deletes that fail after the
  local row is removed.
- Gated by `ATTIO_SYNC_ENABLED` and the `ATTIO_ACCESS_TOKEN` secret.
  First deploy backfills all stored history; `ATTIO_SYNC_ENABLED` is
  set back to `"false"` when the Attio trial ends.

## Consequences

- No dependency on Attio's native sync; works for any provider routed
  through the worker.
- Sync is eventually consistent (up to ~10 minutes plus retry backoff).
- Attio-side manual edits (e.g. company on a person) are preserved:
  company is only set when empty, and meeting recreation migrates
  explicit linked records.
- Deletes propagate one way only: local deletes and cancelled invites
  remove Attio copies. Deletions made inside Attio are not applied
  back to the mailbox.
- Costs: Attio API calls per cron run are capped by a subrequest budget
  to stay within Workers Free limits.
- If the trial is not extended, the feature flag turns off and the
  branch can be dropped without affecting core mail functionality.
