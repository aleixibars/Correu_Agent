// Polling cadence for connected mailboxes (context.md §8): every 2 minutes,
// until the migration to Gmail Pub/Sub / Microsoft Graph webhooks.

export const POLL_INTERVAL_MS = 2 * 60 * 1000;

const MINUTES_PER_HOUR = 60;

/**
 * The cadence as a cron expression, because pg-boss schedules on cron. Only
 * whole minutes that divide an hour are accepted: a step of 7 restarts at every hour
 * boundary, which would silently poll at an interval nobody asked for.
 */
export const pollCronExpression = (intervalMs: number): string => {
  const minutes = intervalMs / 60_000;
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MINUTES_PER_HOUR / 2 ||
    MINUTES_PER_HOUR % minutes !== 0
  ) {
    throw new Error(
      `A poll interval of ${intervalMs}ms cannot be scheduled: it must be a whole number of minutes dividing an hour.`,
    );
  }
  return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`;
};

export const POLL_CRON_EXPRESSION = pollCronExpression(POLL_INTERVAL_MS);
