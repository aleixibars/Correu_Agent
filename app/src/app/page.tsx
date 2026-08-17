import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { auth, signOut } from "../auth";
import { LOGIN_PATH } from "../lib/auth/config";

export default async function HomePage() {
  const session = await auth();

  if (!session) {
    return (
      <main>
        <h1>{APP_NAME}</h1>
        <p>
          <Link href={LOGIN_PATH}>Inicia la sessió</Link> per accedir al tauler.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>Sessió iniciada com a {session.user.email}. Tauler en construcció.</p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: LOGIN_PATH });
        }}
      >
        <button type="submit">Tanca la sessió</button>
      </form>
    </main>
  );
}
