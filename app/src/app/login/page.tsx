import { redirect } from "next/navigation";
import { APP_NAME } from "@correu-agent/shared";
import { auth, signIn } from "../../auth";
import { DASHBOARD_PATH } from "../../lib/routes";
import { loginErrorMessage } from "../../lib/auth/login-errors";

// Pantalla de login del tauler (context.md §9). Els dos proveïdors són els
// mateixos que fan servir les bústies: Google i Microsoft Entra ID.
const PROVIDERS = [
  { id: "google", label: "Continua amb Google" },
  { id: "microsoft-entra-id", label: "Continua amb Microsoft" },
] as const;

export const metadata = {
  title: `Inicia la sessió · ${APP_NAME}`,
};

export default async function LoginPage({
  searchParams,
}: {
  // Auth.js redirects here with `?error=…` when a login is refused.
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const message = loginErrorMessage((await searchParams).error);

  // Auth.js sends the visitor back here after a successful login too, and a
  // second set of login buttons is a dead end — carry them on to the dashboard.
  // An error still gets shown first: bouncing on it would swallow the only
  // explanation the visitor gets for a refused login.
  if (message === null && (await auth())) redirect(DASHBOARD_PATH);

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="airmail-stripe" style={{ margin: "-32px -30px 24px" }} />
        <span className="app-header__wordmark">{APP_NAME}</span>
        <p>Inicia la sessió per accedir al tauler.</p>
        {message !== null && <p role="alert">{message}</p>}
        {PROVIDERS.map(({ id, label }) => (
          <form
            key={id}
            action={async () => {
              "use server";
              await signIn(id, { redirectTo: DASHBOARD_PATH });
            }}
          >
            <button type="submit">{label}</button>
          </form>
        ))}
      </div>
    </div>
  );
}
