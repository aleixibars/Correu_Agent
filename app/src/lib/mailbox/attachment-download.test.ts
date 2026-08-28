// Serveix un adjunt tal com ho fa una petició del navegador: la consulta es
// construeix de debò contra el driver de proxy de Drizzle i el proveïdor
// respon amb un fetch simulat, així que no cal ni base de dades ni bústia.

import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "@correu-agent/shared/token-encryption";
import { downloadAttachment } from "./attachment-download";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT_ID = "99999999-9999-9999-9999-999999999999";
const ATTACHMENT_ID = "88888888-8888-8888-8888-888888888888";

const KEY = Buffer.alloc(32, 7);

const ENV = {
  TOKEN_ENCRYPTION_KEY: KEY.toString("base64"),
  AUTH_GOOGLE_ID: "google-client-id",
  AUTH_GOOGLE_SECRET: "google-client-secret",
};

const NOW = new Date("2026-08-18T10:00:00.000Z");

const recordingDatabase = (results: unknown[][][]) => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    return { rows: results[statements.length - 1] ?? [] };
  });
  return { db, statements };
};

/** In the column order the attachment select asks for. */
const attachmentRow = ({
  provider = "google",
  mimeType = "application/pdf" as string | null,
}: { provider?: string; mimeType?: string | null } = {}): unknown[] => [
  "pressupost.pdf",
  mimeType,
  "att-1",
  "gmail-message-1",
  "33333333-3333-3333-3333-333333333333",
  provider,
  "bustia@example.com",
  encryptToken("stored-access-token", KEY),
  encryptToken("stored-refresh-token", KEY),
  "2026-08-18 11:00:00+00",
];

const globalFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
  globalFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const download = (
  db: ReturnType<typeof recordingDatabase>["db"],
  attachmentId = ATTACHMENT_ID,
  tenantId = TENANT_ID,
) =>
  downloadAttachment(
    db,
    { tenantId, attachmentId },
    { env: ENV, now: () => NOW },
  );

describe("downloadAttachment", () => {
  it("fetches the bytes from the provider with the mailbox's token", async () => {
    const { db, statements } = recordingDatabase([[attachmentRow()]]);
    globalFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ data: Buffer.from("PDF", "utf8").toString("base64url") }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const attachment = await download(db);

    expect(attachment).toMatchObject({
      filename: "pressupost.pdf",
      mimeType: "application/pdf",
    });
    expect(Buffer.from(attachment!.bytes).toString("utf8")).toBe("PDF");

    const [request] = globalFetch.mock.calls[0]!;
    expect(String(request)).toContain(
      "/messages/gmail-message-1/attachments/att-1",
    );
    // Nothing is stored: one read of the metadata, and no write at all.
    expect(statements).toHaveLength(1);
    expect(statements[0]!.params).toContain(TENANT_ID);
  });

  // The attachment id is a URL segment, so it is arbitrary input: another
  // tenant's file has to read as missing rather than as downloadable.
  it("answers with null for an attachment that is not the tenant's", async () => {
    const { db } = recordingDatabase([[]]);

    expect(await download(db, ATTACHMENT_ID, OTHER_TENANT_ID)).toBeNull();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("answers with null for an id no attachment could have", async () => {
    const { db, statements } = recordingDatabase([[attachmentRow()]]);

    expect(await download(db, "no-un-adjunt")).toBeNull();
    expect(statements).toHaveLength(0);
  });

  // The metadata outlives the mail it describes: the provider is the only one
  // that knows whether the bytes are still there.
  it("answers with null when the provider no longer holds the file", async () => {
    const { db } = recordingDatabase([[attachmentRow()]]);
    globalFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(await download(db)).toBeNull();
  });
});
