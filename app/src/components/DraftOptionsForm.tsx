"use client";

import { useState } from "react";
import type { DraftOption } from "@correu-agent/shared/db/schema";
import {
  MAX_ATTACHMENTS_BYTES,
  MAX_ATTACHMENTS_LABEL,
} from "../lib/mailbox/reply-attachments";

/**
 * El formulari d'aprovació d'un esborrany (context.md §2): quan el model ha
 * escrit més d'una opció (p.ex. una resposta afirmativa i una de negativa),
 * un selector deixa triar-ne una abans d'editar-la — en triar, el text de
 * l'àrea editable es substitueix pel de l'opció triada. Component de client
 * perquè el selector necessita estat local; l'acció de submit segueix sent el
 * Server Action que rep el formulari com a prop.
 *
 * Els fitxers triats surten adjunts a la resposta i no es desen enlloc: viuen
 * de l'enviament del formulari fins que el proveïdor té el correu. La mida es
 * comprova aquí per avisar abans d'intentar-ho — qui decideix de debò és el
 * Server Action, que torna a comptar-la.
 */
export const DraftOptionsForm = ({
  draftId,
  options,
  approveDraft,
}: {
  draftId: string;
  options: DraftOption[];
  approveDraft: (formData: FormData) => void;
}) => {
  const [selected, setSelected] = useState(0);
  const [body, setBody] = useState(options[0]?.body ?? "");
  const [attachedBytes, setAttachedBytes] = useState(0);
  const tooLarge = attachedBytes > MAX_ATTACHMENTS_BYTES;

  return (
    // Sense `multipart/form-data` el navegador enviaria només el nom del fitxer,
    // no el fitxer.
    <form action={approveDraft} encType="multipart/form-data">
      <input type="hidden" name="draftId" value={draftId} />
      {options.length > 1 && (
        <fieldset className="draft-options">
          <legend>Tria una resposta</legend>
          {options.map((option, index) => (
            <label key={index} className="draft-option">
              <input
                type="radio"
                name="draftOption"
                checked={selected === index}
                onChange={() => {
                  setSelected(index);
                  setBody(option.body);
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      )}
      <div className="field">
        <label htmlFor="body">Text de la resposta</label>
        <textarea
          id="body"
          name="body"
          rows={12}
          required
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="attachments">
          Adjunta documents (opcional, fins a {MAX_ATTACHMENTS_LABEL} en total)
        </label>
        <input
          id="attachments"
          type="file"
          name="attachments"
          multiple
          onChange={(event) =>
            setAttachedBytes(
              [...(event.target.files ?? [])].reduce(
                (bytes, file) => bytes + file.size,
                0,
              ),
            )
          }
        />
      </div>
      {tooLarge && (
        <p role="alert" className="draft-attachments__alert">
          Els documents adjunts sumen més de {MAX_ATTACHMENTS_LABEL}. Treu-ne
          algun o envia&apos;ls per separat: el correu no sortiria.
        </p>
      )}
      <button type="submit" className="btn-primary" disabled={tooLarge}>
        Aprova i envia
      </button>
    </form>
  );
};
