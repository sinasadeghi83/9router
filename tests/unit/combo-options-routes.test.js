// Per-combo options surfaced through /v1/models and applied by the chat handler.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({ combos: [] }));
const mocks = vi.hoisted(() => ({ handleChatCore: vi.fn() }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ connectionId: "conn-1", apiKey: "k" }),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

const okResponse = () => ({ success: true, response: new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "Content-Type": "application/json" } }) });

describe("/v1/models with combo options", () => {
  it("publishes display name, description and overridden limits", async () => {
    fx.combos = [{ name: "fast", models: ["openai/gpt-4o"], options: { displayName: "Fast Coder", description: "quick", contextWindow: 64000, maxOutputTokens: 4096 } }];
    const entry = (await buildModelsList(["llm"])).find((m) => m.id === "fast");
    expect(entry).toMatchObject({
      name: "Fast Coder", display_name: "Fast Coder", description: "quick",
      context_length: 64000, max_completion_tokens: 4096,
      capabilities: { contextWindow: 64000, maxOutput: 4096 },
    });
  });

  it("overrides one limit and derives the other", async () => {
    fx.combos = [{ name: "half", models: ["openai/gpt-4o"], options: { contextWindow: 50000 } }];
    const derived = (await buildModelsList(["llm"]));
    fx.combos = [{ name: "half", models: ["openai/gpt-4o"] }];
    const plain = (await buildModelsList(["llm"])).find((m) => m.id === "half");
    const entry = derived.find((m) => m.id === "half");
    expect(entry.context_length).toBe(50000);
    expect(entry.max_completion_tokens).toBe(plain.max_completion_tokens);
  });

  it("carries a nested combo's override outward", async () => {
    fx.combos = [
      { name: "inner", models: ["openai/gpt-4o"], options: { contextWindow: 32000 } },
      { name: "outer", models: ["inner"] },
    ];
    const entry = (await buildModelsList(["llm"])).find((m) => m.id === "outer");
    expect(entry.context_length).toBe(32000);
  });

  it("omits hidden combos from the list", async () => {
    fx.combos = [{ name: "secret", models: ["openai/gpt-4o"], options: { hidden: true } }];
    expect((await buildModelsList(["llm"])).find((m) => m.id === "secret")).toBeUndefined();
  });
});

describe("chat applies combo request options", () => {
  beforeEach(() => {
    mocks.handleChatCore.mockReset();
    mocks.handleChatCore.mockImplementation(async () => okResponse());
  });

  const post = (path, body) => new Request(`http://localhost${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("fills defaults and caps max_tokens for an OpenAI request", async () => {
    fx.combos = [{ name: "tuned", models: ["openai/gpt-4o"], options: { maxOutputTokens: 2000, temperature: 0.1 } }];
    const res = await handleChat(post("/v1/chat/completions", { model: "tuned", max_tokens: 50000, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    const sent = mocks.handleChatCore.mock.calls[0][0].body;
    expect(sent.max_tokens).toBe(2000);
    expect(sent.temperature).toBe(0.1);
  });

  it("uses Responses field names on /v1/responses", async () => {
    fx.combos = [{ name: "tuned", models: ["openai/gpt-4o"], options: { maxOutputTokens: 3000 } }];
    await handleChat(post("/v1/responses", { model: "tuned", input: "hi" }));
    const sent = mocks.handleChatCore.mock.calls[0][0].body;
    expect(sent.max_output_tokens).toBe(3000);
    expect(sent.max_tokens).toBeUndefined();
  });

  it("leaves a direct provider/model request untouched", async () => {
    fx.combos = [{ name: "tuned", models: ["openai/gpt-4o"], options: { temperature: 0.1 } }];
    await handleChat(post("/v1/chat/completions", { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }));
    expect(mocks.handleChatCore.mock.calls[0][0].body.temperature).toBeUndefined();
  });

  it("still routes a hidden combo", async () => {
    fx.combos = [{ name: "secret", models: ["openai/gpt-4o"], options: { hidden: true } }];
    const res = await handleChat(post("/v1/chat/completions", { model: "secret", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalled();
  });
});
