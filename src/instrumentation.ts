import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { traceExportConfig } from "./trace-config.js";

// Exposes /metrics on its own port (9464), scraped directly by the
// platform's Prometheus (plain static_configs, no Operator/auto-discovery
// — verified against the live cluster before choosing this over standing
// up a separate OTel Collector). Must be imported before any other module
// that `auto-instrumentations-node` patches (http, express) — see index.ts.
const prometheusExporter = new PrometheusExporter({ port: 9464, endpoint: "/metrics" });

export const sdk = new NodeSDK({
  serviceName: "agora",
  metricReader: prometheusExporter,
  // Spans go to the collector when OTEL_EXPORTER_OTLP_ENDPOINT names one and
  // nowhere at all when it does not. Read trace-config.ts before changing
  // this: leaving it out is not "no tracing", it is an OTLP exporter aimed
  // at localhost.
  ...traceExportConfig(),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
