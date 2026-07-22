// Show the push payload as a notification, nudge any open tab to refetch
// /messages so the chat thread updates without waiting for its poll
// interval, and focus/open the app on click. No caching/offline strategy —
// that's not what this PoC scope is proving.

self.addEventListener("push", (event) => {
  let data = { title: "Agora", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    data = { title: "Agora", body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      // Issues.md: "Do not send notifications if the app is open." A
      // visible tab already sees the message live via the postMessage
      // below (app.js refetches immediately) — a system notification on
      // top of that is pure noise, not a missed-message alert.
      const appIsOpen = clients.some((client) => client.visibilityState === "visible");
      return Promise.all([
        appIsOpen
          ? Promise.resolve()
          : self.registration.showNotification(data.title || "Agora", {
              body: data.body || "",
              icon: "/icon.svg",
              // Carried through to notificationclick below via
              // event.notification.data — not available any other way since
              // the two events are otherwise unrelated as far as the
              // Notification API is concerned.
              data: { conversationId: data.conversationId || null },
            }),
        // Background refresh (no conversation switch) — a message arriving
        // for a conversation Edvard isn't looking at shouldn't yank the view
        // away from what he's currently reading. Switching only happens on
        // an explicit tap, see notificationclick below. Always runs, open
        // tab or not, so a visible tab still live-updates.
        (() => {
          for (const client of clients) client.postMessage({ type: "agora-push" });
        })(),
        // Unread badge (Feature-Ideas.md #43) — best-effort presence signal,
        // not a precise count (a torn-down/restarted service worker can't
        // reliably keep a running total across pushes). app.js clears it on
        // visibilitychange when Edvard actually opens the app. Skipped when
        // the app is already open for the same reason as the notification.
        !appIsOpen && self.navigator && self.navigator.setAppBadge
          ? self.navigator.setAppBadge().catch(() => {})
          : Promise.resolve(),
      ]);
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = event.notification.data && event.notification.data.conversationId;
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ type: "agora-push", conversationId });
          return client.focus();
        }
      }
      const url = conversationId ? `/?conversation=${encodeURIComponent(conversationId)}` : "/";
      return self.clients.openWindow(url);
    }),
  );
});
