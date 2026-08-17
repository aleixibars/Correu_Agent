// VAPID credentials for Web Push (context.md §5). Keys are generated once per
// deployment with `npm run generate-vapid-keys` and stored as environment
// variables — never committed.

export type VapidConfig = {
  /** Application server public key, also handed to the browser at subscribe time. */
  publicKey: string;
  privateKey: string;
  /** Contact URL for the push service: `mailto:...` or `https://...`. */
  subject: string;
};

type Env = Record<string, string | undefined>;

const required = (env: Env, name: string): string => {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable ${name} (Web Push / VAPID)`);
  }
  return value;
};

export const loadVapidConfig = (env: Env): VapidConfig => {
  const subject = required(env, "VAPID_SUBJECT");
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error(
      "VAPID_SUBJECT must be a mailto: or https:// URL identifying the sender",
    );
  }

  return {
    publicKey: required(env, "VAPID_PUBLIC_KEY"),
    privateKey: required(env, "VAPID_PRIVATE_KEY"),
    subject,
  };
};
