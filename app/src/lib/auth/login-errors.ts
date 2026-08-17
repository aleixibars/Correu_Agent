// Catalan copy for the `?error=` parameter Auth.js appends when it sends a
// visitor back to the login page (context.md §11: dashboard in Catalan).
// Without this the visitor lands on Auth.js's own English error page and an
// allowlist rejection looks like a broken button.

// The address is already linked to the other provider. Auth.js refuses to join
// the two accounts on its own (`allowDangerousEmailAccountLinking` is off), and
// with Google and Microsoft both on the login page and a single allowlisted
// address, this is the likeliest refusal after `AccessDenied` — the generic
// "try again" copy would be wrong, since retrying the same provider never works.
const ALREADY_LINKED_MESSAGE =
  "Aquesta adreça ja està vinculada a l'altre proveïdor. Inicieu la sessió amb el mateix proveïdor que vau fer servir la primera vegada.";

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: "Aquest compte no té accés al tauler.",
  AccountNotLinked: ALREADY_LINKED_MESSAGE,
  OAuthAccountNotLinked: ALREADY_LINKED_MESSAGE,
  Configuration:
    "La configuració d'inici de sessió no és correcta. Reviseu les variables d'entorn del servidor.",
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
