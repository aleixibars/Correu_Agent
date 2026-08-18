"use client";

// The one switch a user has over active notifications (context.md §5): this
// browser is subscribed to Urgent mail, or it is not. Everything else is
// covered by the daily digest, so there is nothing per-category to configure.

import { useCallback, useEffect, useState } from "react";
import { applicationServerKey } from "../lib/push/application-server-key";

/** Where the browser registers and drops its subscription. */
export const PUSH_SUBSCRIPTION_PATH = "/api/push";

/** Served from `app/public/`, so it controls the whole dashboard scope. */
const SERVICE_WORKER_PATH = "/sw.js";

type State =
  | "loading"
  | "unconfigured"
  | "unsupported"
  | "blocked"
  | "off"
  | "on"
  | "failed";

const MESSAGES: Record<Exclude<State, "off" | "on">, string> = {
  loading: "Comprovant les notificacions…",
  // Told apart from an old browser: without a VAPID key nothing the visitor
  // does here can help, and saying "your browser" would send them looking.
  unconfigured:
    "Les notificacions no estan configurades en aquest desplegament.",
  unsupported: "Aquest navegador no admet notificacions push.",
  blocked:
    "Heu blocat les notificacions en aquest navegador. Permeteu-les a la configuració del lloc per rebre avisos de correu urgent.",
  failed:
    "Hi ha hagut un problema amb les notificacions d'aquest navegador.",
};

const isSupported = (): boolean =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

// `register` resolves as soon as the registration exists, but `subscribe`
// needs an *activated* worker and is refused with `InvalidStateError` while one
// is still installing — which is exactly the state a first visit is in.
// `ready` is what waits for the activation.
const registration = async (): Promise<ServiceWorkerRegistration> => {
  await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
  return navigator.serviceWorker.ready;
};

export const UrgentPushToggle = ({
  publicKey,
}: {
  /** VAPID public key of this deployment; empty when Web Push is not configured. */
  publicKey: string;
}) => {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);

  // Reads what this browser actually holds. Also the way back from a failure:
  // a failed enable or disable leaves the subscription in an unknown state, so
  // the honest retry is to look again rather than to repeat the attempt.
  const check = useCallback(() => {
    if (publicKey === "") {
      setState("unconfigured");
      return;
    }
    if (!isSupported()) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }

    setState("loading");
    registration()
      .then((worker) => worker.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? "on" : "off"))
      .catch(() => setState("failed"));
  }, [publicKey]);

  useEffect(() => {
    check();
  }, [check]);

  const enable = useCallback(async () => {
    // Asked before subscribing: a browser that refuses the permission would
    // otherwise leave a subscription nothing can ever be shown through.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      // A dismissed prompt is not a block: the browser will ask again, so the
      // button stays instead of sending the user to the site settings for
      // something they never turned off.
      setState(permission === "denied" ? "blocked" : "off");
      return;
    }

    const worker = await registration();
    const subscription = await worker.pushManager.subscribe({
      // Required by every browser: a push may never be silent.
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    });

    const response = await fetch(PUSH_SUBSCRIPTION_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription),
    });
    if (!response.ok) {
      // The server did not keep it, so neither does the browser — otherwise it
      // would look subscribed and never be pushed to.
      await subscription.unsubscribe();
      throw new Error(`Subscription refused with ${response.status}`);
    }
    setState("on");
  }, [publicKey]);

  const disable = useCallback(async () => {
    const worker = await registration();
    const subscription = await worker.pushManager.getSubscription();
    if (subscription) {
      await fetch(PUSH_SUBSCRIPTION_PATH, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
    setState("off");
  }, []);

  const toggle = (action: () => Promise<void>) => () => {
    setBusy(true);
    action()
      .catch((error) => {
        console.error("Could not change the urgent notifications:", error);
        setState("failed");
      })
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <h2>Notificacions de correu urgent</h2>
      {state === "on" ? (
        <>
          <p role="status">
            Rebreu un avís en aquest navegador quan arribi correu urgent.
          </p>
          <button type="button" onClick={toggle(disable)} disabled={busy}>
            Desactiva les notificacions
          </button>
        </>
      ) : state === "off" ? (
        <button type="button" onClick={toggle(enable)} disabled={busy}>
          Activa les notificacions
        </button>
      ) : state === "failed" ? (
        // Kept reachable: without a control here a single network hiccup would
        // strand the section on an error until the page is reloaded.
        <>
          <p role="alert">{MESSAGES.failed}</p>
          <button type="button" onClick={check}>
            Torna-ho a provar
          </button>
        </>
      ) : (
        <p role="status">{MESSAGES[state]}</p>
      )}
    </section>
  );
};
