// Cron work: event reminders + light housekeeping.

import type { Env } from "./types";
import { sendMail } from "./mail";
import { eventsNeedingReminder, getEmail, markReminderSent } from "./db";
import { findIdentity, identityForEmail, primaryIdentity } from "./identities";

export async function runScheduled(env: Env): Promise<void> {
  const reminderMin = parseInt(env.INVITE_REMINDER_MINUTES || "0", 10);
  if (reminderMin > 0) {
    const now = Date.now();
    const due = await eventsNeedingReminder(env, now, reminderMin * 60_000);
    for (const ev of due) {
      // Remind the identity involved: the invitee for inbound invites,
      // the organizer for our own events. Fall back to primary.
      let identity = findIdentity(env, ev.organizerEmail);
      if (!identity && ev.sourceEmailId) {
        const src = await getEmail(env, ev.sourceEmailId);
        if (src) identity = identityForEmail(env, src);
      }
      if (!identity) identity = primaryIdentity(env);

      const when = new Date(ev.dtstart).toLocaleString("en-US", {
        timeZone: env.CALENDAR_TZ,
      });
      await sendMail(env, {
        from: identity,
        to: identity.address,
        subject: `Reminder: ${ev.summary} at ${when}`,
        text: `"${ev.summary}" starts at ${when}${ev.location ? ` — ${ev.location}` : ""}.`,
      });
      await markReminderSent(env, ev.uid);
    }
  }
}
