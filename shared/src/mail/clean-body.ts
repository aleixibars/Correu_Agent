// Display-only cleanup of a message body (issue #83). The `text/plain` a
// provider hands us usually carries the whole conversation underneath the few
// lines the sender actually wrote: an attribution line, the previous mail
// quoted with `>`, a signature, a mobile-client footer. A reviewer reading the
// thread page only wants the new part.
//
// Deliberately not applied to what is persisted in `messages` nor to what the
// model reads when drafting (`shared/src/drafts/generate.ts` frames the whole
// thread on its own terms) — cutting text is a heuristic, and a heuristic must
// never be the thing that loses data.

/** Gmail/Outlook attribution: `El <data> ... va escriure:`, `On ... wrote:`. */
const ATTRIBUTION =
  /^(el|em|on|le|il|am)\b.*\b(va escriure|escrigué|escribió|escribio|wrote|a écrit|ha scritto|schrieb)\s*:$/i;

/** Outlook's separator, in the languages this product's mailboxes speak. */
const ORIGINAL_MESSAGE =
  /^-{2,}\s*(original message|mensaje original|missatge original|forwarded message|mensaje reenviado|missatge reenviat)\s*-{2,}$/i;

/** The RFC 3676 signature delimiter — a line that is exactly `--` (or `-- `). */
const SIGNATURE_DELIMITER = /^--$/;

/** Footers phones staple onto every outgoing mail. */
const MOBILE_FOOTER = /^(enviat des del meu|enviado desde mi|sent from my)\b/i;

const isQuoted = (line: string): boolean => line.startsWith(">");

/**
 * Index of the first line that starts the quoted tail / signature, or `-1`
 * when the body looks like new content all the way down.
 */
const findTailStart = (lines: string[]): number => {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trimEnd();

    if (
      ORIGINAL_MESSAGE.test(line) ||
      SIGNATURE_DELIMITER.test(line) ||
      MOBILE_FOOTER.test(line)
    ) {
      return index;
    }

    // Gmail wraps a long attribution over two lines, so the `va escriure:` can
    // land on its own line; match the pair joined back together as well.
    const next = lines[index + 1];
    if (
      ATTRIBUTION.test(line) ||
      (next !== undefined && ATTRIBUTION.test(`${line} ${next.trim()}`))
    ) {
      return index;
    }

    // A single `>` line can be someone quoting a value inline; a run of them is
    // the previous mail.
    if (isQuoted(line) && next !== undefined && isQuoted(next.trimStart())) {
      return index;
    }
  }

  return -1;
};

/**
 * The new content of `bodyText`, trimmed and with the quoted tail and
 * signature dropped — or `null` when there is nothing left to show (a body
 * purged by retention, context.md §7, or one that was only whitespace).
 *
 * Fails safe: if the heuristic would leave the message empty (a forward with
 * no new text on top), the whole trimmed body is returned instead. Showing too
 * much beats hiding real content.
 */
export const cleanMessageBody = (bodyText: string | null): string | null => {
  if (bodyText === null) return null;

  const normalised = bodyText.replace(/\r\n/g, "\n");
  const lines = normalised.split("\n");
  const tailStart = findTailStart(lines);

  const cleaned =
    tailStart === -1
      ? normalised.trim()
      : lines.slice(0, tailStart).join("\n").trim();

  return cleaned === "" ? normalised.trim() || null : cleaned;
};
