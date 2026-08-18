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
    expect(String(request.system)).toContain("comercial");
    const prompt = String(request.messages[0]!.content);
    expect(prompt).toContain("Pressupost per a 20 llicències");
    expect(prompt).toContain("voldríem un pressupost per a 20 llicències");
    expect(prompt).toContain("client@example.com");
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
