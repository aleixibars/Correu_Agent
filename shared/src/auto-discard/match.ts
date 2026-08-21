// Deciding whether an auto-discard rule fires on one thread. A rule with no
// senders and no keywords applies to the whole category; once either list is
// set, a thread only matches when it hits one of them — this is the "and/or" a
// tenant would expect from a mail filter, not a rule that silently stops
// applying to anything the moment a second condition is added.

export interface AutoDiscardCriteria {
  senderPatterns: readonly string[];
  keywordPatterns: readonly string[];
}

export interface AutoDiscardMatchInput {
  /** Every sender address seen in the thread so far, in whatever order they were loaded. */
  fromAddresses: readonly string[];
  /** The thread's subject; null reads as "no subject", never as a wildcard. */
  subject: string | null;
}

/** Case-insensitive substring match: any pattern found inside any haystack. */
const matchesAny = (
  patterns: readonly string[],
  haystacks: readonly string[],
): boolean =>
  patterns.some((pattern) => {
    const needle = pattern.toLowerCase();
    return haystacks.some((haystack) => haystack.toLowerCase().includes(needle));
  });

export const matchesAutoDiscardCriteria = (
  rule: AutoDiscardCriteria,
  { fromAddresses, subject }: AutoDiscardMatchInput,
): boolean => {
  const hasSenderPatterns = rule.senderPatterns.length > 0;
  const hasKeywordPatterns = rule.keywordPatterns.length > 0;

  // The category-only rule: nothing narrows it further.
  if (!hasSenderPatterns && !hasKeywordPatterns) return true;

  const senderMatch =
    hasSenderPatterns && matchesAny(rule.senderPatterns, fromAddresses);
  const keywordMatch =
    hasKeywordPatterns &&
    subject !== null &&
    matchesAny(rule.keywordPatterns, [subject]);

  return senderMatch || keywordMatch;
};
