"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  approveAndSendDraft,
  discardDraft,
  regenerateDraft,
} from "@correu-agent/shared/drafts";
import { createAnthropicClient } from "@correu-agent/shared/triage";
import { auth } from "../../../auth";
import {
  DASHBOARD_PATH,
  LOGIN_PATH,
  THREADS_PATH,
  threadPath,
} from "../../../lib/routes";
import { db } from "../../../lib/db";
import { createDraftSender } from "../../../lib/mailbox/draft-sender";
import { readReplyAttachments } from "../../../lib/mailbox/reply-attachments";
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
 * user edited it in the form and the files it carried attached. The mailbox it
 * leaves through is read from the draft, never from the submission.
 */
export const approveDraft = async (formData: FormData): Promise<void> => {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const draftId = submittedDraftId(formData.get("draftId"));
  const tenantId = session.user.tenantId;
  // Before the mailbox is opened: a submission carrying more than a reply may
  // attach is refused while the draft is still pending, rather than halfway
  // through a send nobody can tell the outcome of.
  const attachments = await readReplyAttachments(formData.getAll("attachments"));
  const sender = await createDraftSender(db, { tenantId, draftId });

  const sent = await approveAndSendDraft(db, sender, {
    tenantId,
    draftId,
    // From the session, never from the form: the audit entry is only worth
    // anything if it names who really approved the mail (context.md §7).
    actorUserId: session.user.id,
    body: submittedText(formData.get("body"), "body"),
    attachments,
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
