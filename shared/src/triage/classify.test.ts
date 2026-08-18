import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  TRIAGE_FALLBACK_CATEGORY,
  TRIAGE_MODEL,
  classifyThread,
  type TriageMessagesClient,
} from "./classify";
import { TRIAGE_CATEGORIES } from "./taxonomy";

/** What the Messages API answers, reduced to the fields the classifier reads. */
const reply = (text: string) =>
  ({
    model: TRIAGE_MODEL,
    content: [{ type: "text", text }],
  }) as unknown as Anthropic.Message;

const createClient = (text: string) => {
  const create = vi.fn(async (_params: Anthropic.MessageCreateParams) =>
    reply(text),
  );
  return { client: { create } as unknown as TriageMessagesClient, create };
};

const thread = {
  subject: "Pressupost per a 20 llicències",
  messages: [
    {
      fromAddress: "client@example.com",
      subject: "Pressupost per a 20 llicències",
      bodyText: "Bon dia, voldríem un pressupost per a 20 llicències.",
      snippet: "Bon dia, voldríem un pressupost",
    },
  ],
};

describe("classifyThread", () => {
  it.each(TRIAGE_CATEGORIES)("takes %s from the model's answer", async (category) => {
    const { client } = createClient(category);

    await expect(classifyThread(client, thread)).resolves.toEqual({
      category,
      model: TRIAGE_MODEL,
    });
  });

  it("reads the category out of an answer that says more than the label", async () => {
    const { client } = createClient("Categoria: comercial\n");

    await expect(classifyThread(client, thread)).resolves.toMatchObject({
      category: "comercial",
    });
  });

  it("reads a category the model spelled with its Catalan accent", async () => {
    // The mail is Catalan, so a model naming the category in the language it
    // just read writes "facturació" — which used to match nothing at all and
    // filed every invoice under the catch-all category.
    const { client } = createClient("facturació");

    await expect(classifyThread(client, thread)).resolves.toMatchObject({
      category: "facturacio",
    });
  });

  it("takes the category the answer names, not the first of the taxonomy", async () => {
    // Scanning the taxonomy in order let its order decide the answer, and
    // `urgent` is both listed first and the only category that pushes a
    // notification — so every ruled-out mention of it raised a false alarm.
    const { client } = createClient("No és urgent, és comercial.");

    await expect(classifyThread(client, thread)).resolves.toMatchObject({
      category: "comercial",
    });
  });

  it.each([
    ["suport urgentment", "suport"],
    ["comercial, res de personalitzat", "comercial"],
  ])(
    "does not read a category out of a longer word (%s)",
    async (answer, category) => {
      const { client } = createClient(answer);

      await expect(classifyThread(client, thread)).resolves.toMatchObject({
        category,
      });
    },
  );

  it("falls back to a category instead of leaving the thread unclassified", async () => {
    // Low confidence never produces a manual queue (context.md §4): an answer
    // naming no category still has to end in one, and the catch-all category is
    // the only one that is neither urgent nor auto-reply eligible.
    const { client } = createClient("No n'estic segur.");

    await expect(classifyThread(client, thread)).resolves.toEqual({
      category: TRIAGE_FALLBACK_CATEGORY,
      model: TRIAGE_MODEL,
    });
  });

  it("asks Haiku with the thread's subject and body", async () => {
    const { client, create } = createClient("comercial");

    await classifyThread(client, thread);

    const request = create.mock.calls[0]![0];
    // Triage is a one-label job, so it runs on the cheap model (context.md §6).
    expect(request.model).toBe(TRIAGE_MODEL);
    // One of six labels has no use for sampling: the same mail must not land in
    // two categories depending on which tick classified it.
    expect(request.temperature).toBe(0);
    expect(String(request.system)).toContain("comercial");
    const prompt = String(request.messages[0]!.content);
    expect(prompt).toContain("Pressupost per a 20 llicències");
    expect(prompt).toContain("voldríem un pressupost per a 20 llicències");
    expect(prompt).toContain("client@example.com");
    // Anyone can mail this inbox, so the mail is fenced off as data and the
    // system prompt says so — a body that reads like an order is still mail.
    expect(prompt).toContain("<thread>");
    expect(String(request.system)).toContain("untrusted");
  });

  it("falls back to the snippet of a message whose body was purged", async () => {
    const { client, create } = createClient("newsletter");

    await classifyThread(client, {
      subject: "Butlletí",
      messages: [
        {
          fromAddress: "news@example.com",
          subject: "Butlletí",
          bodyText: null,
          snippet: "Novetats del mes",
        },
      ],
    });

    const request = create.mock.calls[0]![0];
    expect(String(request.messages[0]!.content)).toContain("Novetats del mes");
  });
});
