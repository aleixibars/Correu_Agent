// Serveix un adjunt d'un correu (issue #78). Prima: la feina de trobar-lo i de
// baixar-lo del proveïdor és de `lib/mailbox/attachment-download`, i aquí només
// hi ha com surt cap al navegador.
//
// Un adjunt l'ha escrit qui ha volgut i el serveix el mateix origen que el
// tauler, així que només els tipus que el navegador pinta sense executar-los
// s'ofereixen per a veure'ls; la resta baixa com a fitxer i prou.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "../../../../auth";
import { db } from "../../../../lib/db";
import { isPreviewable } from "../../../../lib/attachments/preview";
import { downloadAttachment } from "../../../../lib/mailbox/attachment-download";
import { ATTACHMENT_DOWNLOAD_PARAM } from "../../../../lib/routes";

/** El tipus que no diu res al navegador: sempre es baixa, mai s'interpreta. */
const OPAQUE_TYPE = "application/octet-stream";

/**
 * El nom que pot viatjar dins d'un `filename="..."`: els accents es perden i
 * les cometes desapareixen. El nom de debò va al costat, a `filename*`, que és
 * el que llegeixen tots els navegadors d'avui.
 */
const asciiFilename = (filename: string): string =>
  filename
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .trim() || "adjunt";

const contentDisposition = (filename: string, preview: boolean): string =>
  `${preview ? "inline" : "attachment"}; filename="${asciiFilename(
    filename,
  )}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

export const GET = async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Cal iniciar la sessió." }, { status: 401 });
  }

  const { id } = await params;
  const attachment = await downloadAttachment(db, {
    tenantId: session.user.tenantId,
    attachmentId: id,
  });
  // Un adjunt d'un altre tenant, un identificador inventat i un correu que el
  // proveïdor ja no té es llegeixen igual: aquí no hi ha res per servir.
  if (!attachment) {
    return NextResponse.json({ error: "L'adjunt no existeix." }, { status: 404 });
  }

  // El tipus del remitent només es repeteix quan és un dels que es poden
  // ensenyar; qualsevol altre surt opac perquè el navegador no el corri.
  const previewType =
    isPreviewable(attachment.mimeType) &&
    !new URL(request.url).searchParams.has(ATTACHMENT_DOWNLOAD_PARAM)
      ? attachment.mimeType
      : null;
  const preview = previewType !== null;

  return new NextResponse(attachment.bytes as BodyInit, {
    headers: {
      "content-type": previewType ?? OPAQUE_TYPE,
      "content-disposition": contentDisposition(attachment.filename, preview),
      "content-length": String(attachment.bytes.byteLength),
      // El tipus que va al `content-type` és el que mana: sense això, el
      // navegador podria ensumar un fitxer opac i decidir que és HTML.
      "x-content-type-options": "nosniff",
      // `sandbox` deixa la resposta en un origen opac, fora de la sessió de qui
      // llegeix. No es posa a la previsualització: el visor de PDF del
      // navegador no s'hi carrega, i allà qui talla el risc és la llista de
      // tipus inerts (imatges sense SVG, i PDF) servida amb `nosniff`.
      ...(preview ? {} : { "content-security-policy": "sandbox" }),
      // Correu d'un client: no ha de quedar a la memòria cau de ningú.
      "cache-control": "private, no-store",
    },
  });
};
