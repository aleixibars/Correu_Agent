// Asking Claude Haiku which of the six fixed categories a thread belongs to
// (context.md §4, §6). The call itself only reads mail and answers with a label:
// storing the answer and auditing it is `./triage-thread`.

import type Anthropic from "@anthropic-ai/sdk";
import { TRIAGE_CATEGORIES, type TriageCategory } from "./taxonomy";

/** One label out of six is the cheapest job in the product, so it runs on Haiku (context.md §6). */
export const TRIAGE_MODEL = "claude-haiku-4-5";

/**
 * Where an answer that names no category lands. There is no "unclassified"
 * state and no manual queue (context.md §4), so the catch-all category takes it
 * — the only one that neither raises an urgent notification nor is eligible for
 * an auto-reply.
 */
export const TRIAGE_FALLBACK_CATEGORY: TriageCategory = "personal";

/** A label is a handful of tokens; the cap only bounds a model that rambles. */
const MAX_TOKENS = 256;

/** How much of one message is worth reading: the opening of a mail decides its category. */
const MAX_BODY_CHARS = 2_000;
/** Later replies rarely change what a thread *is*, and the whole thread is sent every time. */
const MAX_MESSAGES = 10;

/**
 * The classifier's slice of the Anthropic client, so a caller can hand over
 * `anthropic.messages` and a test can hand over a stub.
 */
export type TriageMessagesClient = Pick<Anthropic["messages"], "create">;

/** One message of the thread being classified, as stored (context.md §7). */
export interface ThreadMessageToClassify {
  fromAddress: string;
  subject: string | null;
  /** Null once the 90-day retention window purged the body; the snippet survives it. */
  bodyText: string | null;
  snippet: string | null;
}

export interface ThreadToClassify {
  subject: string | null;
  /** Oldest first — the mail that opened the thread carries most of the signal. */
  messages: ThreadMessageToClassify[];
}

export interface ThreadClassification {
  category: TriageCategory;
  /** The model that answered, recorded in the audit trail (context.md §7). */
  model: string;
}

const SYSTEM_PROMPT = [
  "You triage the inbox of a business. Classify the email thread the user sends",
  "into exactly one of these categories:",
  "",
  "- urgent: needs a human to act now — outages, deadlines, angry or escalating customers.",
  "- comercial: sales — enquiries, quotes, pricing, partnership and purchase intent.",
  "- suport: customer support — how-to questions, problem reports, service requests.",
  "- facturacio: invoicing and administration — invoices, payments, contracts, tax, paperwork.",
  "- newsletter: newsletters, marketing blasts, automated notifications and spam.",
  "- personal: personal mail and anything the other five do not describe.",
  "",
  "Answer with the category name alone, in lowercase, and nothing else. Never",
  "refuse and never ask for more information: if the thread is ambiguous, answer",
  "with the most likely category anyway.",
].join("\n");

const truncate = (text: string): string =>
  text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;

const renderMessage = (message: ThreadMessageToClassify): string =>
  [
    `From: ${message.fromAddress}`,
    `Subject: ${message.subject ?? "(no subject)"}`,
    // The body is gone once it is purged (context.md §7), and a stored snippet
    // is still enough to place the thread.
    truncate(message.bodyText ?? message.snippet ?? "(no body)"),
  ].join("\n");

const renderThread = (thread: ThreadToClassify): string =>
  [
    `Thread subject: ${thread.subject ?? "(no subject)"}`,
    "",
    ...thread.messages.slice(0, MAX_MESSAGES).map(renderMessage),
  ].join("\n\n");

const answerText = (message: Anthropic.Message): string =>
  message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .toLowerCase();

/**
 * The category the answer names. A model told to answer with a bare label
 * sometimes wraps it in a sentence, so the label is looked for inside the
 * answer rather than compared to it.
 */
const parseCategory = (answer: string): TriageCategory =>
  TRIAGE_CATEGORIES.find((category) => answer.includes(category)) ??
  TRIAGE_FALLBACK_CATEGORY;

/**
 * Classifies one thread into a category (context.md §4). Always returns one:
 * a low-confidence thread gets the most likely category, never a "needs a
 * human" state, so nothing can pile up in a queue nobody works.
 */
export const classifyThread = async (
  client: TriageMessagesClient,
  thread: ThreadToClassify,
): Promise<ThreadClassification> => {
  const answer = await client.create({
    model: TRIAGE_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: renderThread(thread) }],
  });

  return {
    category: parseCategory(answerText(answer)),
    // What actually answered, which is not always what was asked for.
    model: answer.model,
  };
};
