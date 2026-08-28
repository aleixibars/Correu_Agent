import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { APP_NAME } from "@correu-agent/shared";
import { cleanMessageBody } from "@correu-agent/shared/mail";
import { auth } from "../../../auth";
import {
  LOGIN_PATH,
  THREADS_PATH,
  attachmentDownloadPath,
  attachmentPath,
} from "../../../lib/routes";
import {
  formatAttachmentSize,
  isPreviewable,
} from "../../../lib/attachments/preview";
import { db } from "../../../lib/db";
import { subjectLabel } from "../../../lib/subject-label";
import { loadThreadDetail } from "../../../lib/threads/thread-detail";
import { threadStatusLabel } from "../../../lib/threads/thread-status";
import { AppHeader } from "../../../components/AppHeader";
import { CategoryStamp } from "../../../components/CategoryStamp";
import { DraftReviewStages } from "../../../components/DraftReviewStages";
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
            {/* Es mostra només el contingut nou, sense la cua citada ni la
                signatura (issue #83). El cos es buida als 90 dies de retenció
                (context.md §7) i només en queda el fragment; sense això
                l'article es veuria buit. */}
            <p className="message__body">
              {cleanMessageBody(message.bodyText) ??
                message.snippet ??
                "(Sense contingut)"}
            </p>
            {message.attachments.length > 0 && (
              <div className="attachments">
                <p className="attachments__title">Adjunts</p>
                <ul className="attachments__list">
                  {message.attachments.map((attachment) => {
                    const size = formatAttachmentSize(attachment.sizeBytes);
                    return (
                      <li key={attachment.id}>
                        {/* Només s'ofereix obrir el que el navegador pinta
                            sense executar-ho; la resta, només baixar-ho. */}
                        {isPreviewable(attachment.mimeType) ? (
                          <a
                            href={attachmentPath(attachment.id)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {attachment.filename}
                          </a>
                        ) : (
                          <span>{attachment.filename}</span>
                        )}
                        {size !== null && (
                          <span className="attachments__size">{size}</span>
                        )}
                        {/* Tots els enllaços de la llista diuen "Descarrega",
                            així que el nom del fitxer va a l'etiqueta: si no,
                            un lector de pantalla els llegeix tots iguals. */}
                        <a
                          href={attachmentDownloadPath(attachment.id)}
                          className="attachments__download"
                          aria-label={`Descarrega ${attachment.filename}`}
                        >
                          Descarrega
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </article>
        ))}
      </section>

      <section className="card">
        <h2>Esborrany de resposta</h2>
        {draft === null ? (
          <p>Cap esborrany per revisar en aquest fil.</p>
        ) : draft.status === "pending" ? (
          // Reviewed in stages rather than all at once: which of the three
          // actions is on screen is state the browser holds, so the whole
          // pending branch belongs to a Client Component.
          // Keyed on the thread, not the draft: which stage the reviewer is on
          // belongs to the review of *this* thread. `/fils/[id]` is one route
          // segment, so moving between two threads reconciles this component in
          // place and would otherwise carry the previous thread's stage over —
          // a draft regenerated within the thread keeps the same key, which is
          // what lets the stage survive it.
          <DraftReviewStages
            key={thread.id}
            draftId={draft.id}
            options={draft.options}
            approveDraft={approveDraft}
            rejectDraft={rejectDraft}
            regenerateDraftWithFeedback={regenerateDraftWithFeedback}
          />
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
