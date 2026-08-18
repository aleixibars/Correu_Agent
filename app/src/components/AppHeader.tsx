import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { signOut } from "../auth";
import { DASHBOARD_PATH, LOGIN_PATH } from "../lib/routes";
import { AppNav } from "./AppNav";

/**
 * Shared chrome for every authenticated page: wordmark, section nav and the
 * signed-in user with a sign-out control. Pages pass down the session they
 * already fetched rather than this component calling `auth()` again.
 */
export const AppHeader = ({
  email,
  active,
}: {
  email: string;
  /** Path of the page rendering this header, for the current nav item. */
  active?: string;
}) => (
  <header className="app-header">
    <div className="app-header__brand">
      <Link href={DASHBOARD_PATH} className="app-header__wordmark">
        {APP_NAME}
      </Link>
      <AppNav active={active} />
    </div>
    <div className="app-header__user">
      <span className="meta">{email}</span>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: LOGIN_PATH });
        }}
      >
        <button type="submit" className="btn-ghost">
          Tanca la sessió
        </button>
      </form>
    </div>
  </header>
);
