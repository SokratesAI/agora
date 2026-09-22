import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { usageAgent } from "./server.js";

const config = { port: 8080, agentToken: "agent", appTokens: new Map([["lyceum-key", "Lyceum"]]) };

function req(localPort: number, headers: Record<string, string>): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { socket: { localPort }, get: (n: string) => lower[n.toLowerCase()], header: (n: string) => lower[n.toLowerCase()] } as unknown as Request;
}

describe("usageAgent (issue #287)", () => {
  it("tags a tokenless request on the main port", () => {
    expect(usageAgent(req(8080, { "user-agent": "curl/8" }), config)).toBe("[:8080 no token] curl/8");
    expect(usageAgent(req(8080, {}), config)).toBe("[:8080 no token] (no user-agent)");
  });
  it("tags a wrong token on the main port", () => {
    expect(usageAgent(req(8080, { "user-agent": "curl/8", "x-agora-token": "nope" }), config)).toBe("[:8080 no token] curl/8");
  });
  it("leaves token holders and the tailnet port as they were", () => {
    expect(usageAgent(req(8080, { "user-agent": "urllib", "x-agora-token": "agent" }), config)).toBe("urllib");
    expect(usageAgent(req(8080, { "user-agent": "lyceum", "x-agora-token": "lyceum-key" }), config)).toBe("lyceum");
    expect(usageAgent(req(8085, { "user-agent": "Mozilla/5.0" }), config)).toBe("Mozilla/5.0");
  });
});
