import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { auth, signOut } from "../auth";
import { LOGIN_PATH } from "../lib/auth/config";
import {
  MAILBOX_REASON_PARAM,
  MAILBOX_STATUS_PARAM,
  mailboxConnectionNotice,
} from "../lib/mailbox/connect-messages";

/** Where the Gmail connection flow starts (`api/mailbox/google/connect`). */
const GOOGLE_CONNECT_PATH = "/api/mailbox/google/connect";

export default async function HomePage({
  searchParams,
}: {
  // The mailbox callback redirects here with the outcome of the connection.
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
      {notice !== null && (
        <p role={notice.ok ? "status" : "alert"}>{notice.text}</p>
      )}
      <p>
        <Link href={GOOGLE_CONNECT_PATH} prefetch={false}>
          Connecta una bústia de Gmail
        </Link>
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
