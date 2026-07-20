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
    Promise.all([
      self.registration.showNotification(data.title || "Agora", {
        body: data.body || "",
        icon: "/icon.svg",
        // Carried through to notificationclick below via
        // event.notification.data — not available any other way since the
        // two events are otherwise unrelated as far as the Notification API
        // is concerned.
        data: { conversationId: data.conversationId || null },
      }),
      // Background refresh only (no conversation switch) — a message
      // arriving for a conversation Edvard isn't looking at shouldn't yank
      // the view away from what he's currently reading. Switching only
      // happens on an explicit tap, see notificationclick below.
      self.clients.matchAll({ type: "window" }).then((clients) => {
        for (const client of clients) client.postMessage({ type: "agora-push" });
      }),
    ]),
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
