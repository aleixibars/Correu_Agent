// Fencing untrusted mail inside a prompt. Anyone can send mail to a watched
// inbox, so the mail a model reads is attacker-controlled text: it is wrapped in
// a tag the system prompt names, and mail that writes that tag itself could
// close the fence early and have the rest of it read as the operator talking.
// Telling the model the fence is untrusted does not make the fence unforgeable.

/**
 * Defangs a fence tag inside untrusted text, so `</thread>` in a mail body
 * becomes `(/thread)` instead of ending the fence the prompt opened. Shared by
 * every prompt that shows the model stored mail — a fence only one of them
 * defends is a fence that drifts.
 *
 * `tag` is a literal from the prompt that opened the fence, never user input,
 * so it goes into the pattern as it is.
 */
export const defuseTag = (text: string, tag: string): string =>
  text.replace(new RegExp(`<(/?)${tag}>`, "gi"), `($1${tag})`);
