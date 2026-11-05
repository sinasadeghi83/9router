import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  toUnixSeconds, toRfc3339, intersectLevels, openAIEfforts, resolveModelThinkingLevels,
  buildSupportedParameters, anthropicCapabilityBlocks, decorateModelEntry, deriveComboThinkingLevels,
} from "../../open-sse/providers/modelListMeta.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

const { buildModelsList, GET } = await import("../../src/app/api/v1/models/route.js");
const { GET: getOne, DELETE } = await import("../../src/app/api/v1/models/[...model]/route.js");
const { GET: getInfo } = await import("../../src/app/api/v1/models/info/route.js");

const params = (model) => ({ params: Promise.resolve({ model }) });
const conn = (provider, enabledModels) => ({ id: provider, provider, isActive: true, providerSpecificData: { enabledModels } });

beforeEach(() => {
  db.getProviderConnections.mockResolvedValue([conn("codex", ["gpt-6-sol"]), conn("opencode-go", ["deepseek-v4.1-flash"])]);
  db.getCombos.mockResolvedValue([]);
});

describe("modelListMeta helpers", () => {
  it("normalises timestamps to unix seconds", () => {
    expect(toUnixSeconds("2026-11-05T00:00:00Z")).toBe(1793836800);
    expect(toUnixSeconds(1793836800000)).toBe(1793836800);
    expect(toUnixSeconds(1793836800)).toBe(1793836800);
    expect(toUnixSeconds(undefined)).toBe(0);
    expect(toUnixSeconds("garbage")).toBe(0);
    expect(toRfc3339(0)).toBe("1970-01-01T00:00:00Z");
  });

  it("intersects levels in first-list order and ignores empty lists", () => {
    expect(intersectLevels([["none", "low", "high"], ["low", "high", "max"]])).toEqual(["low", "high"]);
    expect(intersectLevels([["low"], ["high"]])).toBeNull();
    expect(intersectLevels([[], null])).toBeNull();
    expect(intersectLevels([["low", "high"]])).toEqual(["low", "high"]);
  });

  it("keeps only OpenAI reasoning_effort values in reasoning_efforts", () => {
    expect(openAIEfforts(["none", "low", "ultra", "thinking", "max"])).toEqual(["none", "low", "max"]);
  });

  it("prefers live levels, then static, then infers for live reasoning models, else null", () => {
    expect(resolveModelThinkingLevels("github", "x-model", { liveCaps: { thinkingLevels: ["low", "high"] } }))
      .toEqual({ levels: ["low", "high"], source: "live" });
    expect(resolveModelThinkingLevels("codex", "gpt-6-sol").source).toBe("static");
    expect(resolveModelThinkingLevels("qoder", "unknown-x", { liveCaps: { reasoning: true } }))
      .toEqual({ levels: ["none", "low", "medium", "high"], source: "inferred" });
    expect(resolveModelThinkingLevels("openai", "gpt-4o-mini")).toBeNull();
  });

  it("emits Anthropic effort/thinking blocks that agree with the levels", () => {
    const blocks = anthropicCapabilityBlocks({ vision: true, thinkingCanDisable: false }, ["low", "high"]);
    expect(blocks.effort).toMatchObject({ supported: true, low: { supported: true }, medium: { supported: false }, high: { supported: true } });
    expect(blocks.thinking).toMatchObject({ supported: true, types: { adaptive: { supported: true }, disabled: { supported: false } } });
    expect(blocks.image_input).toEqual({ supported: true });
    const plain = anthropicCapabilityBlocks({}, null);
    expect(plain.thinking.supported).toBe(false);
    expect(plain.thinking.types.disabled.supported).toBe(true);
  });

  it("builds OpenRouter supported_parameters", () => {
    expect(buildSupportedParameters({ tools: true }, { levels: ["low", "high"] }))
      .toEqual(["max_tokens", "tools", "tool_choice", "reasoning", "include_reasoning", "reasoning_effort"]);
    expect(buildSupportedParameters({ tools: false }, null)).toEqual(["max_tokens"]);
    expect(buildSupportedParameters({ tools: true }, { levels: ["thinking"] })).not.toContain("reasoning_effort");
  });

  it("does not mutate the caps object it was given and keeps Kiro's boolean flag", () => {
    const caps = { thinking: true, reasoning: true, tools: true };
    const entry = decorateModelEntry({ id: "kr/x", object: "model", owned_by: "kr" }, { caps, levelInfo: { levels: ["low"], source: "live" } });
    expect(caps.thinking).toBe(true);
    expect(entry.capabilities.thinkingVariant).toBe(true);
    expect(entry.capabilities.thinking.supported).toBe(true);
  });
});

describe("/v1/models entries", () => {
  it("carry every required OpenAI field plus null shutdown_date", async () => {
    const list = await buildModelsList(["llm"]);
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) {
      expect(m).toMatchObject({ object: "model", type: "model", shutdown_date: null });
      expect(Number.isInteger(m.created)).toBe(true);
      expect(typeof m.owned_by).toBe("string");
      expect(typeof m.display_name).toBe("string");
      expect(m.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it("publishes thinking levels, reasoning_efforts and supported_parameters for a reasoning model", async () => {
    const list = await buildModelsList(["llm"]);
    const sol = list.find((m) => m.id.endsWith("/gpt-6-sol"));
    expect(sol.capabilities.thinkingLevels).toContain("high");
    expect(sol.capabilities.thinkingLevelsSource).toBe("static");
    expect(sol.reasoning_efforts).toEqual(sol.capabilities.thinkingLevels.filter((l) => l !== "ultra" && l !== "thinking"));
    expect(sol.supported_parameters).toContain("reasoning_effort");
    expect(sol.max_input_tokens).toBe(sol.context_length);
  });

  it("uses the combo creation time and the levels every reasoning seat accepts", async () => {
    db.getCombos.mockResolvedValue([{ name: "mix", createdAt: "2026-11-01T00:00:00.000Z", models: ["cx/gpt-6-sol", "ocg/deepseek-v4.1-flash"] }]);
    const list = await buildModelsList(["llm"]);
    const combo = list.find((m) => m.id === "mix");
    const cx = list.find((m) => m.id.endsWith("/gpt-6-sol")).capabilities.thinkingLevels;
    const ds = list.find((m) => m.id.endsWith("/deepseek-v4.1-flash")).capabilities.thinkingLevels;
    expect(combo.created).toBe(toUnixSeconds("2026-11-01T00:00:00.000Z"));
    expect(combo.capabilities.thinkingLevels).toEqual(cx.filter((l) => ds.includes(l)));
  });

  it("builds only the requested model when retrieving by id", async () => {
    const list = await buildModelsList(["llm"], { id: "cx/gpt-6-sol" });
    expect(list.map((m) => m.id)).toEqual(["cx/gpt-6-sol"]);
  });
});

describe("HTTP behaviour", () => {
  it("list envelope is OpenAI-valid and Anthropic-paginator friendly, with cache + CORS headers", async () => {
    const res = await GET(new Request("https://r.test/v1/models"));
    const body = await res.json();
    expect(body).toMatchObject({ object: "list", has_more: false });
    expect(body.first_id).toBe(body.data[0].id);
    expect(body.last_id).toBe(body.data.at(-1).id);
    expect(res.headers.get("Cache-Control")).toContain("max-age");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("?kind=all widens the list and an unknown kind is a 400 with param+code", async () => {
    const bad = await GET(new Request("https://r.test/v1/models?kind=nonsense"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatchObject({ type: "invalid_request_error", param: "kind", code: "invalid_value" });
    expect((await GET(new Request("https://r.test/v1/models?kind=all"))).status).toBe(200);
  });

  it("retrieve returns a hidden combo and 404s with all four error fields", async () => {
    db.getCombos.mockResolvedValue([{ name: "secret", models: ["cx/gpt-6-sol"], options: { hidden: true } }]);
    expect((await getOne(new Request("https://r.test/v1/models/secret"), params(["secret"]))).status).toBe(200);
    expect((await (await GET(new Request("https://r.test/v1/models"))).json()).data.some((m) => m.id === "secret")).toBe(false);
    const miss = await getOne(new Request("https://r.test/v1/models/cx/none"), params(["cx", "none"]));
    expect(miss.status).toBe(404);
    expect((await miss.json()).error).toEqual({
      message: expect.any(String), type: "invalid_request_error", param: "model", code: "model_not_found",
    });
  });

  it("a combo named like a kind slug stays retrievable; the slug still lists otherwise", async () => {
    db.getCombos.mockResolvedValue([{ name: "image", models: ["cx/gpt-6-sol"] }]);
    expect((await (await getOne(new Request("https://r.test/v1/models/image"), params(["image"]))).json()).id).toBe("image");
    db.getCombos.mockResolvedValue([]);
    expect((await (await getOne(new Request("https://r.test/v1/models/image"), params(["image"]))).json()).object).toBe("list");
  });

  it("DELETE answers with an OpenAI-shaped 405", async () => {
    const res = await DELETE(new Request("https://r.test/v1/models/ft:x", { method: "DELETE" }), params(["ft:x"]));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, OPTIONS");
    expect((await res.json()).error).toMatchObject({ type: "invalid_request_error", code: "method_not_allowed", param: "model" });
  });

  it("/models/info uses OpenAI error types", async () => {
    const res = await getInfo(new Request("https://r.test/v1/models/info?id=cx/does-not-exist"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatchObject({ type: "invalid_request_error", code: "model_not_found", param: "id" });
    expect((await getInfo(new Request("https://r.test/v1/models/info"))).status).toBe(400);
  });
});

describe("combo thinking levels on /v1/models", () => {
  it("deriveComboThinkingLevels is cycle-safe and ignores non-reasoning seats", () => {
    const a = { name: "a", models: ["b", "cx/gpt-6-sol"] };
    const b = { name: "b", models: ["a", "cx/gpt-6-sol"] };
    const lookup = (n) => ({ a, b })[n];
    const levels = deriveComboThinkingLevels(a, lookup, (x) => (x === "cx" ? "codex" : x));
    expect(levels).toEqual(resolveModelThinkingLevels("codex", "gpt-6-sol").levels);
    expect(deriveComboThinkingLevels({ name: "p", models: ["openai/gpt-4o-mini"] }, () => null)).toBeNull();
  });

  it("the user's levels override the derived set and mark the combo as reasoning", async () => {
    db.getCombos.mockResolvedValue([
      { name: "picked", models: ["cx/gpt-6-sol"], options: { thinkingLevels: ["low", "high"] } },
      { name: "plain", models: ["openai/gpt-4o-mini"], options: { thinkingLevels: ["medium"] } },
    ]);
    const list = await buildModelsList(["llm"]);
    const picked = list.find((m) => m.id === "picked");
    expect(picked.capabilities.thinkingLevels).toEqual(["low", "high"]);
    expect(picked.capabilities.thinkingLevelsSource).toBe("combo-settings");
    expect(picked.reasoning_efforts).toEqual(["low", "high"]);
    expect(picked.supported_parameters).toContain("reasoning_effort");
    const plain = list.find((m) => m.id === "plain");
    expect(plain.capabilities.reasoning).toBe(true);
    expect(plain.capabilities.thinkingLevels).toEqual(["medium"]);
  });
});
