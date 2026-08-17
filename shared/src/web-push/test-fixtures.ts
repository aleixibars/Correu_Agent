// Throwaway VAPID keypair generated for tests only (`npx web-push
// generate-vapid-keys`) — never used against a real push service.
export const TEST_VAPID_ENV: Record<string, string | undefined> = {
  VAPID_PUBLIC_KEY:
    "BA_rL-8vsyX92TBCCZtsf_fN7N4EH0qwHsuyYj83i5E1g4RYBeKBYDEwUPPiabWgnwvIt46du0fbLM0BI_w9lMA",
  VAPID_PRIVATE_KEY: "12tmEkl0aZuSvA_aPetyjM3XG7lxLoq7DM3nixkrsBk",
  VAPID_SUBJECT: "mailto:notificacions@correu-agent.example",
};

// Shape a browser's PushManager.subscribe() hands back, as JSON.
export const TEST_PUSH_SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: {
    p256dh:
      "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
} as const;
