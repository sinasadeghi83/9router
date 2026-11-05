import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => net);

const { resolveCopilotModels, clearCopilotModelCache } = await import("../../open-sse/services/copilotModels.js");

const catalog = [
  { id: "gpt-5.4", name: "GPT 5.4", capabilities: { type: "chat", supports: { reasoning_effort: ["Low", "medium", "HIGH", ""] } }, policy: { state: "enabled" } },
  { id: "gpt-4.1", name: "GPT 4.1", capabilities: { type: "chat", supports: {} } },
  { id: "embed", capabilities: { type: "embeddings" } },
];

describe("copilot live catalog", () => {
  beforeEach(() => {
    clearCopilotModelCache();
    net.proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ data: catalog }), { status: 200 }));
  });

  it("keeps the reasoning efforts Copilot lists per model (normalised) and omits them otherwise", async () => {
    const result = await resolveCopilotModels({ accessToken: "t", providerSpecificData: {} });
    const byId = Object.fromEntries(result.models.map((m) => [m.id, m]));
    expect(byId["gpt-5.4"].thinkingLevels).toEqual(["low", "medium", "high"]);
    expect("thinkingLevels" in byId["gpt-4.1"]).toBe(false);
    expect(byId.embed).toBeUndefined();
  });
});
