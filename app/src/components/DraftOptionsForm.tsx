"use client";

import { useState } from "react";
import type { DraftOption } from "@correu-agent/shared/db/schema";

/**
 * El formulari d'enviament d'un esborrany (context.md §2): quan el model ha
 * escrit més d'una opció (p.ex. una resposta afirmativa i una de negativa),
 * un selector deixa triar-ne una abans d'editar-la — en triar, el text de
 * l'àrea editable es substitueix pel de l'opció triada. Component de client
 * perquè el selector necessita estat local; l'acció de submit segueix sent el
 * Server Action que rep el formulari com a prop.
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

  return (
    <form action={approveDraft}>
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
      <button type="submit" className="btn-primary">
        Enviar
      </button>
    </form>
  );
};
