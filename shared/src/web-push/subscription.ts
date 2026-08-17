// A browser push subscription as it arrives from the dashboard when a user
// enables Urgent notifications (context.md §5). Validated here so a route
// handler stays thin and nothing unchecked reaches the database.

export type PushSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Push subscription is missing ${field}`);
  }
  return value;
};

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

export const parsePushSubscription = (input: unknown): PushSubscription => {
  if (typeof input !== "object" || input === null) {
    throw new Error("Push subscription must be an object");
  }

  const { endpoint, keys } = input as { endpoint?: unknown; keys?: unknown };
  const parsedEndpoint = requiredString(endpoint, "endpoint");
  if (!isHttpsUrl(parsedEndpoint)) {
    throw new Error("Push subscription endpoint must be an https:// URL");
  }

  if (typeof keys !== "object" || keys === null) {
    throw new Error("Push subscription is missing keys");
  }
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };

  return {
    endpoint: parsedEndpoint,
    keys: {
      p256dh: requiredString(p256dh, "keys.p256dh"),
      auth: requiredString(auth, "keys.auth"),
    },
  };
};
