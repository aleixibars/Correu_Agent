"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftOption } from "@correu-agent/shared/db/schema";

/** Els segons de marge per penedir-se d'un "Aprova i envia" abans que el
 * correu surti de debò cap al proveïdor. */
const COUNTDOWN_SECONDS = 7;

/**
 * El formulari d'aprovació d'un esborrany (context.md §2): quan el model ha
 * escrit més d'una opció (p.ex. una resposta afirmativa i una de negativa),
 * un selector deixa triar-ne una abans d'editar-la — en triar, el text de
 * l'àrea editable es substitueix pel de l'opció triada. Component de client
 * perquè el selector necessita estat local; l'acció de submit segueix sent el
 * Server Action que rep el formulari com a prop.
 *
 * Aprovar no envia a l'acte: obre un compte enrere de 7 segons amb un botó de
 * cancel·lar, i només quan arriba a zero es crida el Server Action. Tot el
 * marge passa al navegador — si es cancel·la, no surt cap petició i l'esborrany
 * es queda tal com estava.
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
  // El que s'enviarà quan s'acabi el compte enrere, capturat en clicar: el
  // formulari podria canviar mentre corren els segons.
  const pending = useRef<FormData | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const counting = secondsLeft !== null;

  const cancel = useCallback(() => {
    pending.current = null;
    setSecondsLeft(null);
  }, []);

  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      setSecondsLeft((left) => (left === null ? null : left - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [counting]);

  useEffect(() => {
    if (secondsLeft !== 0) return;
    const formData = pending.current;
    pending.current = null;
    setSecondsLeft(null);
    if (formData !== null) approveDraft(formData);
  }, [secondsLeft, approveDraft]);

  // Escapada com a segona sortida del pop-up: qui es penedeix amb el teclat no
  // hauria de dependre d'arribar al botó a temps.
  useEffect(() => {
    if (!counting) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [counting, cancel]);

  return (
    <>
      {/* `action` es queda com el camí sense JavaScript; amb JavaScript
          `onSubmit` l'atura i el compte enrere és qui acaba cridant el Server
          Action. */}
      <form
        action={approveDraft}
        onSubmit={(event) => {
          // Res surt encara: només s'apunta què s'enviaria d'aquí a 7 segons.
          event.preventDefault();
          pending.current = new FormData(event.currentTarget);
          setSecondsLeft(COUNTDOWN_SECONDS);
        }}
      >
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
        <button type="submit" className="btn-primary" disabled={counting}>
          Aprova i envia
        </button>
      </form>

      {secondsLeft !== null && (
        <div className="countdown-backdrop">
          <div
            className="countdown"
            role="dialog"
            aria-modal="true"
            aria-labelledby="countdown-title"
          >
            <h2 id="countdown-title">S&apos;enviarà en {secondsLeft} s</h2>
            <p>
              El correu sortirà sol quan s&apos;acabi el compte enrere. Encara
              hi ets a temps.
            </p>
            {/* Enfocat d'entrada: cancel·lar ha de ser la primera cosa a mà,
                també per a qui navega amb teclat. */}
            <button
              type="button"
              className="btn-primary"
              autoFocus
              onClick={cancel}
            >
              Cancel·la
            </button>
          </div>
        </div>
      )}
    </>
  );
};
