import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { auth, signOut } from "../auth";
import { DIGEST_PATH, LOGIN_PATH, THREADS_PATH } from "../lib/auth/config";
import {
  MAILBOX_REASON_PARAM,
  MAILBOX_STATUS_PARAM,
  mailboxConnectionNotice,
} from "../lib/mailbox/connect-messages";
import { GOOGLE_CONNECT_PATH } from "../lib/mailbox/google-oauth";
import { MICROSOFT_MAILBOX_CONNECT_PATH } from "../lib/mailbox/microsoft";

export default async function HomePage({
  searchParams,
}: {
  // The mailbox callbacks redirect here with the outcome of the connection.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();

  if (!session) {
    return (
      <main>
        <h1>{APP_NAME}</h1>
        <p>
          <Link href={LOGIN_PATH}>Inicia la sessió</Link> per accedir al tauler.
        </p>
      </main>
    );
  }

  const query = await searchParams;
  const notice = mailboxConnectionNotice(
    query[MAILBOX_STATUS_PARAM],
    query[MAILBOX_REASON_PARAM],
  );

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>Sessió iniciada com a {session.user.email}. Tauler en construcció.</p>
      <p>
        <Link href={THREADS_PATH}>Fils processats</Link>
      </p>
      <p>
        <Link href={DIGEST_PATH}>Digest diari</Link>
      </p>
      {notice !== null && (
        <p role={notice.ok ? "status" : "alert"}>{notice.text}</p>
      )}
      <p>
        {/* Plain anchors, not `next/link`: the targets are route handlers that
            redirect off-site to the provider, and a client-side navigation
            would run them twice — once for the RSC fetch that cannot follow the
            cross-origin redirect, once for the hard navigation that replaces
            it. */}
        <a href={GOOGLE_CONNECT_PATH}>Connecta una bústia de Gmail</a>
      </p>
      <p>
        <a href={MICROSOFT_MAILBOX_CONNECT_PATH}>
          Connecta una bústia de Microsoft 365/Outlook
        </a>
      </p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: LOGIN_PATH });
        }}
      >
        <button type="submit">Tanca la sessió</button>
      </form>
    </main>
  );
}
