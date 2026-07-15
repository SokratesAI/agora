import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";

// Exposes /metrics on its own port (9464), scraped directly by the
// platform's Prometheus (plain static_configs, no Operator/auto-discovery
// — verified against the live cluster before choosing this over standing
// up a separate OTel Collector). Must be imported before any other module
// that `auto-instrumentations-node` patches (http, express) — see index.ts.
const prometheusExporter = new PrometheusExporter({ port: 9464, endpoint: "/metrics" });

export const sdk = new NodeSDK({
  serviceName: "agora",
  metricReader: prometheusExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
