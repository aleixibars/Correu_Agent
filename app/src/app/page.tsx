import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { AppHeader } from "../components/AppHeader";
import { auth } from "../auth";
import {
  AUTO_REPLY_PATH,
  DASHBOARD_PATH,
  DIGEST_PATH,
  LOGIN_PATH,
  THREADS_PATH,
} from "../lib/routes";
import {
  MAILBOX_REASON_PARAM,
  MAILBOX_STATUS_PARAM,
  mailboxConnectionNotice,
} from "../lib/mailbox/connect-messages";
import { GOOGLE_CONNECT_PATH } from "../lib/mailbox/google-oauth";
import { MICROSOFT_MAILBOX_CONNECT_PATH } from "../lib/mailbox/microsoft";
import { UrgentPushToggle } from "./urgent-push";

export default async function HomePage({
  searchParams,
}: {
  // The mailbox callbacks redirect here with the outcome of the connection.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();

  if (!session) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <span className="app-header__wordmark">{APP_NAME}</span>
          <p>
            <Link href={LOGIN_PATH}>Inicia la sessió</Link> per accedir al
            tauler.
          </p>
        </div>
      </div>
    );
  }

  const query = await searchParams;
  const notice = mailboxConnectionNotice(
    query[MAILBOX_STATUS_PARAM],
    query[MAILBOX_REASON_PARAM],
  );

  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      <AppHeader email={session.user.email ?? ""} active={DASHBOARD_PATH} />

      {notice !== null && (
        <p role={notice.ok ? "status" : "alert"}>{notice.text}</p>
      )}

      <section className="card">
        <h2>Accedeix-hi</h2>
        <p>
          <Link href={THREADS_PATH}>Fils processats</Link> —{" "}
          <Link href={DIGEST_PATH}>digest diari</Link> —{" "}
          <Link href={AUTO_REPLY_PATH}>resposta automàtica</Link>
        </p>
      </section>

      <section className="card">
        <h2>Bústies connectades</h2>
        <p>
          {/* Plain anchors, not `next/link`: the targets are route handlers that
              redirect off-site to the provider, and a client-side navigation
              would run them twice — once for the RSC fetch that cannot follow the
              cross-origin redirect, once for the hard navigation that replaces
              it. */}
          <a href={GOOGLE_CONNECT_PATH} className="btn">
            Connecta una bústia de Gmail
          </a>{" "}
          <a href={MICROSOFT_MAILBOX_CONNECT_PATH} className="btn">
            Connecta una bústia de Microsoft 365/Outlook
          </a>
        </p>
      </section>

      <section className="card">
        {/* Read here rather than in the client component: the key is public, but
            only a Server Component can reach the environment it lives in. */}
        <UrgentPushToggle publicKey={process.env.VAPID_PUBLIC_KEY ?? ""} />
      </section>
    </div>
  );
}
