import Link from "next/link";
import { APP_NAME } from "@correu-agent/shared";
import { DASHBOARD_PATH } from "../lib/auth/config";
import { AppNav } from "./AppNav";

/**
 * The header of `AppHeader` as a `loading.tsx` fallback can render it: same
 * chrome, minus the parts that need the session. The wordmark and the nav are
 * static, so they stay real and clickable; only the signed-in address and its
 * sign-out control are still loading, and those are left as an outline.
 */
export const AppHeaderSkeleton = ({
  /** Path of the page rendering this header, for the current nav item. */
  active,
}: {
  active?: string;
}) => (
  <header className="app-header">
    <div className="app-header__brand">
      <Link href={DASHBOARD_PATH} className="app-header__wordmark">
        {APP_NAME}
      </Link>
      <AppNav active={active} />
    </div>
    <div className="app-header__user" aria-hidden="true">
      <span className="skeleton skeleton--pill" />
    </div>
  </header>
);
