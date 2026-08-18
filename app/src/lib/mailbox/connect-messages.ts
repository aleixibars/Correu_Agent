// Catalan copy for the outcome of a mailbox connection, shown on the dashboard
// after Google redirects the user back (context.md §11: dashboard in Catalan).

import type { MailboxConnectionErrorCode } from "./connect-google-mailbox";

/** Value of the `?bustia=` parameter the callback redirects home with. */
export const MAILBOX_STATUS_PARAM = "bustia";
export const MAILBOX_REASON_PARAM = "motiu";
export const MAILBOX_CONNECTED_STATUS = "connectada";
export const MAILBOX_FAILED_STATUS = "error";

/** Reasons the callback reports on top of the ones `connectGoogleMailbox` throws. */
export type MailboxConnectionReason =
  | MailboxConnectionErrorCode
  /** The user pressed "cancel" on Google's consent screen. */
  | "access_denied"
  /** The callback did not answer a request this browser started, or it timed out. */
  | "state_mismatch";

const REASON_MESSAGES: Record<MailboxConnectionReason, string> = {
  access_denied: "Heu cancel·lat la connexió de la bústia.",
  scopes_refused:
    "Cal acceptar els permisos de lectura i d'enviament de Gmail perquè l'agent pugui treballar amb la bústia.",
  state_mismatch:
    "La connexió ha caducat o no s'ha pogut verificar. Torneu-hi des del tauler.",
  oauth_failed: "No s'ha pogut connectar la bústia. Torneu-ho a provar.",
};

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export interface MailboxConnectionNotice {
  ok: boolean;
  text: string;
}

/** `null` when the visitor simply opened the dashboard, so nothing is rendered. */
export const mailboxConnectionNotice = (
  status: string | string[] | undefined,
  reason: string | string[] | undefined,
): MailboxConnectionNotice | null => {
  switch (first(status)) {
    case MAILBOX_CONNECTED_STATUS:
      return { ok: true, text: "Bústia de Gmail connectada." };
    case MAILBOX_FAILED_STATUS:
      return {
        ok: false,
        text:
          REASON_MESSAGES[first(reason) as MailboxConnectionReason] ??
          REASON_MESSAGES.oauth_failed,
      };
    default:
      return null;
  }
};
