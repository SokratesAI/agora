// PoC scope: show the push payload as a notification, and focus/open the
// app on click. No caching/offline strategy yet — that's not what this PoC
// is proving (see Agora's Roadmap.md Phase 1 Definition of Done).

self.addEventListener("push", (event) => {
  let data = { title: "Agora", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    data = { title: "Agora", body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Agora", {
      body: data.body || "",
      icon: "/icon.svg",
    }),
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
