"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftOption } from "@correu-agent/shared/db/schema";

/** How often the field is parked on the server while it is being edited. */
const AUTOSAVE_INTERVAL_MS = 60_000;

/** Els segons de marge per penedir-se d'un "Enviar" abans que el correu
 * surti de debò cap al proveïdor. */
const COUNTDOWN_SECONDS = 7;

/**
 * El formulari d'enviament d'un esborrany (context.md §2): quan el model ha
 * escrit més d'una opció (p.ex. una resposta afirmativa i una de negativa),
 * un selector deixa triar-ne una abans d'editar-la — en triar, el text de
 * l'àrea editable es substitueix pel de l'opció triada. Component de client
 * perquè el selector necessita estat local; qui envia de debò segueix sent el
 * Server Action que rep com a prop.
 *
 * El text escrit s'autoguarda cada minut mentre l'esborrany segueix pendent, i
 * també en deixar el camp, en amagar la pestanya i en marxar del fil, de manera
 * que tancar-la abans d'aprovar no perd el que s'hagi escrit des de l'últim
 * guardat.
 *
 * Enviar no envia a l'acte: obre un compte enrere de 7 segons amb un botó de
 * cancel·lar, i només quan arriba a zero es crida el Server Action. Tot el
 * marge passa al navegador — si es cancel·la, no surt cap petició i l'esborrany
 * es queda tal com estava. Un cop disparat, el formulari es queda blocat fins
 * que la pàgina es refresca sola; només si l'enviament falla es torna a obrir.
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
  approveDraft: (formData: FormData) => void | Promise<void>;
  saveDraftEdit: (formData: FormData) => Promise<void>;
}) => {
  const [body, setBody] = useState(savedBody);
  // Derivat del text, no un estat a part: cap opció queda marcada quan el text
  // ja no és el de cap d'elles — ni en tornar a una edició pròpia autoguardada,
  // ni en retocar a mà l'opció que s'acabava de triar. Les dues situacions són
  // la mateixa, i tenir-ho en un `useState` les feia divergir fins al refresc.
  const selected = options.findIndex((option) => option.body === body);

  // Llegits pel temporitzador, que es munta un sol cop: dins d'un `setInterval`
  // l'estat de React es quedaria congelat al del primer render.
  const current = useRef(body);
  current.current = body;
  const saved = useRef(savedBody);

  // El que s'enviarà quan s'acabi el compte enrere, capturat en clicar: el
  // formulari podria canviar mentre corren els segons.
  const pending = useRef<FormData | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const counting = secondsLeft !== null;
  // Un cop disparat l'enviament el formulari es queda blocat: enviar de debò
  // triga (el proveïdor, i després la revalidació que desmunta el formulari), i
  // un segon clic en aquesta estona és un segon correu al remitent.
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const approveButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // Cancel·lar ha de tornar el focus al botó d'enviar, però encara està
  // deshabilitat mentre es pinta aquest mateix render: es fa un cop tancat.
  const restoreFocus = useRef(false);

  const save = useCallback((): void => {
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
  }, [draftId, saveDraftEdit]);

  useEffect(() => {
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
  }, [save]);

  const cancel = useCallback(() => {
    pending.current = null;
    restoreFocus.current = true;
    setSecondsLeft(null);
  }, []);

  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      // Aturat a zero i no per sota: si el navegador va carregat, dos tics
      // poden arribar abans que l'efecte de sota s'executi, i un compte enrere
      // en negatiu no dispararia mai l'enviament.
      setSecondsLeft((left) => (left === null ? null : Math.max(left - 1, 0)));
    }, 1000);
    return () => clearInterval(timer);
  }, [counting]);

  useEffect(() => {
    if (secondsLeft !== 0) return;
    const formData = pending.current;
    pending.current = null;
    setSecondsLeft(null);
    if (formData === null) return;
    setSending(true);
    void (async () => {
      try {
        await approveDraft(formData);
      } catch {
        // El correu no ha sortit: es torna a deixar clicar, dit clarament, en
        // comptes de deixar el formulari blocat per sempre sense explicació.
        setSending(false);
        setFailed(true);
      }
    })();
  }, [secondsLeft, approveDraft]);

  useEffect(() => {
    if (counting || !restoreFocus.current) return;
    restoreFocus.current = false;
    approveButton.current?.focus();
  }, [counting]);

  useEffect(() => {
    if (!counting) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Escapada com a segona sortida del pop-up: qui es penedeix amb el teclat
      // no hauria de dependre d'arribar al botó a temps.
      if (event.key === "Escape") {
        cancel();
        return;
      }
      // El fons queda tapat, i el tabulador no l'ha de poder recórrer: mentre
      // corren els segons, l'únic que hi ha a mà és cancel·lar.
      if (event.key === "Tab") {
        event.preventDefault();
        cancelButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [counting, cancel]);

  return (
    <>
      {/* Sense `action`: qui crida el Server Action és el compte enrere, mai el
          submit. Un `action` de recanvi per a navegadors sense JavaScript
          enviaria el correu a l'acte i sense marge per cancel·lar-lo — i tampoc
          seria abastable, perquè el formulari només es pinta quan
          `DraftReviewStages` ja ha passat a l'etapa de resposta, que és estat
          del navegador. */}
      <form
        onSubmit={(event) => {
          // Res surt encara: només s'apunta què s'enviaria d'aquí a 7 segons.
          event.preventDefault();
          pending.current = new FormData(event.currentTarget);
          setFailed(false);
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
                  onChange={() => setBody(option.body)}
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
            // Deixar el camp és el senyal que el revisor ha acabat d'escriure i
            // va a fer una altra cosa — sovint "Refinar", que regenera a partir
            // de l'últim text guardat. Esperar el minut que ve faria que
            // regenerés el text del model en comptes del seu.
            onBlur={save}
          />
        </div>
        <button
          ref={approveButton}
          type="submit"
          className="btn-primary"
          disabled={counting || sending}
        >
          {sending ? "Enviant…" : "Enviar"}
        </button>
        {failed && (
          <p role="alert">
            No s&apos;ha pogut enviar la resposta. L&apos;esborrany segueix
            pendent: torna-ho a provar.
          </p>
        )}
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
              ref={cancelButton}
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
