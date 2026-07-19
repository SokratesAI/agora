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
      }),
      self.clients.matchAll({ type: "window" }).then((clients) => {
        for (const client of clients) client.postMessage({ type: "agora-push" });
      }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    }),
  );
});
