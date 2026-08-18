// Drives `app/public/sw.js` the way the browser does. The file ships as plain
// JavaScript to the browser, so it is read and evaluated here against a stubbed
// `self` rather than imported — there is nothing in it to import.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(
  new URL("../../../public/sw.js", import.meta.url),
  "utf8",
);

const ORIGIN = "https://tauler.example";

type Listener = (event: unknown) => void;

type Client = {
  url: string;
  focus: () => Promise<Client>;
  navigate?: (url: string) => Promise<Client | null>;
};

const client = (path: string, navigate?: Client["navigate"]): Client => {
  const instance: Client = {
    url: `${ORIGIN}${path}`,
    focus: vi.fn(async () => instance),
    ...(navigate ? { navigate: vi.fn(navigate) } : {}),
  };
  return instance;
};

const load = (windows: Client[]) => {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);

  const self = {
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, listener),
    location: { origin: ORIGIN },
    registration: { showNotification },
    clients: { matchAll: vi.fn(async () => windows), openWindow },
  };
  new Function("self", SOURCE)(self);

  // Every handler wraps its work in `waitUntil`, which is what keeps the worker
  // alive; the test awaits the same promise.
  const dispatch = async (type: string, event: object): Promise<void> => {
    let work: unknown = undefined;
    listeners.get(type)!({ ...event, waitUntil: (p: unknown) => (work = p) });
    await work;
  };

  return { dispatch, showNotification, openWindow };
};

const NOTIFICATION = {
  title: "Correu urgent",
  body: "client@example.com: Servidor caigut",
  url: "/fils",
};

const push = (payload: unknown) => ({
  data: {
    json: () => {
      if (typeof payload === "string") throw new SyntaxError("not JSON");
      return payload;
    },
  },
});

const clicked = (data: unknown) => ({
  notification: { close: vi.fn(), data },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("push", () => {
  it("shows what the worker sent, kept on screen until it is dealt with", async () => {
    const { dispatch, showNotification } = load([]);

    await dispatch("push", push(NOTIFICATION));

    expect(showNotification).toHaveBeenCalledWith(NOTIFICATION.title, {
      body: NOTIFICATION.body,
      requireInteraction: true,
      data: { url: NOTIFICATION.url },
    });
  });

  it("shows nothing for a push with no payload", async () => {
    const { dispatch, showNotification } = load([]);

    await dispatch("push", { data: null });

    expect(showNotification).not.toHaveBeenCalled();
  });

  // A push service can wake the worker with anything; a throw here would be an
  // unhandled rejection in the browser rather than a notification.
  it("shows nothing for a payload that is not JSON", async () => {
    const { dispatch, showNotification } = load([]);

    await dispatch("push", push("<html>error</html>"));

    expect(showNotification).not.toHaveBeenCalled();
  });
});

describe("notificationclick", () => {
  it("focuses a window already on the target page", async () => {
    const open = client("/fils");
    const { dispatch, openWindow } = load([open]);

    await dispatch("notificationclick", clicked({ url: "/fils" }));

    expect(open.focus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  // The toggle lives on `/`, so that is where the open dashboard tab usually
  // is: matching the target URL alone would open a duplicate tab every time.
  it("navigates the open dashboard rather than opening a second window", async () => {
    const dashboard = client("/", async (url) => client(url.replace(ORIGIN, "")));
    const { dispatch, openWindow } = load([dashboard]);

    await dispatch("notificationclick", clicked({ url: "/fils" }));

    expect(dashboard.navigate).toHaveBeenCalledWith(`${ORIGIN}/fils`);
    expect(openWindow).not.toHaveBeenCalled();
  });

  // `navigate` is refused for a window this worker does not control, which is
  // every window opened before the worker was installed.
  it("opens a window when the existing one refuses to be navigated", async () => {
    const dashboard = client("/", async () => {
      throw new TypeError("client is not controlled");
    });
    const { dispatch, openWindow } = load([dashboard]);

    await dispatch("notificationclick", clicked({ url: "/fils" }));

    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/fils`);
  });

  it("opens a window when the dashboard is not open at all", async () => {
    const { dispatch, openWindow } = load([]);

    await dispatch("notificationclick", clicked({ url: "/fils" }));

    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/fils`);
  });

  it("opens nothing when the notification names no page", async () => {
    const { dispatch, openWindow } = load([client("/")]);

    await dispatch("notificationclick", clicked(undefined));

    expect(openWindow).not.toHaveBeenCalled();
  });
});
