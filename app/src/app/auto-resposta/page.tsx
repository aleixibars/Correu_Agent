import { redirect } from "next/navigation";
import {
  APP_NAME,
  TRIAGE_CATEGORIES,
  isAutoReplyEligible,
} from "@correu-agent/shared";
import { listAutoReplyRules } from "@correu-agent/shared/auto-reply";
import { auth } from "../../auth";
import { AUTO_REPLY_PATH, LOGIN_PATH } from "../../lib/routes";
import { db } from "../../lib/db";
import { AppHeader } from "../../components/AppHeader";
import { CategoryStamp } from "../../components/CategoryStamp";
import { saveAutoReplyRule } from "./actions";

export const metadata = {
  title: `Auto-resposta · ${APP_NAME}`,
};

// Les categories que no són mai elegibles (context.md §2) es llisten, però
// sense cap control: així la pantalla explica per què no hi són en lloc de
// deixar-les fora sense dir res.
const INELIGIBLE_CATEGORIES = TRIAGE_CATEGORIES.filter(
  (category) => !isAutoReplyEligible(category),
);

export default async function AutoReplyPage() {
  const session = await auth();
  if (!session) redirect(LOGIN_PATH);

  const rules = await listAutoReplyRules(db, session.user.tenantId);

  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      <AppHeader email={session.user.email ?? ""} active={AUTO_REPLY_PATH} />
      <h1>Resposta automàtica</h1>
      <p>
        Amb una regla activada, els correus d'aquesta categoria es responen
        sols, sense revisió ni aprovació prèvia. Es desactiva quan vulguis.
      </p>
      {rules.map(({ category, enabled, instructions }) => (
        <section key={category} className="card">
          <h2>
            <CategoryStamp category={category} />
          </h2>
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
        <h2>Categories sense resposta automàtica</h2>
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
    </div>
  );
}
