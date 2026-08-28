// Drives the attachment route the way a browser does, with `../../../../auth`
// and the download stubbed so no database and no mailbox are needed.

import type { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_TENANT_ID } from "../../../../lib/auth/test-fixtures";
import type { AttachmentDownload } from "../../../../lib/mailbox/attachment-download";

const auth = vi.fn<() => Promise<Session | null>>(async () => null);
const downloadAttachment = vi.fn<() => Promise<AttachmentDownload | null>>();

vi.mock("../../../../auth", () => ({ auth }));
vi.mock("../../../../lib/db", () => ({ db: {} }));
vi.mock("../../../../lib/mailbox/attachment-download", () => ({
  downloadAttachment,
}));

const { GET } = await import("./route");

const ATTACHMENT_ID = "88888888-8888-8888-8888-888888888888";

const request = (query = ""): NextRequest =>
  new Request(`https://tauler.example/api/adjunts/${ATTACHMENT_ID}${query}`) as NextRequest;

const get = (query = "") =>
  GET(request(query), { params: Promise.resolve({ id: ATTACHMENT_ID }) });

const signedIn = (): void => {
  auth.mockResolvedValue({
    user: {
      id: "33333333-3333-3333-3333-333333333333",
      tenantId: TEST_TENANT_ID,
      email: "aleix@example.com",
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  });
};

const served = (
  overrides: Partial<AttachmentDownload> = {},
): AttachmentDownload => ({
  filename: "pressupost.pdf",
  mimeType: "application/pdf",
  bytes: new TextEncoder().encode("PDF"),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue(null);
});

describe("GET /api/adjunts/[id]", () => {
  it("turns away a request without a session before reading anything", async () => {
    const response = await get();

    expect(response.status).toBe(401);
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it("serves a previewable attachment for the dashboard to show", async () => {
    signedIn();
    downloadAttachment.mockResolvedValue(served());

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("PDF");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("content-disposition")).toContain(
      'filename="pressupost.pdf"',
    );
    // Mail from a stranger is served by the dashboard's own origin: the browser
    // must not sniff it into something it can run, nor keep it on disk.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
    // No `sandbox` here on purpose: it stops the browser's own PDF viewer from
    // loading, and what is served inline is inert by the type allowlist.
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(downloadAttachment).toHaveBeenCalledWith(
      {},
      { tenantId: TEST_TENANT_ID, attachmentId: ATTACHMENT_ID },
    );
  });

  it("hands over a download when the reader asked to save it", async () => {
    signedIn();
    downloadAttachment.mockResolvedValue(served());

    const response = await get("?descarrega=1");

    expect(response.headers.get("content-disposition")).toContain("attachment");
  });

  // A sender chooses the type of what they attach: served inline from this
  // origin, an HTML "attachment" would run with the reader's session.
  it("never offers to show a type the browser would run", async () => {
    signedIn();
    downloadAttachment.mockResolvedValue(
      served({ filename: "factura.html", mimeType: "text/html" }),
    );

    const response = await get();

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    // Opaque and sandboxed: a browser that ignored the disposition still could
    // not run it with the reader's session.
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("spells a filename the header cannot carry as it is", async () => {
    signedIn();
    downloadAttachment.mockResolvedValue(served({ filename: 'adjunció "cançó".pdf' }));

    const disposition = (await get()).headers.get("content-disposition") ?? "";

    // The plain parameter is left with an ASCII name and no stray quote; the
    // real one travels in the RFC 5987 form next to it.
    expect(disposition).toContain('filename="adjuncio _canco_.pdf"');
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent('adjunció "cançó".pdf')}`,
    );
  });

  it("answers 404 when there is nothing to serve", async () => {
    signedIn();
    downloadAttachment.mockResolvedValue(null);

    expect((await get()).status).toBe(404);
  });
});
