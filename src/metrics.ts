import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("agora");

export const notificationsSent = meter.createCounter("agora_notifications_sent_total", {
  description: "Push notifications successfully sent via /notify",
});

export const notificationsFailed = meter.createCounter("agora_notifications_failed_total", {
  description: "Push notification send attempts that failed",
});

export const repliesReceived = meter.createCounter("agora_replies_received_total", {
  description: "Replies received via /reply",
});

export const subscriptionsRegistered = meter.createCounter("agora_subscriptions_registered_total", {
  description: "Push subscriptions registered via /subscribe",
});
