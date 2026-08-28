"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  approveAndSendDraft,
  discardDraft,
  regenerateDraft,
  type ReplyRecipients,
} from "@correu-agent/shared/drafts";
import { parseRecipientField } from "@correu-agent/shared/mail";
import { createAnthropicClient } from "@correu-agent/shared/triage";
import { auth } from "../../../auth";
import {
  DASHBOARD_PATH,
  LOGIN_PATH,
  THREADS_PATH,
  threadPath,
} from "../../../lib/routes";
import { db } from "../../../lib/db";
import { listRecentContacts } from "../../../lib/contacts/recent-contacts";
import { createDraftSender } from "../../../lib/mailbox/draft-sender";
import { isUuid } from "../../../lib/uuid";

/**
 * The draft a submission names. A form field is arbitrary text, and every
 * writer downstream is scoped to the session's tenant, so an id that belongs to
 * nobody simply finds nothing — one that is not an id at all is refused here
 * instead of reaching three queries Postgres would reject as malformed.
 */
const submittedDraftId = (value: FormDataEntryValue | null): string => {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new Error("A draft action needs the draft it acts on.");
  }
  return value;
};

/**
 * What the user wrote in the field. Absent is not empty: a browser submits a
 * textarea it rendered, so a missing field is a hand-crafted POST.
 */
const submittedText = (value: FormDataEntryValue | null, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`A draft action needs its ${field}.`);
  }
  return value;
};

/**
 * The recipients the approval form carried, or `undefined` when it carried
 * none — the send then falls back to the addresses the thread implies, which is
 * the mail the product sent before these fields existed. A field that is there
 * but empty means nobody, and `Per a` empty is refused further down, where the
 * draft is still safely pending.
 */
const submittedRecipients = (formData: FormData): ReplyRecipients | undefined => {
  const toAddresses = formData.get("toAddresses");
  if (typeof toAddresses !== "string") return undefined;

  const field = (value: FormDataEntryValue | null): string =>
    typeof value === "string" ? value : "";

  return {
    toAddresses: parseRecipientField(toAddresses, "Per a"),
    ccAddresses: parseRecipientField(field(formData.get("ccAddresses")), "Cc"),
    bccAddresses: parseRecipientField(field(formData.get("bccAddresses")), "Cco"),
  };
};

/**
 * The screens that show the draft after it moved: the thread itself, the
 * list, and the dashboard home — all three draw the thread's status from the
 * same draft, and the dashboard also offers to discard it inline (`app/page.tsx`).
 * A draft that was already dealt with in another tab reports no thread — only
 * the list and dashboard are refreshed then, which is where the user finds out.
 */
const showDraftAsItStands = (threadId: string | undefined): void => {
  if (threadId !== undefined) revalidatePath(threadPath(threadId));
  revalidatePath(THREADS_PATH);
  revalidatePath(DASHBOARD_PATH);
};

/**
 * Approves the draft and really sends it (context.md §2), with the text as the
 * user edited it in the form. The mailbox it leaves through is read from the
 * draft, never from the submission.
 */
export const approveDraft = async (formData: FormData): Promise<void> => {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const draftId = submittedDraftId(formData.get("draftId"));
  const tenantId = session.user.tenantId;
  // Parsed before the mailbox is reached: a field that names no address is the
  // reviewer's typo, and there is no reason to mint a token to find that out.
  const recipients = submittedRecipients(formData);
  const sender = await createDraftSender(db, { tenantId, draftId });

  const sent = await approveAndSendDraft(db, sender, {
    tenantId,
    draftId,
    // From the session, never from the form: the audit entry is only worth
    // anything if it names who really approved the mail (context.md §7).
    actorUserId: session.user.id,
    body: submittedText(formData.get("body"), "body"),
    ...(recipients ? { recipients } : {}),
  });

  showDraftAsItStands(sent?.threadId);
};

/** Discards the draft: the thread is left without an answer (context.md §2). */
export const rejectDraft = async (formData: FormData): Promise<void> => {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const discarded = await discardDraft(db, {
    tenantId: session.user.tenantId,
    draftId: submittedDraftId(formData.get("draftId")),
    userId: session.user.id,
  });

  showDraftAsItStands(discarded?.threadId);
  // Discarding closes the review: the thread it leaves behind asks nothing
  // more, so the reviewer goes back to the screen listing what still does.
  redirect(DASHBOARD_PATH);
};

/**
 * The instruction that rejects a draft. Regenerating from nothing is the call
 * that wrote the draft the user just turned down, so it is refused here, where
 * the field entered — the writer refuses it too, one model call later.
 */
const submittedFeedback = (value: FormDataEntryValue | null): string => {
  const feedback = submittedText(value, "feedback");
  if (feedback.trim() === "") {
    throw new Error("Regenerating a draft needs the feedback that rejects it.");
  }
  return feedback;
};

/**
 * Rejects the draft and asks Sonnet for another one carrying the instruction
 * the user wrote (context.md §2). The model call happens inside the action, so
 * the user waits on the submission rather than on a job they cannot see.
 */
export const regenerateDraftWithFeedback = async (
  formData: FormData,
): Promise<void> => {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const regenerated = await regenerateDraft(db, createAnthropicClient().messages, {
    tenantId: session.user.tenantId,
    draftId: submittedDraftId(formData.get("draftId")),
    userId: session.user.id,
    feedback: submittedFeedback(formData.get("feedback")),
  });

  showDraftAsItStands(regenerated?.threadId);
};

/**
 * The recent contacts the approval form suggests while the reviewer types in
 * `Per a` / `Cc` / `Cco` (context.md §2). Called from the browser on every few
 * keystrokes, so it answers an empty list rather than redirecting when the
 * session has gone: the field stops suggesting, and the submission is what
 * takes the reviewer back to the login page.
 */
export const suggestRecentContacts = async (query: string): Promise<string[]> => {
  const session = await auth();
  if (!session) return [];

  return listRecentContacts(db, {
    tenantId: session.user.tenantId,
    // Arrives from the client, so it is text of any shape or none.
    query: typeof query === "string" ? query : "",
  });
};
