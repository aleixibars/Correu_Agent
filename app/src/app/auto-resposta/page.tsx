import Link from "next/link";
import { redirect } from "next/navigation";
import {
  APP_NAME,
  TRIAGE_CATEGORIES,
  isAutoReplyEligible,
} from "@correu-agent/shared";
import { listAutoReplyRules } from "@correu-agent/shared/auto-reply";
import { auth } from "../../auth";
import { DASHBOARD_PATH, LOGIN_PATH } from "../../lib/auth/config";
import { categoryLabel } from "../../lib/category-labels";
import { db } from "../../lib/db";
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
    <main>
      <h1>Resposta automàtica</h1>
      <p>
        Amb una regla activada, els correus d'aquesta categoria es responen
        sols, sense revisió ni aprovació prèvia. Es desactiva quan vulguis.
      </p>
      {rules.map(({ category, enabled, instructions }) => (
        <section key={category}>
          <h2>{categoryLabel(category)}</h2>
          <form action={saveAutoReplyRule}>
            <input type="hidden" name="category" value={category} />
            <p>
              <input
                type="checkbox"
                id={`enabled-${category}`}
                name="enabled"
                defaultChecked={enabled}
              />{" "}
              <label htmlFor={`enabled-${category}`}>
                Respon automàticament els fils d'aquesta categoria
              </label>
            </p>
            <p>
              <label htmlFor={`instructions-${category}`}>
                Instruccions per a aquestes respostes (opcional)
              </label>
              <textarea
                id={`instructions-${category}`}
                name="instructions"
                rows={3}
                defaultValue={instructions ?? ""}
              />
            </p>
            <button type="submit">Desa</button>
          </form>
        </section>
      ))}
      <section>
        <h2>Categories sense resposta automàtica</h2>
        <p>
          Aquestes categories no es responen mai soles: les de risc necessiten
          sempre una persona i els butlletins no necessiten resposta.
        </p>
        <ul>
          {INELIGIBLE_CATEGORIES.map((category) => (
            <li key={category}>{categoryLabel(category)}</li>
          ))}
        </ul>
      </section>
      <p>
        <Link href={DASHBOARD_PATH}>Torna al tauler</Link>
      </p>
    </main>
  );
}
