// Per-level combo routing: suffix/body level selection and the mapped model list.
import { describe, expect, it } from "vitest";
import {
  parseComboLevelSuffix,
  levelFromOverride,
  explicitLevelFromBody,
  formatLevelSuffix,
  resolveComboModelsWithLevel,
} from "../../open-sse/services/comboLevels.js";

const combo = (levelModels, models = ["base/a", "base/b"]) => ({
  name: "tuned",
  models,
  options: levelModels ? { levelModels } : {},
});

describe("parseComboLevelSuffix", () => {
  it("parses level, budget, none and auto suffixes", () => {
    expect(parseComboLevelSuffix("tuned(high)")).toMatchObject({ base: "tuned", level: "high", override: { mode: "level" } });
    expect(parseComboLevelSuffix("tuned(8192)")).toMatchObject({ base: "tuned", level: "medium", override: { mode: "budget", budget: 8192 } });
    expect(parseComboLevelSuffix("tuned(0)")).toMatchObject({ base: "tuned", level: "none" });
    expect(parseComboLevelSuffix("tuned(none)")).toMatchObject({ base: "tuned", level: "none" });
    expect(parseComboLevelSuffix("tuned(auto)")).toMatchObject({ base: "tuned", level: null, override: { mode: "auto" } });
  });

  it("ignores an unknown parenthesised tail so a non-suffix name is untouched", () => {
    expect(parseComboLevelSuffix("tuned(turbo)")).toEqual({ base: "tuned(turbo)", override: null, level: null });
    expect(parseComboLevelSuffix("plain")).toEqual({ base: "plain", override: null, level: null });
  });
});

describe("levelFromOverride / explicitLevelFromBody", () => {
  it("maps override modes", () => {
    expect(levelFromOverride({ mode: "level", level: "HIGH" })).toBe("high");
    expect(levelFromOverride({ mode: "none" })).toBe("none");
    expect(levelFromOverride({ mode: "budget", budget: 24576 })).toBe("high");
    expect(levelFromOverride({ mode: "auto" })).toBeNull();
    expect(levelFromOverride(null)).toBeNull();
  });

  it("reads explicit client intent from the common body shapes", () => {
    expect(explicitLevelFromBody({ reasoning_effort: "high" })).toBe("high");
    expect(explicitLevelFromBody({ output_config: { effort: "max" } })).toBe("max");
    expect(explicitLevelFromBody({ thinking: { type: "enabled", budget_tokens: 24576 } })).toBe("high");
    expect(explicitLevelFromBody({ generationConfig: { thinkingConfig: { thinkingLevel: "xhigh" } } })).toBe("xhigh");
    expect(explicitLevelFromBody({ enable_thinking: false })).toBe("none");
    expect(explicitLevelFromBody({ reasoning: { effort: "auto" } })).toBeNull();
    expect(explicitLevelFromBody({ messages: [] })).toBeNull();
  });
});

describe("resolveComboModelsWithLevel", () => {
  it("puts the mapped level models first, then the base list, and forwards the suffix", () => {
    const parsed = parseComboLevelSuffix("tuned(high)");
    const out = resolveComboModelsWithLevel(combo({ high: ["fast/b"] }), parsed, { messages: [] });
    expect(out).toMatchObject({ requestedLevel: "high", mappedLevel: "high" });
    expect(out.models).toEqual(["fast/b(high)", "base/a(high)", "base/b(high)"]);
  });

  it("keeps the base list when the requested level is not mapped, still forwarding the suffix", () => {
    const parsed = parseComboLevelSuffix("tuned(low)");
    const out = resolveComboModelsWithLevel(combo({ high: ["fast/b"] }), parsed, { messages: [] });
    expect(out.mappedLevel).toBeNull();
    expect(out.models).toEqual(["base/a(low)", "base/b(low)"]);
  });

  it("uses explicit body intent without appending a suffix", () => {
    const out = resolveComboModelsWithLevel(combo({ high: ["fast/b"] }), null, { reasoning_effort: "high" });
    expect(out.mappedLevel).toBe("high");
    expect(out.models).toEqual(["fast/b", "base/a", "base/b"]);
  });

  it("never treats a pre-captured null intent as a body hint (combo default isolation)", () => {
    const out = resolveComboModelsWithLevel(combo({ high: ["fast/b"] }), null, { reasoning_effort: "high" }, null);
    expect(out.mappedLevel).toBeNull();
    expect(out.models).toEqual(["base/a", "base/b"]);
  });

  it("preserves an explicit per-model suffix instead of doubling it", () => {
    const parsed = parseComboLevelSuffix("tuned(high)");
    const out = resolveComboModelsWithLevel(combo({ high: ["fast/b(max)"] }), parsed, { messages: [] });
    expect(out.models[0]).toBe("fast/b(max)");
    expect(out.models).toEqual(["fast/b(max)", "base/a(high)", "base/b(high)"]);
  });

  it("de-duplicates mapped models already present in the base list", () => {
    const parsed = parseComboLevelSuffix("tuned(high)");
    const out = resolveComboModelsWithLevel(combo({ high: ["base/a"] }), parsed, { messages: [] });
    expect(out.models).toEqual(["base/a(high)", "base/b(high)"]);
  });

  it("formats suffixes for every override mode", () => {
    expect(formatLevelSuffix({ mode: "level", level: "high" })).toBe("(high)");
    expect(formatLevelSuffix({ mode: "budget", budget: 8192 })).toBe("(8192)");
    expect(formatLevelSuffix({ mode: "none" })).toBe("(none)");
    expect(formatLevelSuffix({ mode: "auto" })).toBe("(auto)");
  });
});
