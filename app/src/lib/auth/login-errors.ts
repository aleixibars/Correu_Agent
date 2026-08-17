// Catalan copy for the `?error=` parameter Auth.js appends when it sends a
// visitor back to the login page (context.md §11: dashboard in Catalan).
// Without this the visitor lands on Auth.js's own English error page and an
// allowlist rejection looks like a broken button.

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: "Aquest compte no té accés al tauler.",
  Configuration:
    "La configuració d'inici de sessió no és correcta. Reviseu les variables d'entorn del servidor.",
  Verification: "L'enllaç d'inici de sessió ja no és vàlid.",
};

const UNKNOWN_ERROR_MESSAGE =
  "No s'ha pogut iniciar la sessió. Torneu-ho a provar.";

/** `null` when there is no error to show, so the page renders nothing. */
export const loginErrorMessage = (
  error: string | string[] | undefined,
): string | null => {
  const code = Array.isArray(error) ? error[0] : error;
  if (code === undefined || code === "") return null;
  return LOGIN_ERROR_MESSAGES[code] ?? UNKNOWN_ERROR_MESSAGE;
};
