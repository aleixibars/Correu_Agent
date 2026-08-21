// Turning a textarea's raw text into the pattern list a rule stores
// (context.md §2-style granular config): the dashboard accepts one pattern per
// line or separated by commas, whichever is easiest to type, and blanks left by
// stray separators or empty lines are dropped rather than stored as a pattern
// that matches nothing.

/** Splits raw textarea text into trimmed, non-empty patterns. */
export const parsePatternList = (raw: string | null): string[] => {
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};
