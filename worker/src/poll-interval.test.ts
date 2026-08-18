import { describe, expect, it } from "vitest";
import {
  POLL_CRON_EXPRESSION,
  POLL_INTERVAL_MS,
  pollCronExpression,
} from "./poll-interval";

describe("poll interval", () => {
  it("is 2 minutes in milliseconds", () => {
    expect(POLL_INTERVAL_MS).toBe(120_000);
  });
});

describe("pollCronExpression", () => {
  it("schedules the polling cadence of POLL_INTERVAL_MS", () => {
    expect(POLL_CRON_EXPRESSION).toBe("*/2 * * * *");
    expect(pollCronExpression(POLL_INTERVAL_MS)).toBe(POLL_CRON_EXPRESSION);
  });

  it("schedules a one-minute interval without a step", () => {
    expect(pollCronExpression(60_000)).toBe("* * * * *");
  });

  it("refuses an interval cron cannot express evenly", () => {
    // `*/7` would fire at :56 and then at :00 — four minutes later, not seven.
    expect(() => pollCronExpression(7 * 60_000)).toThrow(/interval/i);
    expect(() => pollCronExpression(90_000)).toThrow(/interval/i);
    expect(() => pollCronExpression(0)).toThrow(/interval/i);
  });
});
