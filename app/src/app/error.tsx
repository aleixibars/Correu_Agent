"use client";

import { DASHBOARD_PATH } from "../lib/auth/config";

// Substitueix la pantalla d'error per defecte de Next.js. Ha de ser un Client
// Component: Next hi passa la funció que torna a intentar el render fallit.
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
      <section className="card">
        <p className="meta">Error</p>
        <h2>Alguna cosa ha fallat</h2>
        <p>No hem pogut carregar aquesta pàgina. Torna-ho a provar.</p>
        {error.digest !== undefined && (
          <p className="meta">Referència: {error.digest}</p>
        )}
        <p>
          <button type="button" className="btn-primary" onClick={reset}>
            Torna-ho a provar
          </button>{" "}
          {/* Plain anchor, not `next/link`: the render that failed is still
              mounted, so a full page load is the more reliable way out. */}
          <a href={DASHBOARD_PATH} className="btn">
            Torna al tauler
          </a>
        </p>
      </section>
    </div>
  );
}
