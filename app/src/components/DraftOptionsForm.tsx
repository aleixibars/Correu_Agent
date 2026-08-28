"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftOption } from "@correu-agent/shared/db/schema";

/** Els segons de marge per penedir-se d'un "Enviar" abans que el correu
 * surti de debò cap al proveïdor. */
const COUNTDOWN_SECONDS = 7;

/** Els contactes recents del tenant que contenen el que s'ha escrit. */
export type SuggestContacts = (query: string) => Promise<string[]>;

/**
 * L'estona que s'espera abans de demanar suggeriments. Cada consulta és un
 * Server Action, i Next els encua d'un en un tornant tot el payload de la
 * pàgina: sense esperar, escriure una adreça en dispararia una vintena i la
 * llista aniria sempre una lletra endarrerida. Prou curt perquè aturar-se a
 * mirar el camp ja els mostri.
 */
export const SUGGEST_DELAY_MS = 200;

/** El que hi ha després de l'última coma: l'adreça que s'està escrivint ara. */
const currentFragment = (value: string): string =>
  value.slice(value.lastIndexOf(",") + 1).trim();

/**
 * Un camp de destinataris (Per a / Cc / Cco) amb autocompletar de contactes
 * recents (context.md §2). Adreces separades per comes en un sol camp de text,
 * que és com s'escriuen a qualsevol client de correu; els suggeriments es
 * demanen al servidor per al fragment que s'està escrivint, no per tot el camp.
 */
const RecipientField = ({
  id,
  label,
  addresses,
  required = false,
  suggestContacts,
}: {
  id: string;
  label: string;
  addresses: string[];
  /** Només `Per a`: un correu sense cap destinatari no es pot enviar. */
  required?: boolean;
  suggestContacts: SuggestContacts;
}) => {
  const [value, setValue] = useState(addresses.join(", "));
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // El fragment que ha demanat els suggeriments que s'estan esperant: dues
  // consultes seguides poden tornar desordenades, i la resposta d'una lletra
  // que ja no hi és no ha de substituir la llista bona.
  const pending = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Una consulta ja encarrilada quan es marxa de la pàgina no serviria a ningú.
  useEffect(() => () => clearTimeout(timer.current), []);

  const changed = (text: string): void => {
    setValue(text);

    const fragment = currentFragment(text);
    pending.current = fragment;
    clearTimeout(timer.current);
    // Amb l'espai buit no se suggereix res: seria oferir tota la llibreta
    // d'adreces cada vegada que s'esborra una coma.
    if (fragment === "") {
      setSuggestions([]);
      return;
    }

    timer.current = setTimeout(() => {
      void suggestContacts(fragment).then(
        (found) => {
          if (pending.current === fragment) setSuggestions(found);
        },
        // Els suggeriments són una comoditat, no el formulari: si la consulta
        // no arriba (xarxa, desplegament a mitges), el camp segueix escrivint-se
        // a mà. Sense aquesta branca la promesa quedaria rebutjada sense ningú
        // que l'agafi, i el que hauria de ser una llista buida es convertiria en
        // un error de pàgina.
        () => {
          if (pending.current === fragment) setSuggestions([]);
        },
      );
    }, SUGGEST_DELAY_MS);
  };

  const complete = (address: string): void => {
    const kept = value.slice(0, value.lastIndexOf(",") + 1);
    setValue(kept === "" ? address : `${kept} ${address}`);
    setSuggestions([]);
    // La consulta que hi hagi pendent és del fragment que s'acaba de completar:
    // deixar-la arribar tornaria a obrir la llista just després de tancar-la.
    clearTimeout(timer.current);
    pending.current = "";
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        type="text"
        required={required}
        value={value}
        // El desplegable propi del navegador taparia els suggeriments.
        autoComplete="off"
        onChange={(event) => changed(event.target.value)}
      />
      {suggestions.length > 0 && (
        <ul className="contact-suggestions">
          {suggestions.map((address) => (
            <li key={address}>
              <button type="button" onClick={() => complete(address)}>
                {address}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * El formulari d'enviament d'un esborrany (context.md §2): quan el model ha
 * escrit més d'una opció (p.ex. una resposta afirmativa i una de negativa),
 * un selector deixa triar-ne una abans d'editar-la — en triar, el text de
 * l'àrea editable es substitueix pel de l'opció triada. Els destinataris
 * arriben calculats del fil i el revisor els pot canviar abans d'aprovar.
 * Component de client perquè el selector, els camps i els suggeriments
 * necessiten estat local; qui envia de debò segueix sent el Server Action que
 * rep el formulari com a prop.
 *
 * Enviar no envia a l'acte: obre un compte enrere de 7 segons amb un botó de
 * cancel·lar, i només quan arriba a zero es crida el Server Action. Tot el
 * marge passa al navegador — si es cancel·la, no surt cap petició i l'esborrany
 * es queda tal com estava. Un cop disparat, el formulari es queda blocat fins
 * que la pàgina es refresca sola; només si l'enviament falla es torna a obrir.
 */
export const DraftOptionsForm = ({
  draftId,
  options,
  toAddresses,
  ccAddresses,
  bccAddresses,
  approveDraft,
  suggestContacts,
}: {
  draftId: string;
  options: DraftOption[];
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  approveDraft: (formData: FormData) => void | Promise<void>;
  suggestContacts: SuggestContacts;
}) => {
  const [selected, setSelected] = useState(0);
  const [body, setBody] = useState(options[0]?.body ?? "");
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
        {/* El navegador atura l'enviament d'un `Per a` buit abans que arribi al
            Server Action, que refusaria igualment però amb una pàgina d'error. */}
        <RecipientField
          id="toAddresses"
          label="Per a"
          addresses={toAddresses}
          required
          suggestContacts={suggestContacts}
        />
        <RecipientField
          id="ccAddresses"
          label="Cc"
          addresses={ccAddresses}
          suggestContacts={suggestContacts}
        />
        <RecipientField
          id="bccAddresses"
          label="Cco"
          addresses={bccAddresses}
          suggestContacts={suggestContacts}
        />
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
