import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import type { MailSenderClient } from "../mail/types";
import { approveAndSendDraft, sendAutoReplyDraft } from "./send";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const THREAD_ID = "22222222-2222-2222-2222-222222222222";
const DRAFT_ID = "33333333-3333-3333-3333-333333333333";
const SENT_MESSAGE_ID = "44444444-4444-4444-4444-444444444444";
const USER_ID = "55555555-5555-5555-5555-555555555555";

const NOW = new Date("2026-01-02T10:00:00.000Z");

const BODY = "Bon dia,\n\nUs enviem el pressupost.";

/** In the column order the draft select asks for. */
const draftRow = ({
  status = "pending",
  body = BODY,
  parentProviderMessageId = "provider-message-1" as string | null,
  parentFromAddress = "client@example.com" as string | null,
  references = null as string | null,
  threadSubject = "Pressupost" as string | null,
  parentSubject = "Pressupost" as string | null,
  threadCategory = "comercial" as string | null,
} = {}) => [
  status,
  body,
  THREAD_ID,
  threadSubject,
  "provider-thread-1",
  "bustia@example.com",
  parentProviderMessageId,
  "<client@mail.example.com>",
  null,
  references,
  parentFromAddress,
  parentSubject,
  threadCategory,
];

const createSender = (): { sender: MailSenderClient; sendReply: ReturnType<typeof vi.fn> } => {
  const sendReply = vi.fn(async () => ({
    providerMessageId: "provider-sent-1",
    messageIdHeader: "<sent-1@mail.example.com>",
  }));
  return { sender: { sendReply }, sendReply };
};

/**
 * Drizzle's proxy driver builds every statement for real and hands it back
 * instead of reaching Neon, so the test asserts on what would be written.
 */
const createDb = ({
  draft = draftRow() as unknown[] | null,
  claimed = [[DRAFT_ID]] as unknown[][],
  insertedMessages = [[SENT_MESSAGE_ID]] as unknown[][],
  existingMessages = [] as unknown[][],
  rule = [["comercial", true, null]] as unknown[][],
}: {
  draft?: unknown[] | null;
  claimed?: unknown[][];
  insertedMessages?: unknown[][];
  existingMessages?: unknown[][];
  rule?: unknown[][];
} = {}) => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith("select") && sql.includes('from "auto_reply_rules"')) {
      return { rows: rule };
    }
    if (sql.startsWith("select") && sql.includes('from "drafts"')) {
      return { rows: draft ? [draft] : [] };
    }
    if (sql.startsWith('update "drafts"')) return { rows: claimed };
    if (sql.includes('insert into "messages"')) return { rows: insertedMessages };
    if (sql.startsWith("select") && sql.includes('from "messages"')) {
      return { rows: existingMessages };
    }
    return { rows: [] };
  });
  return { db, queries };
};

const auditEntries = (queries: { sql: string; params: unknown[] }[]): unknown[][] =>
  queries
    .filter(({ sql }) => sql.includes('insert into "audit_log_entries"'))
    .map(({ params }) => params);

describe("approveAndSendDraft", () => {
  it("sends the reply inside its thread and marks the draft sent", async () => {
    const { db, queries } = createDb();
    const { sender, sendReply } = createSender();

    const result = await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      now: NOW,
    });

    expect(sendReply).toHaveBeenCalledWith({
      fromAddress: "bustia@example.com",
      toAddresses: ["client@example.com"],
      ccAddresses: [],
      bccAddresses: [],
      subject: "Re: Pressupost",
      bodyText: BODY,
      providerThreadId: "provider-thread-1",
      inReplyToProviderMessageId: "provider-message-1",
      // Threading headers derived from the mail being answered (context.md §4).
      inReplyTo: "<client@mail.example.com>",
      references: "<client@mail.example.com>",
      attachments: [],
    });

    expect(result).toEqual({
      draftId: DRAFT_ID,
      threadId: THREAD_ID,
      sentMessageId: SENT_MESSAGE_ID,
      providerMessageId: "provider-sent-1",
    });

    const updates = queries.filter(({ sql }) => sql.startsWith('update "drafts"'));
    // Approved first — that claim is what makes the send happen once — then sent.
    expect(updates[0]!.params).toContain("approved");
    expect(updates[1]!.params).toContain("sent");
    expect(updates[1]!.params).toContain(SENT_MESSAGE_ID);

    // The reply is stored as outbound mail of the thread, so the next drafting
    // tick sees the thread as answered.
    const storedMessage = queries.find(({ sql }) =>
      sql.includes('insert into "messages"'),
    )!;
    expect(storedMessage.params).toContain("outbound");
    expect(storedMessage.params).toContain("provider-sent-1");
    expect(storedMessage.params).toContain("<sent-1@mail.example.com>");
    expect(storedMessage.params).toContain(BODY);

    const audits = auditEntries(queries);
    expect(audits.map((params) => params[3])).toEqual([
      "draft_approved",
      "draft_sent",
    ]);
    // The audit trail names the user who approved it (context.md §7).
    expect(audits[0]).toContain(USER_ID);
    expect(audits[1]!.join(" ")).toContain(SENT_MESSAGE_ID);
  });

  it("sends the files the approval carried and names them in the trail", async () => {
    const { db, queries } = createDb();
    const { sender, sendReply } = createSender();
    const attachments = [
      {
        filename: "pressupost.pdf",
        mimeType: "application/pdf",
        content: Buffer.from("%PDF-1.4 pressupost"),
      },
    ];

    await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      attachments,
      now: NOW,
    });

    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
    // The files are not stored anywhere, so the trail keeping their names is
    // the only record of what left the mailbox with the reply (context.md §7).
    const sent = auditEntries(queries)[1]!.join(" ");
    expect(sent).toContain("pressupost.pdf");
  });

  it("moves the thread's clock so a replied thread does not sink in the list", async () => {
    const { db, queries } = createDb();
    const { sender } = createSender();

    await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      now: NOW,
    });

    const bump = queries.find(({ sql }) => sql.startsWith('update "threads"'))!;
    // `greatest`, so mail polled out of order cannot pull the clock backwards.
    expect(bump.sql).toContain("greatest");
    expect(bump.params).toContain(THREAD_ID);
  });

  it("sends the text the user edited and records the edit", async () => {
    const { db, queries } = createDb();
    const { sender, sendReply } = createSender();
    const edited = "Bon dia,\n\nUs enviem el pressupost revisat.";

    await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      body: edited,
      now: NOW,
    });

    expect(sendReply.mock.calls[0]![0].bodyText).toBe(edited);
    // The draft stored is the mail that really left, not the model's version.
    const claim = queries.find(({ sql }) => sql.startsWith('update "drafts"'))!;
    expect(claim.params).toContain(edited);

    // The trail keeps both sides of the rewrite, JSON-encoded in the metadata.
    const approved = auditEntries(queries)[0]!.join(" ");
    expect(approved).toContain(JSON.stringify(BODY).slice(1, -1));
    expect(approved).toContain(JSON.stringify(edited).slice(1, -1));
  });

  it("sends to the recipients the reviewer approved and stores them", async () => {
    const { db, queries } = createDb();
    const { sender, sendReply } = createSender();

    await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      recipients: {
        toAddresses: ["client@example.com", "segon@example.com"],
        ccAddresses: ["copia@example.com"],
        bccAddresses: ["arxiu@example.com"],
      },
      now: NOW,
    });

    expect(sendReply.mock.calls[0]![0]).toMatchObject({
      toAddresses: ["client@example.com", "segon@example.com"],
      ccAddresses: ["copia@example.com"],
      bccAddresses: ["arxiu@example.com"],
    });

    // Stored on the draft, so the trail says who the mail went to and not only
    // what it said (context.md §7) — blind copies included, since nothing else
    // records them.
    const claim = queries.find(({ sql }) => sql.startsWith('update "drafts"'))!;
    expect(claim.params).toContain(
      '{"client@example.com","segon@example.com"}',
    );
    expect(claim.params).toContain('{"copia@example.com"}');
    expect(claim.params).toContain('{"arxiu@example.com"}');

    // The mail stored as the thread's outbound message carries the visible
    // recipients; a blind copy is not disclosed there either.
    const storedMessage = queries.find(({ sql }) =>
      sql.includes('insert into "messages"'),
    )!;
    expect(storedMessage.params).toContain('{"copia@example.com"}');
    expect(storedMessage.params).not.toContain('{"arxiu@example.com"}');
  });

  it("refuses to send a reply the reviewer left with no recipient", async () => {
    const { db, queries } = createDb();
    const { sender, sendReply } = createSender();

    await expect(
      approveAndSendDraft(db, sender, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        actorUserId: USER_ID,
        recipients: { toAddresses: [], ccAddresses: [], bccAddresses: [] },
        now: NOW,
      }),
    ).rejects.toThrow(/no recipient/);

    expect(sendReply).not.toHaveBeenCalled();
    // Refused before the claim, so the draft is still there to be approved.
    expect(queries.filter(({ sql }) => sql.startsWith('update "drafts"'))).toHaveLength(0);
  });

  it("does not send a draft that is no longer pending", async () => {
    const { db, queries } = createDb({ draft: draftRow({ status: "sent" }) });
    const { sender, sendReply } = createSender();

    const result = await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      now: NOW,
    });

    expect(result).toBeNull();
    expect(sendReply).not.toHaveBeenCalled();
    expect(queries.map(({ sql }) => sql)).toHaveLength(1);
  });

  it("does not send when another approval claimed the draft first", async () => {
    const { db, queries } = createDb({ claimed: [] });
    const { sender, sendReply } = createSender();

    const result = await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      now: NOW,
    });

    expect(result).toBeNull();
    // Two clicks on the same draft must not put two mails in the client's inbox.
    expect(sendReply).not.toHaveBeenCalled();
    expect(auditEntries(queries)).toHaveLength(0);
  });

  it("refuses to send a draft whose message to reply to is gone", async () => {
    const { db } = createDb({ draft: draftRow({ parentProviderMessageId: null }) });
    const { sender, sendReply } = createSender();

    await expect(
      approveAndSendDraft(db, sender, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        actorUserId: USER_ID,
        now: NOW,
      }),
    ).rejects.toThrow(/no message to reply to/);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("takes the subject from the mail being answered when the thread has none", async () => {
    const { db } = createDb({ draft: draftRow({ threadSubject: "" }) });
    const { sender, sendReply } = createSender();

    await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      now: NOW,
    });

    expect(sendReply.mock.calls[0]![0].subject).toBe("Re: Pressupost");
  });

  it("answers mail that arrived without a subject without one", async () => {
    const { db } = createDb({
      draft: draftRow({ threadSubject: null, parentSubject: null }),
    });
    const { sender, sendReply } = createSender();

    await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      now: NOW,
    });

    expect(sendReply.mock.calls[0]![0].subject).toBe("");
  });

  it("refuses to send an empty reply the user blanked out", async () => {
    const { db } = createDb();
    const { sender, sendReply } = createSender();

    await expect(
      approveAndSendDraft(db, sender, {
        tenantId: TENANT_ID,
        draftId: DRAFT_ID,
        actorUserId: USER_ID,
        body: "   \n  ",
        now: NOW,
      }),
    ).rejects.toThrow(/empty body/);
    // Refused before the claim, so the draft stays pending and editable.
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("reuses the row a poll already stored for the mail it just sent", async () => {
    const { db, queries } = createDb({
      insertedMessages: [],
      existingMessages: [[SENT_MESSAGE_ID]],
    });
    const { sender } = createSender();

    const result = await approveAndSendDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      actorUserId: USER_ID,
      now: NOW,
    });

    expect(result?.sentMessageId).toBe(SENT_MESSAGE_ID);
    expect(
      queries.filter(({ sql }) => sql.startsWith('update "drafts"'))[1]!.params,
    ).toContain(SENT_MESSAGE_ID);
  });
});

describe("sendAutoReplyDraft", () => {
  it("sends the draft with nobody approving it and audits the auto-reply", async () => {
    const { db, queries } = createDb();
    const { sender, sendReply } = createSender();

    const result = await sendAutoReplyDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      now: NOW,
    });

    expect(result).toEqual({
      draftId: DRAFT_ID,
      threadId: THREAD_ID,
      sentMessageId: SENT_MESSAGE_ID,
      providerMessageId: "provider-sent-1",
    });
    // The same send path as an approval: reply inside the thread, from the
    // mailbox, to whoever wrote (context.md §2).
    expect(sendReply.mock.calls[0]![0]).toMatchObject({
      fromAddress: "bustia@example.com",
      toAddresses: ["client@example.com"],
      subject: "Re: Pressupost",
      bodyText: BODY,
      providerThreadId: "provider-thread-1",
    });

    const audits = auditEntries(queries);
    // No approval entry: nobody approved it, and the trail must not read as if
    // somebody had (context.md §7).
    expect(audits.map((params) => params[3])).toEqual(["auto_reply_sent"]);
    expect(audits[0]).toContain("system");
    expect(audits[0]!.join(" ")).toContain("comercial");
    expect(audits[0]!.join(" ")).toContain(SENT_MESSAGE_ID);

    const updates = queries.filter(({ sql }) => sql.startsWith('update "drafts"'));
    expect(updates[1]!.params).toContain("sent");
    expect(updates[1]!.params).toContain(SENT_MESSAGE_ID);
  });

  it("does not send a thread whose category can never be auto-replied to", async () => {
    const { db, queries } = createDb({
      draft: draftRow({ threadCategory: "urgent" }),
    });
    const { sender, sendReply } = createSender();

    const result = await sendAutoReplyDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      now: NOW,
    });

    expect(result).toBeNull();
    expect(sendReply).not.toHaveBeenCalled();
    // Refused without even reading the rules table: a row planted there must
    // not be able to answer urgent mail (context.md §2).
    expect(
      queries.some(({ sql }) => sql.includes('from "auto_reply_rules"')),
    ).toBe(false);
  });

  it("does not send a thread triage has not reached yet", async () => {
    const { db, queries } = createDb({ draft: draftRow({ threadCategory: null }) });
    const { sender, sendReply } = createSender();

    const result = await sendAutoReplyDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      now: NOW,
    });

    expect(result).toBeNull();
    expect(sendReply).not.toHaveBeenCalled();
    // No category means no rule could have asked for this one (context.md §4).
    expect(
      queries.some(({ sql }) => sql.includes('from "auto_reply_rules"')),
    ).toBe(false);
  });

  it("does not send when the rule was switched off after the draft was written", async () => {
    const { db } = createDb({ rule: [] });
    const { sender, sendReply } = createSender();

    const result = await sendAutoReplyDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      now: NOW,
    });

    expect(result).toBeNull();
    // The draft stays pending, so the dashboard can still approve it by hand.
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("does not send a draft that is no longer pending", async () => {
    const { db } = createDb({ draft: draftRow({ status: "discarded" }) });
    const { sender, sendReply } = createSender();

    const result = await sendAutoReplyDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      now: NOW,
    });

    expect(result).toBeNull();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("does not send when an approval claimed the draft first", async () => {
    const { db, queries } = createDb({ claimed: [] });
    const { sender, sendReply } = createSender();

    const result = await sendAutoReplyDraft(db, sender, {
      tenantId: TENANT_ID,
      draftId: DRAFT_ID,
      now: NOW,
    });

    expect(result).toBeNull();
    expect(sendReply).not.toHaveBeenCalled();
    expect(auditEntries(queries)).toHaveLength(0);
  });
});
