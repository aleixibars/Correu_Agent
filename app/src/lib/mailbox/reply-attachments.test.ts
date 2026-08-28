// The file part of an approval submission, read the way the Server Action reads
// it: `FormData` entries in, what the provider is handed out.

import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS_BYTES,
  readReplyAttachments,
} from "./reply-attachments";

const file = (name: string, content: string, type = "application/pdf"): File =>
  new File([content], name, { type });

describe("readReplyAttachments", () => {
  it("hands over every picked file with its name, type and bytes", async () => {
    const attachments = await readReplyAttachments([
      file("pressupost.pdf", "%PDF-1.4"),
      file("condicions.txt", "condicions", "text/plain"),
    ]);

    expect(attachments).toEqual([
      {
        filename: "pressupost.pdf",
        mimeType: "application/pdf",
        content: new Uint8Array(Buffer.from("%PDF-1.4")),
      },
      {
        filename: "condicions.txt",
        mimeType: "text/plain",
        content: new Uint8Array(Buffer.from("condicions")),
      },
    ]);
  });

  // A browser posts an empty part for a file input nobody touched, so an
  // approval with nothing attached must not send an empty file.
  it("ignores the empty part an untouched file input submits", async () => {
    expect(
      await readReplyAttachments([new File([], "", { type: "application/octet-stream" })]),
    ).toEqual([]);
  });

  // A submission is arbitrary form data, and only a real file has bytes to send.
  it("ignores an entry that is not a file", async () => {
    expect(await readReplyAttachments(["pressupost.pdf"])).toEqual([]);
  });

  it("says the bytes are unspecified when the browser reports no type", async () => {
    const [attachment] = await readReplyAttachments([
      new File(["dades"], "dades.bin"),
    ]);

    expect(attachment?.mimeType).toBe("application/octet-stream");
  });

  // The form stops it first, but a hand-crafted POST does not go through the
  // form — and a message the provider refuses mid-send leaves a draft approved
  // with no mail out.
  it("refuses more bytes than a reply may carry", async () => {
    const half = "a".repeat(MAX_ATTACHMENTS_BYTES / 2 + 1);

    await expect(
      readReplyAttachments([file("un.pdf", half), file("dos.pdf", half)]),
    ).rejects.toThrow(/3 MB/);
  });

  it("accepts a reply carrying exactly the limit", async () => {
    const attachments = await readReplyAttachments([
      file("just.pdf", "a".repeat(MAX_ATTACHMENTS_BYTES)),
    ]);

    expect(attachments[0]?.content.byteLength).toBe(MAX_ATTACHMENTS_BYTES);
  });
});
