import { describe, expect, it } from "vitest";
import { readComboOptions, normalizeComboOptions, applyComboRequestOptions } from "../../open-sse/services/comboOptions.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("combo thinkingLevels option", () => {
  it("validates, canonicalises order, accepts a comma string and rejects unknown or conflicting values", () => {
    expect(normalizeComboOptions({ thinkingLevels: ["HIGH", " low ", "high"] })).toEqual({ value: { thinkingLevels: ["low", "high"] }, errors: [] });
    expect(normalizeComboOptions({ thinkingLevels: "medium, none" }).value.thinkingLevels).toEqual(["none", "medium"]);
    expect(normalizeComboOptions({ thinkingLevels: [] }).value).toEqual({});
    expect(normalizeComboOptions({ thinkingLevels: ["turbo"] }).errors[0]).toMatch(/not one of/);
    expect(normalizeComboOptions({ thinkingLevels: 5 }).errors[0]).toMatch(/list of levels/);
    expect(normalizeComboOptions({ thinkingLevels: ["low"], reasoningEffort: "high" }).errors.join()).toMatch(/one of the selected/);
    expect(normalizeComboOptions({ thinkingLevels: ["low", "high"], reasoningEffort: "high" }).errors).toEqual([]);
  });

  it("survives the lenient read the DB repo applies on load and save", () => {
    const stored = normalizeComboOptions({ thinkingLevels: ["high", "low"], reasoningEffort: "low" }).value;
    expect(readComboOptions(JSON.parse(JSON.stringify(stored)))).toEqual({ thinkingLevels: ["low", "high"], reasoningEffort: "low" });
  });

  it("a stored invalid level is dropped on read instead of poisoning the combo", () => {
    expect(readComboOptions({ thinkingLevels: ["low", "turbo"], displayName: "x" })).toEqual({ displayName: "x" });
  });
});

describe("ultra is selectable for combos", () => {
  it("is accepted as a default effort and as an advertised level, ordered last", () => {
    expect(normalizeComboOptions({ reasoningEffort: "ULTRA" }).value).toEqual({ reasoningEffort: "ultra" });
    expect(normalizeComboOptions({ thinkingLevels: ["ultra", "high", "max"], reasoningEffort: "ultra" }))
      .toEqual({ value: { thinkingLevels: ["high", "max", "ultra"], reasoningEffort: "ultra" }, errors: [] });
  });

  it("a Gemini request default of ultra uses the largest budget instead of 'unlimited'", () => {
    const out = applyComboRequestOptions({ contents: [] }, { reasoningEffort: "ultra" }, FORMATS.GEMINI).body;
    expect(out.generationConfig.thinkingConfig.thinkingBudget).toBe(128000);
  });
});
