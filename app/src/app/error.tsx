"use client";

import { APP_NAME } from "@correu-agent/shared";
import { DASHBOARD_PATH } from "../lib/routes";

// Substitueix la pantalla d'error per defecte de Next.js. Ha de ser un Client
// Component: Next hi passa la funció que torna a intentar el render fallit.
// Per això només importa constants de rutes (`lib/routes`) i mai la
// configuració d'Auth.js: aquest mòdul viatja al navegador amb cada pàgina.
export default function ErrorPage({
  error,
  reset,
}: {
  // Next only forwards the digest of an error thrown on the server; the
  // message itself is stripped before it reaches the browser.
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      {/* Igual que al 404: només la marca, perquè el visitant pot no tenir
          sessió i perquè el contingut no quedi enganxat a la banda d'avió. */}
      <header className="app-header">
        {/* Plain anchors, not `next/link`: the render that failed is still
            mounted, so a full page load is the more reliable way out. */}
        <a href={DASHBOARD_PATH} className="app-header__wordmark">
          {APP_NAME}
        </a>
      </header>
      <h1>Alguna cosa ha fallat</h1>
      <section className="card">
        <p>No hem pogut carregar aquesta pàgina. Torna-ho a provar.</p>
        {error.digest !== undefined && (
          <p className="meta">Referència: {error.digest}</p>
        )}
        <p>
          <button type="button" className="btn-primary" onClick={reset}>
            Torna-ho a provar
          </button>{" "}
          <a href={DASHBOARD_PATH} className="btn">
            Torna al tauler
          </a>
        </p>
      </section>
    </div>
  );
}
