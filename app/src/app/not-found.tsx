import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { DASHBOARD_PATH } from "../lib/routes";

export const metadata = {
  title: `Pàgina no trobada · ${APP_NAME}`,
};

// Substitueix el 404 per defecte de Next.js, que no té cap relació visual amb
// la resta del tauler.
export default function NotFound() {
  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      {/* Capçalera reduïda a la marca: aquesta pàgina la pot veure algú sense
          sessió, i la navegació i el botó de tancar sessió d'`AppHeader` no hi
          tenen sentit. També és el que separa el contingut de la banda
          d'avió, com a la resta de pantalles. */}
      <header className="app-header">
        <Link href={DASHBOARD_PATH} className="app-header__wordmark">
          {APP_NAME}
        </Link>
      </header>
      <h1>Aquesta pàgina no existeix</h1>
      <p className="meta">Error 404</p>
      <section className="card">
        <p>
          L&apos;adreça que has seguit no correspon a cap secció del tauler.
        </p>
        <p>
          <Link href={DASHBOARD_PATH} className="btn">
            Torna al tauler
          </Link>
        </p>
      </section>
    </div>
  );
}
