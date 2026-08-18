// Service worker for Urgent mail notifications (context.md §5). It only has to
// render what the worker pushed and open the thread it points at — the payload
// is built by `notifyUrgentThread` in `shared/`.

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let notification;
  try {
    notification = event.data.json();
  } catch {
    return;
  }

  event.waitUntil(
    self.registration.showNotification(notification.title, {
      body: notification.body,
      // Urgent mail is worth interrupting for, so it stays on screen until the
      // user deals with it rather than auto-dismissing.
      requireInteraction: true,
      data: { url: notification.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data && event.notification.data.url;
  if (!url) return;

  // The dashboard is a desktop tool that tends to be open already, so an
  // existing tab is focused rather than a second one opened.
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        const target = new URL(url, self.location.origin).href;
        const open = windows.find((client) => client.url === target);
        if (open) return open.focus();
        return self.clients.openWindow(target);
      }),
  );
});
