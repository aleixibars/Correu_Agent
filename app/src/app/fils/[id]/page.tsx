import { Fragment } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { APP_NAME } from "@correu-agent/shared";
import { auth } from "../../../auth";
import { LOGIN_PATH, THREADS_PATH } from "../../../lib/routes";
import { db } from "../../../lib/db";
import { subjectLabel } from "../../../lib/subject-label";
import { loadThreadDetail } from "../../../lib/threads/thread-detail";
import { threadStatusLabel } from "../../../lib/threads/thread-status";
import { AppHeader } from "../../../components/AppHeader";
import { CategoryStamp } from "../../../components/CategoryStamp";
import {
  approveDraft,
  regenerateDraftWithFeedback,
  rejectDraft,
} from "./actions";

export const metadata = {
  title: `Fil · ${APP_NAME}`,
};

// El tauler és una eina d'oficina en horari local (context.md §5), així que la
// data es formata al fus del negoci i no al del servidor de Render.
const dateFormat = new Intl.DateTimeFormat("ca-ES", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Madrid",
});

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const { id } = await params;
  const thread = await loadThreadDetail(db, {
    tenantId: session.user.tenantId,
    threadId: id,
  });
  // Un fil d'un altre tenant es llegeix com a inexistent (context.md §7): la
  // pàgina no ha de dir que aquest identificador existeix en algun lloc.
  if (!thread) notFound();

  const { draft } = thread;

  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      <AppHeader email={session.user.email ?? ""} active={THREADS_PATH} />
      <p>
        <Link href={THREADS_PATH}>← Torna als fils</Link>
      </p>

      <h1>{subjectLabel(thread.subject)}</h1>
      <p>
        {/* Un fil sense categoria és un fil que el triatge encara no ha tocat;
            l'estat ho diu, així que aquí no es repeteix el motiu. */}
        {thread.category !== null && <CategoryStamp category={thread.category} />}{" "}
        <span className="status">{threadStatusLabel(thread.status)}</span>
      </p>

      <section>
        <h2>Correu del fil</h2>
        {thread.messages.map((message) => (
          <article
            key={message.id}
            className={`message${message.direction === "outbound" ? " message--outbound" : ""}`}
          >
            <p className="message__from">
              {message.direction === "inbound" ? "De" : "Enviat a"}:{" "}
              {message.direction === "inbound"
                ? message.fromAddress
                : message.toAddresses.join(", ")}
              {message.sentAt !== null && (
                <>
                  {" · "}
                  <time dateTime={message.sentAt.toISOString()}>
                    {dateFormat.format(message.sentAt)}
                  </time>
                </>
              )}
            </p>
            {/* El cos es buida als 90 dies de retenció (context.md §7) i només
                en queda el fragment; sense això l'article es veuria buit. */}
            <p className="message__body">
              {message.bodyText ?? message.snippet ?? "(Sense contingut)"}
            </p>
          </article>
        ))}
      </section>

      <section className="card">
        <h2>Esborrany de resposta</h2>
        {draft === null ? (
          <p>Cap esborrany per revisar en aquest fil.</p>
        ) : draft.status === "pending" ? (
          // Keyed on the draft, not just present unconditionally: regenerating
          // writes a *new* draft row (a different id) in the same JSX position,
          // so without this React reconciles the old textarea in place instead
          // of remounting it — and a `defaultValue` only applies on mount, so
          // the editable field would keep showing the rejected text until the
          // reader refreshed by hand.
          <Fragment key={draft.id}>
            <p>
              Edita el text si cal: en aprovar-lo, s'envia la resposta al
              remitent del fil.
            </p>
            <form action={approveDraft}>
              <input type="hidden" name="draftId" value={draft.id} />
              <div className="field">
                <label htmlFor="body">Text de la resposta</label>
                <textarea
                  id="body"
                  name="body"
                  rows={12}
                  required
                  defaultValue={draft.body}
                />
              </div>
              <button type="submit" className="btn-primary">
                Aprova i envia
              </button>
            </form>
            {/* Formularis germans i no imbricats: l'HTML no permet imbricar-los,
                i cada botó envia només el seu camp. */}
            <form action={rejectDraft} style={{ marginTop: 14 }}>
              <input type="hidden" name="draftId" value={draft.id} />
              <button type="submit" className="btn-ghost">
                Descarta sense respondre
              </button>
            </form>
            <form action={regenerateDraftWithFeedback} style={{ marginTop: 14 }}>
              <input type="hidden" name="draftId" value={draft.id} />
              <div className="field">
                <label htmlFor="feedback">Què vols canviar de l'esborrany</label>
                <textarea id="feedback" name="feedback" rows={3} required />
              </div>
              <button type="submit">Regenera amb aquest comentari</button>
            </form>
          </Fragment>
        ) : (
          <>
            <p className="status">{threadStatusLabel(thread.status)}</p>
            <p className="message__body">{draft.body}</p>
          </>
        )}
      </section>
    </div>
  );
}
