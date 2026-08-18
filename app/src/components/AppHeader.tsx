import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { signOut } from "../auth";
import {
  AUTO_REPLY_PATH,
  DASHBOARD_PATH,
  DIGEST_PATH,
  LOGIN_PATH,
  THREADS_PATH,
} from "../lib/auth/config";

const NAV_ITEMS = [
  { href: THREADS_PATH, label: "Fils" },
  { href: DIGEST_PATH, label: "Digest" },
  { href: AUTO_REPLY_PATH, label: "Auto-resposta" },
] as const;

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
      <nav>
        <ul className="app-header__nav">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active === item.href ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
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
