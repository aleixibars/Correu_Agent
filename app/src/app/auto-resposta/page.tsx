import { redirect } from "next/navigation";
import {
  APP_NAME,
  TRIAGE_CATEGORIES,
  isAutoDiscardEligible,
  isAutoReplyEligible,
} from "@correu-agent/shared";
import { listAutoReplyRules } from "@correu-agent/shared/auto-reply";
import { listAutoDiscardRules } from "@correu-agent/shared/auto-discard";
import { auth } from "../../auth";
import { AUTO_REPLY_PATH, LOGIN_PATH } from "../../lib/routes";
import { db } from "../../lib/db";
import { AppHeader } from "../../components/AppHeader";
import { CategoryStamp } from "../../components/CategoryStamp";
import { saveAutoDiscardRule, saveAutoReplyRule } from "./actions";
import { UrgentPushToggle } from "../urgent-push";

export const metadata = {
  title: `Configuració · ${APP_NAME}`,
};

// Les categories que no són mai elegibles (context.md §2) es llisten, però
// sense cap control: així la pantalla explica per què no hi són en lloc de
// deixar-les fora sense dir res.
const INELIGIBLE_CATEGORIES = TRIAGE_CATEGORIES.filter(
  (category) => !isAutoReplyEligible(category),
);

// Urgent és l'única categoria mai elegible per descart automàtic (context.md
// §4) — el mateix invariant que `INELIGIBLE_CATEGORIES` aplica a l'auto-resposta.
const DISCARD_INELIGIBLE_CATEGORIES = TRIAGE_CATEGORIES.filter(
  (category) => !isAutoDiscardEligible(category),
);

export default async function AutoReplyPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const rules = await listAutoReplyRules(db, session.user.tenantId);
  const discardRules = await listAutoDiscardRules(db, session.user.tenantId);

  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      <AppHeader email={session.user.email ?? ""} active={AUTO_REPLY_PATH} />
      <h1>Configuració</h1>

      <h2>Resposta automàtica</h2>
      <p>
        Amb una regla activada, els correus d'aquesta categoria es responen
        sols, sense revisió ni aprovació prèvia. Es desactiva quan vulguis.
      </p>
      {rules.map(({ category, enabled, instructions }) => (
        <section key={category} className="card">
          <h3>
            <CategoryStamp category={category} />
          </h3>
          <form action={saveAutoReplyRule}>
            <input type="hidden" name="category" value={category} />
            <div className="switch-row">
              <input
                type="checkbox"
                id={`enabled-${category}`}
                name="enabled"
                defaultChecked={enabled}
              />
              <label htmlFor={`enabled-${category}`}>
                Respon automàticament els fils d'aquesta categoria
              </label>
            </div>
            <div className="field">
              <label htmlFor={`instructions-${category}`}>
                Instruccions per a aquestes respostes (opcional)
              </label>
              <textarea
                id={`instructions-${category}`}
                name="instructions"
                rows={3}
                defaultValue={instructions ?? ""}
              />
            </div>
            <button type="submit" className="btn-primary">
              Desa
            </button>
          </form>
        </section>
      ))}
      <section className="card">
        <h3>Categories sense resposta automàtica</h3>
        <p>
          Aquestes categories no es responen mai soles: les de risc necessiten
          sempre una persona i els butlletins no necessiten resposta.
        </p>
        <p>
          {INELIGIBLE_CATEGORIES.map((category) => (
            <span key={category} style={{ marginRight: 8 }}>
              <CategoryStamp category={category} muted />
            </span>
          ))}
        </p>
      </section>

      <h2>Descart automàtic</h2>
      <p>
        Amb una regla activada, els fils d'aquesta categoria (que compleixin els
        remitents o paraules clau, si n'hi ha) es descarten sols, sense generar
        mai un esborrany ni necessitar revisió humana.
      </p>
      {discardRules.map(({ category, enabled, senderPatterns, keywordPatterns }) => (
        <section key={category} className="card">
          <h3>
            <CategoryStamp category={category} />
          </h3>
          <form action={saveAutoDiscardRule}>
            <input type="hidden" name="category" value={category} />
            <div className="switch-row">
              <input
                type="checkbox"
                id={`discard-enabled-${category}`}
                name="enabled"
                defaultChecked={enabled}
              />
              <label htmlFor={`discard-enabled-${category}`}>
                Descarta automàticament els fils d'aquesta categoria
              </label>
            </div>
            <div className="field">
              <label htmlFor={`discard-senders-${category}`}>
                Remitents (opcional, un per línia o separats per comes)
              </label>
              <textarea
                id={`discard-senders-${category}`}
                name="senderPatterns"
                rows={3}
                defaultValue={senderPatterns.join("\n")}
              />
            </div>
            <div className="field">
              <label htmlFor={`discard-keywords-${category}`}>
                Paraules clau a l'assumpte (opcional, una per línia o separades
                per comes)
              </label>
              <textarea
                id={`discard-keywords-${category}`}
                name="keywordPatterns"
                rows={3}
                defaultValue={keywordPatterns.join("\n")}
              />
            </div>
            <button type="submit" className="btn-primary">
              Desa
            </button>
          </form>
        </section>
      ))}
      <section className="card">
        <h3>Categories sense descart automàtic</h3>
        <p>
          Els fils urgents no es descarten mai sols: sempre necessiten una
          persona (context.md §4).
        </p>
        <p>
          {DISCARD_INELIGIBLE_CATEGORIES.map((category) => (
            <span key={category} style={{ marginRight: 8 }}>
              <CategoryStamp category={category} muted />
            </span>
          ))}
        </p>
      </section>

      {/* Read here rather than in the client component: the key is public,
          but only a Server Component can reach the environment it lives in. */}
      <UrgentPushToggle publicKey={process.env.VAPID_PUBLIC_KEY ?? ""} />
    </div>
  );
}
