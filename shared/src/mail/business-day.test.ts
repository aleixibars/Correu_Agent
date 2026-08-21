import { describe, expect, it } from "vitest";
import { startOfBusinessDay } from "./business-day";

describe("startOfBusinessDay", () => {
  it("returns midnight Europe/Madrid of the same day in winter (CET, UTC+1)", () => {
    // 2026-01-15T10:30:00Z is 2026-01-15T11:30 in Madrid (CET) — same day.
    const result = startOfBusinessDay(new Date("2026-01-15T10:30:00.000Z"));

    expect(result).toEqual(new Date("2026-01-14T23:00:00.000Z"));
  });

  it("returns midnight Europe/Madrid of the same day in summer (CEST, UTC+2)", () => {
    // 2026-07-15T10:30:00Z is 2026-07-15T12:30 in Madrid (CEST) — same day.
    const result = startOfBusinessDay(new Date("2026-07-15T10:30:00.000Z"));

    expect(result).toEqual(new Date("2026-07-14T22:00:00.000Z"));
  });

  it("rolls forward to the next Madrid day when the instant is already past midnight there", () => {
    // 2026-01-15T23:30:00Z is 2026-01-16T00:30 in Madrid (CET) — the next day.
    const result = startOfBusinessDay(new Date("2026-01-15T23:30:00.000Z"));

    expect(result).toEqual(new Date("2026-01-15T23:00:00.000Z"));
  });

  it("stays on the earlier Madrid day when the instant has not reached midnight there yet", () => {
    // 2026-01-15T22:30:00Z is 2026-01-15T23:30 in Madrid (CET) — still the same day.
    const result = startOfBusinessDay(new Date("2026-01-15T22:30:00.000Z"));

    expect(result).toEqual(new Date("2026-01-14T23:00:00.000Z"));
  });

  it("is idempotent on an instant that is already midnight Europe/Madrid", () => {
    const midnight = new Date("2026-01-14T23:00:00.000Z");

    expect(startOfBusinessDay(midnight)).toEqual(midnight);
  });
});
