/**
 * Whether this process exports spans, and where to.
 *
 * This exists because the SDK's default is invisible and wrong here.
 * `NodeSDK` builds its span processors from `OTEL_TRACES_EXPORTER` when the
 * caller passes neither `traceExporter` nor `spanProcessors`, and that
 * variable defaults to `otlp` — read out of the installed sdk-node 0.220.0
 * at `build/src/utils.js:135`, not inferred from the docs. So a process that
 * configures only a `metricReader`, as `instrumentation.ts` did from the day
 * it was written, still stands up an OTLP trace exporter and posts every
 * batch of auto-instrumentation spans at `http://localhost:4318/v1/traces`,
 * where nothing is listening. Nothing logs it: the SDK reports export
 * failures through `diag`, which is off unless a log level is set.
 *
 * That is the failure this repo keeps paying for in other shapes — a default
 * that is silently doing the wrong thing reads exactly like a feature that
 * was never switched on. A reader of `instrumentation.ts` would have said
 * "agora emits no spans"; it emitted them into a socket that refuses.
 *
 * So the destination is a deployment decision, spelled out: with
 * `OTEL_EXPORTER_OTLP_ENDPOINT` set the SDK's env-driven OTLP exporter is
 * what we want and we let it build it; with the variable absent — every test
 * run and every `npm run dev` — we pass an empty processor list, which makes
 * `NodeSDK` register no tracer provider at all rather than one that retries
 * against a dead port.
 */

import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";

export const ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";

/**
 * The part of the `NodeSDK` config that decides trace export.
 *
 * Returns `{}` when a collector is configured — the SDK reads the endpoint
 * and protocol out of the environment itself, and passing them again here
 * would give one variable two behaviours. Returns an empty `spanProcessors`
 * list otherwise, which is the switch that turns export off.
 */
export function traceExportConfig(
  env: NodeJS.ProcessEnv = process.env,
): Partial<NodeSDKConfiguration> {
  const endpoint = (env[ENDPOINT_ENV] ?? "").trim();
  return endpoint ? {} : { spanProcessors: [] };
}
