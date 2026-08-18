import { redirect } from "next/navigation";
import { APP_NAME } from "@correu-agent/shared";
import { collectDailyDigest } from "@correu-agent/shared/digest";
import { auth } from "../../auth";
import { DIGEST_PATH, LOGIN_PATH } from "../../lib/routes";
import { categoryLabel } from "../../lib/category-labels";
import { CATEGORY_COLOR_VARS } from "../../lib/category-colors";
import { db } from "../../lib/db";
import { latestDailyDigest } from "../../lib/digest/latest-digest";
import { subjectLabel } from "../../lib/subject-label";
import { AppHeader } from "../../components/AppHeader";

export const metadata = {
  title: `Digest diari · ${APP_NAME}`,
};

// El dia del digest és una data UTC (context.md §7: no hi ha fus per tenant),
// així que es formata en UTC — formatar-la en local movria el 17 al 16 des de
// qualsevol fus a l'oest de Greenwich.
const dayFormat = new Intl.DateTimeFormat("ca-ES", {
  day: "numeric",
  month: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

// L'hora d'un missatge, en canvi, la llegeix una persona a l'oficina, igual que
// a la llista de fils.
const timeFormat = new Intl.DateTimeFormat("ca-ES", {
  timeStyle: "short",
  timeZone: "Europe/Madrid",
});

const writtenAtFormat = new Intl.DateTimeFormat("ca-ES", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Madrid",
});

// El resum arriba com a prosa (context.md §6). Es parteix per qualsevol salt de
// línia, no només per línia en blanc: al model se li demana una secció curta per
// categoria i sovint respon amb una línia per categoria, i unir-les donaria un
// sol paràgraf corregut. Es pinta com a text — mai com a HTML: ve d'un model
// que ha llegit correu de tercers.
const paragraphs = (summary: string): string[] =>
  summary
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");

export default async function DigestPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const { tenantId } = session.user;
  const digest = await latestDailyDigest(db, { tenantId });

  if (digest === null) {
    return (
      <div className="app-shell">
        <div className="airmail-stripe" />
        <AppHeader email={session.user.email ?? ""} active={DIGEST_PATH} />
        <h1>Digest diari</h1>
        <p>
          Encara no hi ha cap digest. Se'n genera un cada dia amb els fils
          processats.
        </p>
      </div>
    );
  }

  // Els fils del dia es tornen a agrupar des de la base de dades en lloc de
  // desar-los amb el resum: així el digest sempre llista els fils tal com són
  // ara (categoria corregida inclosa), i no una còpia congelada.
  const content = await collectDailyDigest(db, { tenantId, day: digest.day });

  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      <AppHeader email={session.user.email ?? ""} active={DIGEST_PATH} />
      <h1>Digest diari</h1>
      <p className="meta">
        <time dateTime={digest.day}>{dayFormat.format(new Date(digest.day))}</time>
        {" · "}
        {content.threadCount === 1
          ? "1 fil processat"
          : `${content.threadCount} fils processats`}
        {" · Generat el "}
        <time dateTime={digest.updatedAt.toISOString()}>
          {writtenAtFormat.format(digest.updatedAt)}
        </time>
      </p>

      <div className="card digest-summary">
        {paragraphs(digest.summary).map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>

      {content.sections.map(({ category, threads }) => (
        <section key={category} className="card">
          <h2 style={{ color: CATEGORY_COLOR_VARS[category] }}>
            {categoryLabel(category)} ({threads.length})
          </h2>
          <ul>
            {threads.map(({ id, subject, lastMessageAt }) => (
              <li key={id}>
                {subjectLabel(subject)}
                {lastMessageAt !== null && (
                  <>
                    {" — "}
                    <time
                      className="meta"
                      dateTime={lastMessageAt.toISOString()}
                    >
                      {timeFormat.format(lastMessageAt)}
                    </time>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
