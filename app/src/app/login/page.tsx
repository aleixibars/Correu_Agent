import { APP_NAME } from "@correu-agent/shared";
import { signIn } from "../../auth";
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

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>Inicia la sessió per accedir al tauler.</p>
      {message !== null && <p role="alert">{message}</p>}
      {PROVIDERS.map(({ id, label }) => (
        <form
          key={id}
          action={async () => {
            "use server";
            await signIn(id, { redirectTo: "/" });
          }}
        >
          <button type="submit">{label}</button>
        </form>
      ))}
    </main>
  );
}
