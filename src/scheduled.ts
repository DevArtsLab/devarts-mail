// Cron work: event reminders + light housekeeping.

import type { Env } from "./types";
import { sendMail } from "./mail";
import { eventsNeedingReminder, markReminderSent } from "./db";
import { formatIcalDate } from "./ical";

export async function runScheduled(env: Env): Promise<void> {
  const reminderMin = parseInt(env.INVITE_REMINDER_MINUTES || "0", 10);
  if (reminderMin > 0) {
    const now = Date.now();
    const due = await eventsNeedingReminder(env, now, reminderMin * 60_000);
    for (const ev of due) {
      const when = new Date(ev.dtstart).toLocaleString("en-US", { timeZone: env.CALENDAR_TZ });
      await sendMail(env, {
        to: env.PRIMARY_ADDRESS,
        subject: `Reminder: ${ev.summary} at ${when}`,
        text: `"${ev.summary}" starts at ${when}${ev.location ? ` — ${ev.location}` : ""}.`,
      });
      await markReminderSent(env, ev.uid);
    }
  }
}
