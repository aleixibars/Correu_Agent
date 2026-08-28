import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { collectDailyDigest } from "@correu-agent/shared/digest";
import { AppHeader } from "../components/AppHeader";
import { PendingThreadsTable } from "../components/PendingThreadsTable";
import { auth } from "../auth";
import {
  AUTO_REPLY_PATH,
  DASHBOARD_PATH,
  DIGEST_PATH,
  LOGIN_PATH,
  THREADS_PATH,
  threadPath,
} from "../lib/routes";
import {
  MAILBOX_REASON_PARAM,
  MAILBOX_STATUS_PARAM,
  mailboxConnectionNotice,
} from "../lib/mailbox/connect-messages";
import { db } from "../lib/db";
import { categoryLabel } from "../lib/category-labels";
import { CATEGORY_COLOR_VARS } from "../lib/category-colors";
import { subjectLabel } from "../lib/subject-label";
import { listThreads } from "../lib/threads/list-threads";
import { actionableThreads } from "../lib/threads/actionable-threads";
import { latestDailyDigest } from "../lib/digest/latest-digest";
import { rejectDraft } from "./fils/[id]/actions";

// El dia del digest és una data UTC (context.md §7: no hi ha fus per tenant).
const dayFormat = new Intl.DateTimeFormat("ca-ES", {
  day: "numeric",
  month: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const writtenAtFormat = new Intl.DateTimeFormat("ca-ES", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Madrid",
});

// El resum arriba com a prosa (context.md §6), partida per qualsevol salt de
// línia — vegeu la mateixa nota a /digest/page.tsx.
const paragraphs = (summary: string): string[] =>
  summary
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");

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

  const { tenantId } = session.user;
  const query = await searchParams;
  const notice = mailboxConnectionNotice(
    query[MAILBOX_STATUS_PARAM],
    query[MAILBOX_REASON_PARAM],
  );

  // Tot el que li interessa al revisor va a la pantalla inicial (no darrere
  // de clics): els fils que li esperen i el digest del dia, abans que res
  // més.
  const threads = await listThreads(db, { tenantId });
  const pending = actionableThreads(threads);

  const digest = await latestDailyDigest(db, { tenantId });
  const digestContent =
    digest === null
      ? null
      : await collectDailyDigest(db, { tenantId, day: digest.day });

  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      <AppHeader email={session.user.email ?? ""} active={DASHBOARD_PATH} />

      {notice !== null && (
        <p role={notice.ok ? "status" : "alert"}>{notice.text}</p>
      )}

      <section className="card">
        <h2>Pendents i urgents</h2>
        {pending.length === 0 ? (
          <p>Tot al dia, cap fil pendent.</p>
        ) : (
          <PendingThreadsTable threads={pending} rejectDraft={rejectDraft} />
        )}
        <p>
          <Link href={THREADS_PATH}>Veure tots els fils →</Link>
        </p>
      </section>

      <section className="card">
        <h2>Digest diari</h2>
        {digest === null || digestContent === null ? (
          <p>
            Encara no hi ha cap digest. Se'n genera un cada dia amb els fils
            processats.
          </p>
        ) : (
          <>
            <p className="meta">
              <time dateTime={digest.day}>
                {dayFormat.format(new Date(digest.day))}
              </time>
              {" · "}
              {digestContent.threadCount === 1
                ? "1 fil processat"
                : `${digestContent.threadCount} fils processats`}
              {" · Generat el "}
              <time dateTime={digest.updatedAt.toISOString()}>
                {writtenAtFormat.format(digest.updatedAt)}
              </time>
            </p>

            <div className="digest-summary">
              {paragraphs(digest.summary).map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>

            {/* Un dia mogut deixa prou fils com per allargar la pantalla
                inicial sense fi, així que el recompte per categoria es
                desplaça dins del bloc. El contenidor ha de poder rebre el
                focus o el teclat no arriba a les entrades de sota; per això
                només es pinta quan hi ha fils, i no com una parada del
                tabulador cap a una regió buida. */}
            {digestContent.sections.length > 0 && (
              <div
                className="digest-scroll"
                role="region"
                aria-label="Fils del digest"
                tabIndex={0}
              >
                {digestContent.sections.map(({ category, threads: sectionThreads }) => (
                  <section key={category}>
                    <h3 style={{ color: CATEGORY_COLOR_VARS[category] }}>
                      {categoryLabel(category)} ({sectionThreads.length})
                    </h3>
                    <ul>
                      {/* Llegir el fil és l'única cosa que ofereix el digest:
                          les accions (Respondre, Descarta) són de la taula de
                          "Pendents i urgents". */}
                      {sectionThreads.map(({ id, subject }) => (
                        <li key={id}>
                          <Link href={threadPath(id)}>{subjectLabel(subject)}</Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <p className="meta">
        <Link href={AUTO_REPLY_PATH}>Configuració</Link>
      </p>
    </div>
  );
}
