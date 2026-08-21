// Where "the day a mailbox connected" starts (context.md §4): mail older than
// the connection is never processed, but the cut is measured in the
// business's timezone, not the server's — the same one the dashboard already
// formats every date in (`app/src/app/fils/page.tsx` and siblings).

/** The one timezone this product's "today" is measured in. */
const BUSINESS_TIMEZONE = "Europe/Madrid";

const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const localHour = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIMEZONE,
  hour: "numeric",
  hourCycle: "h23",
});

/**
 * Midnight `Europe/Madrid` of the calendar day that contains `date`.
 *
 * Pure and provider-agnostic — both the Microsoft poll's `since` cutoff and
 * Gmail's one-time connection-day catch-up are pinned to this same instant, so
 * the "what day is it" logic exists in exactly one place.
 *
 * Madrid alternates between CET (UTC+1) and CEST (UTC+2), so the offset can't
 * be hard-coded. Instead: read the calendar date `date` falls on in Madrid,
 * take UTC midnight of that same date as a first guess, then correct it by the
 * number of hours that guess reads as in Madrid — which is exactly the
 * standing offset, because the guess is still well within the same Madrid day.
 */
export const startOfBusinessDay = (date: Date): Date => {
  const parts = Object.fromEntries(
    dateParts.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const utcMidnightGuess = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    0,
    0,
    0,
    0,
  );

  const offsetHours = Number(localHour.format(new Date(utcMidnightGuess)));

  return new Date(utcMidnightGuess - offsetHours * 60 * 60 * 1000);
};
