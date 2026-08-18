import { redirect } from "next/navigation";
import { APP_NAME } from "@correu-agent/shared";
import { auth } from "../../auth";
import { LOGIN_PATH } from "../../lib/auth/config";
import { categoryLabel } from "../../lib/category-labels";
import { db } from "../../lib/db";
import { listThreads } from "../../lib/threads/list-threads";
import { threadStatusLabel } from "../../lib/threads/thread-status";

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
    <main>
      <h1>Fils</h1>
      {threads.length === 0 ? (
        <p>Encara no hi ha cap fil processat.</p>
      ) : (
        <table>
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
                <td>{subject ?? "(Sense assumpte)"}</td>
                {/* Un fil sense categoria és un fil que el triatge encara no ha
                    tocat; l'estat ja ho diu, així que la cel·la no repeteix el
                    motiu. */}
                <td>{category === null ? "—" : categoryLabel(category)}</td>
                <td>{threadStatusLabel(status)}</td>
                <td>
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
    </main>
  );
}
