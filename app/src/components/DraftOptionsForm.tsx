"use client";

import { useEffect, useRef, useState } from "react";
import type { DraftOption } from "@correu-agent/shared/db/schema";

/** Els contactes recents del tenant que contenen el que s'ha escrit. */
export type SuggestContacts = (query: string) => Promise<string[]>;

/**
 * L'estona que s'espera abans de demanar suggeriments. Cada consulta és un
 * Server Action, i Next els encua d'un en un tornant tot el payload de la
 * pàgina: sense esperar, escriure una adreça en dispararia una vintena i la
 * llista aniria sempre una lletra endarrerida. Prou curt perquè aturar-se a
 * mirar el camp ja els mostri.
 */
const SUGGEST_DELAY_MS = 200;

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
  suggestContacts,
}: {
  id: string;
  label: string;
  addresses: string[];
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
      void suggestContacts(fragment).then((found) => {
        if (pending.current === fragment) setSuggestions(found);
      });
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
 * necessiten estat local; l'acció de submit segueix sent el Server Action que
 * rep el formulari com a prop.
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
  approveDraft: (formData: FormData) => void;
  suggestContacts: SuggestContacts;
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
      <RecipientField
        id="toAddresses"
        label="Per a"
        addresses={toAddresses}
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
      <button type="submit" className="btn-primary">
        Enviar
      </button>
    </form>
  );
};
