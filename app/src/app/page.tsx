import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { auth, signOut } from "../auth";
import { LOGIN_PATH } from "../lib/auth/config";
import {
  MAILBOX_CONNECTED_RESULT,
  MAILBOX_ERROR_RESULT,
  MAILBOX_RESULT_PARAM,
  MICROSOFT_MAILBOX_CONNECT_PATH,
} from "../lib/mailbox/microsoft";

// A Map, not an object literal: the key comes straight off the query string, and
// `?bustia=constructor` would resolve to an inherited property on a literal.
const MAILBOX_MESSAGES = new Map<string, string>([
  [MAILBOX_CONNECTED_RESULT, "Bústia connectada."],
  [MAILBOX_ERROR_RESULT, "No s'ha pogut connectar la bústia. Torna-ho a provar."],
]);

export default async function HomePage({
  searchParams,
}: {
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

  const result = (await searchParams)[MAILBOX_RESULT_PARAM];
  const message =
    typeof result === "string" ? MAILBOX_MESSAGES.get(result) : undefined;

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>Sessió iniciada com a {session.user.email}. Tauler en construcció.</p>
      {message ? <p>{message}</p> : null}
      <p>
        {/* Full page load, not a client-side navigation: the route redirects to Microsoft. */}
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
