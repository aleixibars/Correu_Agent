"use client";

import { useEffect, useRef, useState } from "react";
import type { DraftOption } from "@correu-agent/shared/db/schema";

/** How often the field is parked on the server while it is being edited. */
const AUTOSAVE_INTERVAL_MS = 60_000;

/**
 * El formulari d'aprovació d'un esborrany (context.md §2): quan el model ha
 * escrit més d'una opció (p.ex. una resposta afirmativa i una de negativa),
 * un selector deixa triar-ne una abans d'editar-la — en triar, el text de
 * l'àrea editable es substitueix pel de l'opció triada. Component de client
 * perquè el selector necessita estat local; l'acció de submit segueix sent el
 * Server Action que rep el formulari com a prop.
 *
 * El text escrit s'autoguarda cada minut mentre l'esborrany segueix pendent, i
 * també en amagar la pestanya o marxar del fil, de manera que tancar-la abans
 * d'aprovar no perd el que s'hagi escrit des de l'últim guardat.
 */
export const DraftOptionsForm = ({
  draftId,
  body: savedBody,
  options,
  approveDraft,
  saveDraftEdit,
}: {
  draftId: string;
  /** El text d'on parteix l'edició: l'últim autoguardat, o el del model. */
  body: string;
  options: DraftOption[];
  approveDraft: (formData: FormData) => void;
  saveDraftEdit: (formData: FormData) => Promise<void>;
}) => {
  // Cap opció marcada quan el text ja no és el de cap d'elles: qui ha reprès una
  // edició pròpia no ha triat cap de les respostes que va escriure el model.
  const [selected, setSelected] = useState(() =>
    options.findIndex((option) => option.body === savedBody),
  );
  const [body, setBody] = useState(savedBody);

  // Llegits pel temporitzador, que es munta un sol cop: dins d'un `setInterval`
  // l'estat de React es quedaria congelat al del primer render.
  const current = useRef(body);
  current.current = body;
  const saved = useRef(savedBody);

  useEffect(() => {
    const save = (): void => {
      const text = current.current;
      // Res de nou per guardar: ni una escriptura per minut mentre el revisor
      // llegeix sense tocar res. Un camp buit tampoc es desa — deixaria el fil
      // sense cap text on hi havia el del model.
      if (text === saved.current || text.trim() === "") return;
      // Abans d'esperar la resposta, perquè el minut següent no torni a enviar
      // el mateix text si aquesta crida encara està en curs.
      const previous = saved.current;
      saved.current = text;

      const form = new FormData();
      form.append("draftId", draftId);
      form.append("body", text);
      // Un guardat que no arriba (xarxa caiguda, servidor que falla) torna a
      // deixar el text per desar: si no, el minut següent el trobaria «ja
      // guardat» i l'edició es perdria en silenci fins que el revisor tornés a
      // teclejar.
      saveDraftEdit(form).catch(() => {
        if (saved.current === text) saved.current = previous;
      });
    };

    const timer = setInterval(save, AUTOSAVE_INTERVAL_MS);
    // Amagar la pestanya és el més a prop d'un «me'n vaig» que el navegador
    // avisa de manera fiable (tancar-la i canviar de pestanya hi passen tots
    // dos): és aquí, i no a `beforeunload`, on el text s'acaba de guardar.
    const saveOnLeaving = (): void => {
      if (document.visibilityState === "hidden") save();
    };
    document.addEventListener("visibilitychange", saveOnLeaving);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", saveOnLeaving);
      // Marxar del fil dins del dashboard desmunta el formulari sense amagar la
      // pestanya: el que s'hagi escrit des de l'últim guardat es desa aquí.
      // L'esborrany aprovat, descartat o regenerat ja no està pendent, i un
      // guardat que hi arribi no escriu res (`saveDraftEdit`).
      save();
    };
  }, [draftId, saveDraftEdit]);

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
        Aprova i envia
      </button>
    </form>
  );
};
