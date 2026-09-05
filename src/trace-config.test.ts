// Agora must not export spans to a collector nobody configured.
//
// The regression this guards is a default, not a line of code: with neither
// `traceExporter` nor `spanProcessors` passed, `NodeSDK` reads
// `OTEL_TRACES_EXPORTER`, which defaults to `otlp`, and builds an exporter
// pointed at localhost:4318. Deleting the spread in instrumentation.ts
// therefore breaks nothing visibly — no error, no log line — which is why
// the assertion is on the config object rather than on any behaviour.

import { describe, expect, it } from "vitest";
import { ENDPOINT_ENV, traceExportConfig } from "./trace-config.js";

describe("traceExportConfig", () => {
  it("turns export off when no collector endpoint is set", () => {
    expect(traceExportConfig({})).toEqual({ spanProcessors: [] });
  });

  it("treats a blank or whitespace endpoint as unset", () => {
    expect(traceExportConfig({ [ENDPOINT_ENV]: "   " })).toEqual({ spanProcessors: [] });
  });

  it("leaves the SDK's own env-driven exporter alone when an endpoint is set", () => {
    const config = traceExportConfig({
      [ENDPOINT_ENV]: "http://otel-collector.infra.svc.cluster.local:4318",
    });
    expect(config).toEqual({});
    // Not just "empty": the key that switches export off must be absent, or
    // setting the endpoint would still send spans nowhere.
    expect("spanProcessors" in config).toBe(false);
  });
});
