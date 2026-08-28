// Where each screen of the dashboard lives. Deliberately kept out of the
// Auth.js configuration next door: that module value-imports the Auth.js
// providers, so a Client Component asking it for a path (`app/error.tsx`) would
// drag the whole auth stack into the browser bundle.

/** Where an unauthenticated visitor is sent, and where the login buttons live. */
export const LOGIN_PATH = "/login";

/** Where a visitor lands once signed in. */
export const DASHBOARD_PATH = "/";

/** The processed-thread list of the dashboard (context.md §2). */
export const THREADS_PATH = "/fils";

/** One thread with its draft, where it is reviewed and approved (context.md §2). */
export const threadPath = (threadId: string): string =>
  `${THREADS_PATH}/${encodeURIComponent(threadId)}`;

/** The daily digest, read inside the dashboard and never mailed (context.md §5). */
export const DIGEST_PATH = "/digest";

/** Where the per-category auto-reply switches are configured (context.md §2). */
export const AUTO_REPLY_PATH = "/auto-resposta";

/** What tells a download apart from a preview on `attachmentPath`. */
export const ATTACHMENT_DOWNLOAD_PARAM = "descarrega";

/**
 * Where the browser asks for one attachment. Not a screen: the route is the way
 * to bytes the provider still holds and the product deliberately never stores
 * (context.md §7).
 */
export const attachmentPath = (attachmentId: string): string =>
  `/api/adjunts/${encodeURIComponent(attachmentId)}`;

/** The same attachment, asked for to be saved to disk rather than to be read here. */
export const attachmentDownloadPath = (attachmentId: string): string =>
  `${attachmentPath(attachmentId)}?${ATTACHMENT_DOWNLOAD_PARAM}=1`;
