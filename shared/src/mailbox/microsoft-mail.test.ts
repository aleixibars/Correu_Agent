import { describe, expect, it } from "vitest";
import { fetchMicrosoftNewMessages } from "./microsoft-mail";

const CONNECTED_AT = new Date("2026-01-01T00:00:00.000Z");

const graphMessage = (overrides: Record<string, unknown> = {}) => ({
  id: "message-1",
  conversationId: "conversation-1",
  internetMessageId: "<message-1@example.com>",
  subject: "Pressupost",
  receivedDateTime: "2026-01-01T09:00:00Z",
  isDraft: false,
  from: { emailAddress: { address: "Client@Example.com" } },
  toRecipients: [{ emailAddress: { address: "bustia@example.com" } }],
  ccRecipients: [{ emailAddress: { address: "copia@example.com" } }],
  bodyPreview: "Bon dia,",
  body: { contentType: "html", content: "<p>Bon dia</p>" },
  ...overrides,
});

/** Replies with one canned response per request, in order, recording each one. */
const stubFetch = (
  responses: { status?: number; body: unknown }[],
): { fetch: typeof globalThis.fetch; calls: Request[] } => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input as RequestInfo, init));
    const response = responses[calls.length - 1];
    if (!response) throw new Error(`Unexpected request #${calls.length}`);
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
};

describe("fetchMicrosoftNewMessages", () => {
  it("starts a mailbox with no cursor from the current state, not from its history", async () => {
    const { fetch, calls } = stubFetch([
      { body: { value: [], "@odata.deltaLink": "https://delta/1" } },
      { body: { value: [graphMessage()] } },
    ]);

    const sync = await fetchMicrosoftNewMessages({
      accessToken: "access-token",
      since: CONNECTED_AT,
      fetch,
    });

    // `$deltatoken=latest` gets a cursor without enumerating the whole inbox,
    // which is what "only mail newer than the connection" needs (context.md §4).
    expect(calls[0]!.url).toContain("/me/mailFolders/inbox/messages/delta");
    expect(calls[0]!.url).toContain("deltatoken=latest");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer access-token");
    // Mail that arrived between connecting and this first poll is not in the
    // delta yet, so it is caught up with a filtered list.
    expect(decodeURIComponent(calls[1]!.url)).toContain(
      "receivedDateTime gt 2026-01-01T00:00:00.000Z",
    );
    // The whole message comes back, body included: it is stored as it arrives
    // and never fetched from Graph a second time (context.md §7).
    expect(sync).toEqual({
      deltaLink: "https://delta/1",
      messages: [
        {
          providerMessageId: "message-1",
          providerThreadId: "conversation-1",
          direction: "inbound",
          messageIdHeader: "<message-1@example.com>",
          inReplyTo: null,
          references: null,
          fromAddress: "client@example.com",
          toAddresses: ["bustia@example.com"],
          ccAddresses: ["copia@example.com"],
          subject: "Pressupost",
          snippet: "Bon dia,",
          bodyText: null,
          bodyHtml: "<p>Bon dia</p>",
          sentAt: new Date("2026-01-01T09:00:00Z"),
        },
      ],
    });
  });

  it("keeps a plain-text body out of the HTML column", async () => {
    const { fetch } = stubFetch([
      {
        body: {
          value: [
            graphMessage({
              body: { contentType: "text", content: "Bon dia" },
            }),
          ],
          "@odata.deltaLink": "https://delta/2",
        },
      },
    ]);

    const sync = await fetchMicrosoftNewMessages({
      accessToken: "access-token",
      deltaLink: "https://delta/1",
      since: CONNECTED_AT,
      fetch,
    });

    expect(sync.messages[0]).toMatchObject({
      bodyText: "Bon dia",
      bodyHtml: null,
    });
  });

  it("resumes from the stored delta link and follows every page", async () => {
    const { fetch, calls } = stubFetch([
      {
        body: {
          value: [graphMessage()],
          "@odata.nextLink": "https://graph.example/page-2",
        },
      },
      {
        body: {
          value: [graphMessage({ id: "message-2" })],
          "@odata.deltaLink": "https://delta/2",
        },
      },
    ]);

    const sync = await fetchMicrosoftNewMessages({
      accessToken: "access-token",
      deltaLink: "https://delta/1",
      since: CONNECTED_AT,
      fetch,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://delta/1",
      "https://graph.example/page-2",
    ]);
    expect(sync.deltaLink).toBe("https://delta/2");
    expect(sync.messages.map((message) => message.providerMessageId)).toEqual([
      "message-1",
      "message-2",
    ]);
  });

  it("leaves out deletions, drafts and mail older than the connection", async () => {
    const { fetch } = stubFetch([
      {
        body: {
          value: [
            graphMessage({ id: "removed", "@removed": { reason: "deleted" } }),
            graphMessage({ id: "own-draft", isDraft: true }),
            graphMessage({
              id: "before-connection",
              receivedDateTime: "2025-12-31T23:59:59Z",
            }),
            graphMessage({ id: "kept" }),
          ],
          "@odata.deltaLink": "https://delta/2",
        },
      },
    ]);

    const sync = await fetchMicrosoftNewMessages({
      accessToken: "access-token",
      deltaLink: "https://delta/1",
      since: CONNECTED_AT,
      fetch,
    });

    expect(sync.messages.map((message) => message.providerMessageId)).toEqual([
      "kept",
    ]);
  });

  it("reports the same message once even if two pages carry it", async () => {
    const { fetch } = stubFetch([
      {
        body: {
          value: [graphMessage()],
          "@odata.nextLink": "https://graph.example/page-2",
        },
      },
      {
        body: {
          value: [graphMessage({ subject: "Pressupost (llegit)" })],
          "@odata.deltaLink": "https://delta/2",
        },
      },
    ]);

    const sync = await fetchMicrosoftNewMessages({
      accessToken: "access-token",
      deltaLink: "https://delta/1",
      since: CONNECTED_AT,
      fetch,
    });

    expect(sync.messages).toHaveLength(1);
  });

  it("fails instead of losing the cursor when the last page carries no delta link", async () => {
    const { fetch } = stubFetch([{ body: { value: [graphMessage()] } }]);

    await expect(
      fetchMicrosoftNewMessages({
        accessToken: "access-token",
        deltaLink: "https://delta/1",
        since: CONNECTED_AT,
        fetch,
      }),
    ).rejects.toThrow(/delta link/i);
  });

  it("reports what Graph refused", async () => {
    const { fetch } = stubFetch([
      {
        status: 401,
        body: { error: { code: "InvalidAuthenticationToken", message: "expired" } },
      },
    ]);

    await expect(
      fetchMicrosoftNewMessages({
        accessToken: "access-token",
        deltaLink: "https://delta/1",
        since: CONNECTED_AT,
        fetch,
      }),
    ).rejects.toThrow(/InvalidAuthenticationToken/);
  });
});
