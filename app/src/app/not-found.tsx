import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { DASHBOARD_PATH } from "../lib/auth/config";

export const metadata = {
  title: `Pàgina no trobada · ${APP_NAME}`,
};

// Substitueix el 404 per defecte de Next.js, que no té cap relació visual amb
// la resta del tauler.
export default function NotFound() {
  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      <section className="card">
        <p className="meta">Error 404</p>
        <h2>Aquesta pàgina no existeix</h2>
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
