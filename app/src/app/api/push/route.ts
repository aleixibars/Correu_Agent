// Where the dashboard registers (and drops) a browser for Urgent notifications
// (context.md §5). Thin on purpose: validation and the writes live in
// `@correu-agent/shared/web-push`.

import { NextResponse, type NextRequest } from "next/server";
import {
  deletePushSubscription,
  parsePushSubscription,
  savePushSubscription,
} from "@correu-agent/shared/web-push";
import { auth } from "../../../auth";
import { db } from "../../../lib/db";

// Built per request rather than once at module load: a response body is a
// stream that is consumed when it is sent, so a single shared instance answers
// the first caller and is already drained for every one after it.
const unauthorised = (): NextResponse =>
  NextResponse.json({ error: "Cal iniciar la sessió." }, { status: 401 });

const invalid = (): NextResponse =>
  NextResponse.json(
    { error: "La subscripció de notificacions no és vàlida." },
    { status: 400 },
  );

const readJson = async (request: NextRequest): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const session = await auth();
  if (!session) return unauthorised();

  let subscription;
  try {
    subscription = parsePushSubscription(await readJson(request));
  } catch {
    return invalid();
  }

  await savePushSubscription(db, {
    tenantId: session.user.tenantId,
    userId: session.user.id,
    subscription,
  });
  return new NextResponse(null, { status: 204 });
};

export const DELETE = async (request: NextRequest): Promise<NextResponse> => {
  const session = await auth();
  if (!session) return unauthorised();

  const body = await readJson(request);
  const endpoint =
    typeof body === "object" && body !== null
      ? (body as { endpoint?: unknown }).endpoint
      : undefined;
  if (typeof endpoint !== "string" || endpoint.trim() === "") return invalid();

  // Tenant-scoped: an endpoint is unguessable, but the delete still must not be
  // able to reach another tenant's row.
  await deletePushSubscription(db, {
    tenantId: session.user.tenantId,
    endpoint: endpoint.trim(),
  });
  return new NextResponse(null, { status: 204 });
};
