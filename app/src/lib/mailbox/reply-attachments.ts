// The files the approval form carried, turned into what a provider is handed
// (context.md §2). Nothing is stored: they live from the submission until the
// mail has left, and the browser is asked to upload them again if the user
// approves a second draft.

import type { ReplyAttachment } from "@correu-agent/shared/mail";

/**
 * How much a reply may carry, over every file it attaches.
 *
 * The tighter of the two providers: Gmail caps the whole message near 25 MB,
 * while Graph refuses a file posted in one request past about 3 MB and wants an
 * upload session instead. Approving a draft has to behave the same whichever
 * mailbox it leaves through, so the limit is Graph's.
 */
export const MAX_ATTACHMENTS_BYTES = 3 * 1024 * 1024;

/** The same limit as the form says it out loud. */
export const MAX_ATTACHMENTS_LABEL = "3 MB";

/** What is not a file the user picked: a browser posts an empty part for an untouched input. */
const isPickedFile = (value: FormDataEntryValue): value is File =>
  value instanceof File && value.size > 0;

/**
 * The files a submission attached. The limit is enforced here as well as in the
 * form: the form is the courtesy, this is the one a hand-crafted POST also
 * meets — and a reply the provider refuses mid-send is worse than one refused
 * before the draft is claimed.
 */
export const readReplyAttachments = async (
  values: FormDataEntryValue[],
): Promise<ReplyAttachment[]> => {
  const files = values.filter(isPickedFile);

  const total = files.reduce((bytes, file) => bytes + file.size, 0);
  if (total > MAX_ATTACHMENTS_BYTES) {
    throw new Error(
      `A reply cannot carry more than ${MAX_ATTACHMENTS_LABEL} of attachments.`,
    );
  }

  return Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      // A browser leaves the type empty for a file it cannot place; the mail
      // then says the bytes are unspecified rather than claiming a type.
      mimeType: file.type === "" ? "application/octet-stream" : file.type,
      content: new Uint8Array(await file.arrayBuffer()),
    })),
  );
};
