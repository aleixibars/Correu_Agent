// Where this deployment is reachable from the outside. Both mailbox flows need
// it: an OAuth provider matches the redirect URI against the registered one
// character for character, and Render terminates TLS at a proxy, so the request
// URL carries an internal host.

/**
 * The public URL is configuration (`AUTH_URL`, the same variable Auth.js reads),
 * with the request origin as the local fallback — never a forwarded header,
 * which the client controls on the way in.
 */
export const publicAppUrl = (
  request: Request,
  path: string,
  env: Record<string, string | undefined> = process.env,
): string =>
  new URL(path, env.AUTH_URL ?? new URL(request.url).origin).toString();
