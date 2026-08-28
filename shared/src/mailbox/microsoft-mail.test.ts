import { describe, expect, it } from "vitest";
import {
  createMicrosoftAttachmentReader,
  createMicrosoftSender,
  fetchMicrosoftNewMessages,
} from "./microsoft-mail";
import type { ReplyAttachment } from "../mail/types";

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
  hasAttachments: false,
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
          attachments: [],
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

const outgoingReply = (overrides: Record<string, unknown> = {}) => ({
  attachments: [] as ReplyAttachment[],
  fromAddress: "bustia@example.com",
  toAddresses: ["client@example.com"],
  ccAddresses: [] as string[],
  subject: "Re: Pressupost",
  bodyText: "Bon dia,\n\nUs enviem el pressupost.",
  providerThreadId: "conversation-1",
  inReplyToProviderMessageId: "message-1",
  inReplyTo: "<message-1@example.com>",
  references: "<message-1@example.com>",
  ...overrides,
});

describe("createMicrosoftSender", () => {
  it("replies from the message being answered so the mail stays in the conversation", async () => {
    const { fetch, calls } = stubFetch([
      {
        body: {
          id: "reply-draft-1",
          internetMessageId: "<reply-1@example.com>",
        },
      },
      { status: 202, body: undefined },
    ]);

    const result = await createMicrosoftSender({
      accessToken: "access-token",
      fetch,
    }).sendReply(outgoingReply());

    expect(calls[0]!.url).toContain("/me/messages/message-1/createReply");
    expect(await calls[0]!.json()).toEqual({
      message: {
        subject: "Re: Pressupost",
        toRecipients: [{ emailAddress: { address: "client@example.com" } }],
        ccRecipients: [],
        body: {
          contentType: "Text",
          content: "Bon dia,\n\nUs enviem el pressupost.",
        },
      },
    });
    // Graph creates the reply as a draft; a second call is what sends it.
    expect(calls[1]!.url).toContain("/me/messages/reply-draft-1/send");
    expect(calls[1]!.method).toBe("POST");
    expect(result).toEqual({
      providerMessageId: "reply-draft-1",
      messageIdHeader: "<reply-1@example.com>",
    });
  });

  it("attaches every file to the reply draft before sending it", async () => {
    const { fetch, calls } = stubFetch([
      { body: { id: "reply-draft-1", internetMessageId: "<reply-1@example.com>" } },
      { body: { id: "attachment-1" } },
      { body: { id: "attachment-2" } },
      { status: 202, body: undefined },
    ]);

    await createMicrosoftSender({ accessToken: "access-token", fetch }).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: "pressupost.pdf",
            mimeType: "application/pdf",
            content: Buffer.from("%PDF-1.4 pressupost"),
          },
          {
            filename: "condicions.txt",
            mimeType: "text/plain",
            content: Buffer.from("condicions"),
          },
        ],
      }),
    );

    // Graph builds the MIME itself, so the file travels as base64 in the
    // attachment resource rather than as a part written by hand.
    expect(calls[1]!.url).toContain("/me/messages/reply-draft-1/attachments");
    expect(await calls[1]!.json()).toEqual({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "pressupost.pdf",
      contentType: "application/pdf",
      contentBytes: Buffer.from("%PDF-1.4 pressupost").toString("base64"),
    });
    expect(await calls[2]!.json()).toEqual({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "condicions.txt",
      contentType: "text/plain",
      contentBytes: Buffer.from("condicions").toString("base64"),
    });
    // The files are on the draft before it leaves: a send in between would post
    // the reply without them.
    expect(calls[3]!.url).toContain("/me/messages/reply-draft-1/send");
  });

  // Graph is handed the type in JSON rather than in a header it writes, but it
  // is still what the browser reported: the file has to arrive as the same type
  // it would through Gmail, and a string Graph refuses would fail the send with
  // the draft already claimed.
  it("hands Graph the same media type the Gmail side would write", async () => {
    const { fetch, calls } = stubFetch([
      { body: { id: "reply-draft-1" } },
      { body: { id: "attachment-1" } },
      { status: 202, body: undefined },
    ]);

    await createMicrosoftSender({ accessToken: "access-token", fetch }).sendReply(
      outgoingReply({
        attachments: [
          {
            filename: "condicions.txt",
            mimeType: "text/plain;charset=utf-8",
            content: Buffer.from("condicions"),
          },
        ],
      }),
    );

    expect(await calls[1]!.json()).toMatchObject({ contentType: "text/plain" });
  });

  // A half-attached reply must not go out: the recipient would get a mail that
  // refers to a file that is not there.
  it("does not send the reply when a file cannot be attached", async () => {
    const { fetch, calls } = stubFetch([
      { body: { id: "reply-draft-1" } },
      {
        status: 413,
        body: { error: { code: "ErrorMessageSizeExceeded", message: "Too large." } },
      },
    ]);

    await expect(
      createMicrosoftSender({ accessToken: "access-token", fetch }).sendReply(
        outgoingReply({
          attachments: [
            {
              filename: "pressupost.pdf",
              mimeType: "application/pdf",
              content: Buffer.from("%PDF-1.4 pressupost"),
            },
          ],
        }),
      ),
    ).rejects.toThrow(/ErrorMessageSizeExceeded/);

    expect(calls).toHaveLength(2);
  });

  it("fails loudly when Graph refuses to create the reply", async () => {
    const { fetch } = stubFetch([
      {
        status: 403,
        body: { error: { code: "ErrorAccessDenied", message: "Access is denied." } },
      },
    ]);

    await expect(
      createMicrosoftSender({ accessToken: "access-token", fetch }).sendReply(
        outgoingReply(),
      ),
    ).rejects.toThrow(/ErrorAccessDenied/);
  });
});

describe("fetchMicrosoftNewMessages attachments", () => {
  const fileAttachment = (overrides: Record<string, unknown> = {}) => ({
    "@odata.type": "#microsoft.graph.fileAttachment",
    id: "attachment-1",
    name: "pressupost.pdf",
    contentType: "application/pdf",
    size: 20480,
    isInline: false,
    ...overrides,
  });

  it("lists the attachments of a message that has them", async () => {
    const { fetch, calls } = stubFetch([
      {
        body: {
          value: [graphMessage({ hasAttachments: true })],
          "@odata.deltaLink": "https://delta/2",
        },
      },
      { body: { value: [fileAttachment()] } },
    ]);

    const sync = await fetchMicrosoftNewMessages({
      accessToken: "access-token",
      deltaLink: "https://delta/1",
      since: CONNECTED_AT,
      fetch,
    });

    expect(sync.messages[0]!.attachments).toEqual([
      {
        providerAttachmentId: "attachment-1",
        filename: "pressupost.pdf",
        mimeType: "application/pdf",
        sizeBytes: 20480,
        inline: false,
      },
    ]);
    // Metadata only: the bytes are fetched when the dashboard asks for them.
    expect(calls[1]!.url).toContain("/me/messages/message-1/attachments");
    expect(decodeURIComponent(calls[1]!.url)).toContain("id,name,contentType,size,isInline");
  });

  it("does not ask for the attachments of a message without any", async () => {
    const { fetch, calls } = stubFetch([
      {
        body: {
          value: [graphMessage({ hasAttachments: false })],
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

    expect(sync.messages[0]!.attachments).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  // A delta link keeps the projection it was minted with, so a mailbox
  // connected before `hasAttachments` was selected answers without the field
  // for as long as that link lives. Reading that silence as "no files" would
  // leave such a mailbox listing no attachment ever, and never fail.
  it("asks anyway when the page does not say whether there are attachments", async () => {
    const message: Record<string, unknown> = graphMessage();
    delete message.hasAttachments;
    const { fetch, calls } = stubFetch([
      { body: { value: [message], "@odata.deltaLink": "https://delta/2" } },
      { body: { value: [fileAttachment()] } },
    ]);

    const sync = await fetchMicrosoftNewMessages({
      accessToken: "access-token",
      deltaLink: "https://delta/1",
      since: CONNECTED_AT,
      fetch,
    });

    expect(sync.messages[0]!.attachments).toHaveLength(1);
    expect(calls[1]!.url).toContain("/me/messages/message-1/attachments");
  });

  it("keeps only the attachments whose bytes Graph can serve", async () => {
    const { fetch } = stubFetch([
      {
        body: {
          value: [graphMessage({ hasAttachments: true })],
          "@odata.deltaLink": "https://delta/2",
        },
      },
      {
        body: {
          value: [
            fileAttachment({
              id: "inline-1",
              name: "signatura.png",
              contentType: "image/png",
              size: 900,
              isInline: true,
            }),
            // A link to a file in OneDrive, not a file: there is nothing to download.
            {
              "@odata.type": "#microsoft.graph.referenceAttachment",
              id: "reference-1",
              name: "carpeta compartida",
              contentType: null,
              size: 0,
            },
          ],
        },
      },
    ]);

    const sync = await fetchMicrosoftNewMessages({
      accessToken: "access-token",
      deltaLink: "https://delta/1",
      since: CONNECTED_AT,
      fetch,
    });

    expect(sync.messages[0]!.attachments).toEqual([
      {
        providerAttachmentId: "inline-1",
        filename: "signatura.png",
        mimeType: "image/png",
        sizeBytes: 900,
        inline: true,
      },
    ]);
  });
});

describe("createMicrosoftAttachmentReader", () => {
  const binaryFetch = (
    status: number,
    body: string,
  ): { fetch: typeof globalThis.fetch; calls: string[] } => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(new Request(input as RequestInfo).url);
      return new Response(status === 204 ? null : body, { status });
    };
    return { fetch, calls };
  };

  it("returns the bytes Graph serves for the attachment", async () => {
    const { fetch, calls } = binaryFetch(200, "hola!");

    const bytes = await createMicrosoftAttachmentReader({
      accessToken: "access-token",
      fetch,
    }).fetchAttachment({
      providerMessageId: "message-1",
      providerAttachmentId: "attachment-1",
    });

    expect(Buffer.from(bytes!).toString("utf8")).toBe("hola!");
    expect(calls[0]).toContain("/me/messages/message-1/attachments/attachment-1/$value");
  });

  it("returns null when the mail it belonged to is gone", async () => {
    const { fetch } = binaryFetch(404, JSON.stringify({ error: { code: "ErrorItemNotFound" } }));

    const bytes = await createMicrosoftAttachmentReader({
      accessToken: "access-token",
      fetch,
    }).fetchAttachment({
      providerMessageId: "message-1",
      providerAttachmentId: "attachment-1",
    });

    expect(bytes).toBeNull();
  });

  it("surfaces a refusal that is not a missing mail", async () => {
    const { fetch } = binaryFetch(403, JSON.stringify({ error: { code: "ErrorAccessDenied" } }));

    await expect(
      createMicrosoftAttachmentReader({ accessToken: "access-token", fetch }).fetchAttachment({
        providerMessageId: "message-1",
        providerAttachmentId: "attachment-1",
      }),
    ).rejects.toThrow(/ErrorAccessDenied/);
  });
});
