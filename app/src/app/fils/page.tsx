import Link from "next/link";
import { redirect } from "next/navigation";
import { APP_NAME } from "@correu-agent/shared";
import { auth } from "../../auth";
import { LOGIN_PATH, THREADS_PATH, threadPath } from "../../lib/routes";
import { db } from "../../lib/db";
import { subjectLabel } from "../../lib/subject-label";
import { listThreads } from "../../lib/threads/list-threads";
import { threadStatusLabel } from "../../lib/threads/thread-status";
import { AppHeader } from "../../components/AppHeader";
import { CategoryStamp } from "../../components/CategoryStamp";

export const metadata = {
  title: `Fils · ${APP_NAME}`,
};

// El tauler és una eina d'oficina en horari local (context.md §5), així que la
// data es formata al fus del negoci i no al del servidor de Render.
const dateFormat = new Intl.DateTimeFormat("ca-ES", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Madrid",
});

export default async function ThreadsPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const threads = await listThreads(db, { tenantId: session.user.tenantId });

  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      <AppHeader email={session.user.email ?? ""} active={THREADS_PATH} />
      <h1>Fils</h1>
      {threads.length === 0 ? (
        <p>Encara no hi ha cap fil processat.</p>
      ) : (
        <table className="thread-table">
          <thead>
            <tr>
              <th scope="col">Assumpte</th>
              <th scope="col">Categoria</th>
              <th scope="col">Estat</th>
              <th scope="col">Últim missatge</th>
            </tr>
          </thead>
          <tbody>
            {threads.map(({ id, subject, category, status, lastMessageAt }) => (
              <tr key={id}>
                <td>
                  {/* L'assumpte porta a la pantalla on es revisa l'esborrany
                      del fil (context.md §2). */}
                  <Link href={threadPath(id)}>{subjectLabel(subject)}</Link>
                </td>
                {/* Un fil sense categoria és un fil que el triatge encara no ha
                    tocat; l'estat ja ho diu, així que la cel·la no repeteix el
                    motiu. */}
                <td>
                  {category === null ? (
                    <span className="meta">—</span>
                  ) : (
                    <CategoryStamp category={category} />
                  )}
                </td>
                <td className="status">{threadStatusLabel(status)}</td>
                <td className="meta">
                  {lastMessageAt === null ? (
                    "—"
                  ) : (
                    <time dateTime={lastMessageAt.toISOString()}>
                      {dateFormat.format(lastMessageAt)}
                    </time>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
