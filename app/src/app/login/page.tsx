import { APP_NAME } from "@correu-agent/shared";
import { signIn } from "../../auth";

// Pantalla de login del tauler (context.md §9). Els dos proveïdors són els
// mateixos que fan servir les bústies: Google i Microsoft Entra ID.
const PROVIDERS = [
  { id: "google", label: "Continua amb Google" },
  { id: "microsoft-entra-id", label: "Continua amb Microsoft" },
] as const;

export const metadata = {
  title: `Inicia la sessió · ${APP_NAME}`,
};

export default function LoginPage() {
  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>Inicia la sessió per accedir al tauler.</p>
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
