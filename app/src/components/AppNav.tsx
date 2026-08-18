import Link from "next/link";
import {
  AUTO_REPLY_PATH,
  DIGEST_PATH,
  THREADS_PATH,
} from "../lib/routes";

const NAV_ITEMS = [
  { href: THREADS_PATH, label: "Fils" },
  { href: DIGEST_PATH, label: "Digest" },
  { href: AUTO_REPLY_PATH, label: "Auto-resposta" },
] as const;

/**
 * Section nav of the dashboard. It needs neither the session nor a query, so
 * the loading fallbacks can show the real links while their page is still
 * being read — the reader is never trapped on a screen of placeholder bars.
 */
export const AppNav = ({
  /** Path of the page rendering this nav, for the current item. */
  active,
}: {
  active?: string;
}) => (
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
);
