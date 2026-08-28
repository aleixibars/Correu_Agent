// Reading and writing mail addresses. Shared by the Gmail poll (which parses
// them out of RFC 5322 headers) and by the dashboard's approval form (where a
// reviewer types them by hand, context.md §2) — both need the same answer to
// "which addresses does this text name?".

/**
 * Pulls the addresses out of an address header. Commas inside a quoted display
 * name (`"Ibars, Aleix" <a@example.com>`) do not separate addresses, so the
 * split tracks quotes and angle brackets instead of using `split(",")`.
 */
export const parseAddressList = (value: string | null): string[] => {
  if (!value) return [];

  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;

  for (const character of value) {
    if (character === '"') quoted = !quoted;
    else if (character === "<" && !quoted) angled = true;
    else if (character === ">" && !quoted) angled = false;

    if (character === "," && !quoted && !angled) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  entries.push(current);

  return entries
    .map((entry) => parseAddress(entry))
    .filter((address): address is string => address !== null);
};

const parseAddress = (entry: string): string | null => {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  const opening = trimmed.lastIndexOf("<");
  const closing = trimmed.lastIndexOf(">");
  const address =
    opening !== -1 && closing > opening
      ? trimmed.slice(opening + 1, closing)
      : trimmed;

  return address.trim().toLowerCase() || null;
};

/**
 * Deliberately loose: a local part, an `@`, and a domain with a dot in it and
 * no whitespace anywhere. The point is to catch the reviewer who typed prose or
 * lost half an address, not to re-litigate RFC 5322 — the provider has the last
 * word on whether an address exists at all.
 */
const EMAIL_ADDRESS = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * The addresses a reviewer typed into a recipient field of the approval form,
 * or a throw naming what cannot be one. Duplicates are dropped: the same
 * address twice in a `To` is one recipient, and the reviewer having pasted a
 * name that was already there must not send them two copies.
 */
export const parseRecipientField = (value: string, field: string): string[] => {
  const addresses = parseAddressList(value);

  for (const address of addresses) {
    if (!EMAIL_ADDRESS.test(address)) {
      throw new Error(`"${address}" is not an email address (${field}).`);
    }
  }

  return [...new Set(addresses)];
};
