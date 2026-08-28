"use client";

import { useState } from "react";
import type { DraftOption } from "@correu-agent/shared/db/schema";
import { DraftOptionsForm } from "./DraftOptionsForm";

/**
 * Les etapes de la revisió: primer la tria, després la resposta editable i,
 * si el revisor la vol canviar, el comentari que la torna a generar.
 */
type Stage = "choose" | "reply" | "refine";

/**
 * La revisió d'un esborrany pendent, pas a pas (context.md §2): en obrir el
 * fil només hi ha el missatge i la tria Respondre/Descartar; el text editable
 * i el quadre de refinar apareixen quan el revisor tria, no tots alhora.
 * Component de client perquè l'etapa és estat local; les accions segueixen sent
 * els Server Actions que rep com a props, sense cap canvi de comportament.
 *
 * L'autoguardat del text (issue #75) viu al formulari editable, que només es
 * munta en arribar a l'etapa de resposta: mentre el revisor encara tria, no hi
 * ha res escrit que es pugui perdre.
 */
export const DraftReviewStages = ({
  draftId,
  body,
  options,
  approveDraft,
  rejectDraft,
  regenerateDraftWithFeedback,
  saveDraftEdit,
}: {
  draftId: string;
  /** El text d'on parteix l'edició: l'últim autoguardat, o el del model. */
  body: string;
  options: DraftOption[];
  approveDraft: (formData: FormData) => void;
  rejectDraft: (formData: FormData) => void;
  regenerateDraftWithFeedback: (formData: FormData) => void;
  saveDraftEdit: (formData: FormData) => Promise<void>;
}) => {
  const [stage, setStage] = useState<Stage>("choose");

  // Refinar desa un esborrany nou (un altre id) i refresca la pàgina amb ell:
  // qui l'ha demanat ja havia triat respondre, així que torna a Enviar/Refinar
  // amb el text nou i no a la tria inicial.
  const [reviewedDraftId, setReviewedDraftId] = useState(draftId);
  if (reviewedDraftId !== draftId) {
    setReviewedDraftId(draftId);
    setStage("reply");
  }

  if (stage === "choose") {
    return (
      <>
        <p>
          Hi ha una resposta escrita per a aquest fil: en respondre la podràs
          llegir i editar abans que s&apos;enviï al remitent.
        </p>
        <div className="row-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => setStage("reply")}
          >
            Respondre
          </button>
          {/* Descartar deixa el fil sense resposta i torna al tauler: és
              l'acció que tanca la revisió, no una que n'obri una altra. */}
          <form action={rejectDraft}>
            <input type="hidden" name="draftId" value={draftId} />
            <button type="submit" className="btn-ghost">
              Descartar
            </button>
          </form>
        </div>
      </>
    );
  }

  return (
    <>
      <p>
        {options.length > 1
          ? "Tria una de les respostes proposades i edita-la si cal: en enviar-la, arriba al remitent del fil."
          : "Edita el text si cal: en enviar-lo, la resposta arriba al remitent del fil."}
      </p>
      {/* Keyed on the draft, not just present unconditionally: regenerating
          writes a *new* draft row (a different id) in the same JSX position,
          so without this React reconciles the old textarea in place instead
          of remounting it — and the field's state only starts from the draft
          on mount, so it would keep showing the rejected text until the
          reader refreshed by hand. */}
      <DraftOptionsForm
        key={draftId}
        draftId={draftId}
        body={body}
        options={options}
        approveDraft={approveDraft}
        saveDraftEdit={saveDraftEdit}
      />
      {/* Botó i formularis germans i no imbricats: l'HTML no permet imbricar
          formularis, i cada botó envia només el seu camp. */}
      <button
        type="button"
        style={{ marginTop: 14 }}
        onClick={() => setStage("refine")}
      >
        Refinar
      </button>
      {stage === "refine" && (
        <form action={regenerateDraftWithFeedback} style={{ marginTop: 14 }}>
          <input type="hidden" name="draftId" value={draftId} />
          <div className="field">
            <label htmlFor="feedback">Què vols canviar de l&apos;esborrany</label>
            <textarea id="feedback" name="feedback" rows={3} required />
          </div>
          <button type="submit">Regenera amb aquest comentari</button>
        </form>
      )}
    </>
  );
};
