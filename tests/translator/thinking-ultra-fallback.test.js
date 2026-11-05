// "ultra" is native only on models that declare it (Codex GPT-5.6 sol/terra). Everywhere
// else the translator maps it to the strongest level the model accepts, so it can never
// reach a provider as an invalid value or fall through to an unlimited budget.
import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const apply = (target, model, body, provider) => applyThinking(target, model, body, provider);

describe("ultra on the wire", () => {
  it("stays ultra where the model declares it (Codex GPT-5.6 sol)", () => {
    expect(apply("openai-responses", "gpt-5.6-sol", { reasoning: { effort: "ultra" } }, "codex").reasoning_effort).toBe("ultra");
  });

  it("becomes max for a Claude adaptive model instead of an invalid 'ultra' effort", () => {
    const out = apply("claude", "claude-opus-5", { reasoning_effort: "ultra" }, "claude");
    expect(out.output_config.effort).toBe("max");
  });

  it("becomes xhigh/high when the model has no max (Claude Opus 4.6), never ultra", () => {
    const out = apply("claude", "claude-opus-4-6", { reasoning_effort: "ultra" }, "claude");
    expect(["max", "xhigh", "high"]).toContain(out.output_config.effort);
    expect(out.output_config.effort).not.toBe("ultra");
  });

  it("never lets the word 'ultra' reach a non-declaring model's body", () => {
    const out = apply("claude", "claude-opus-5", { reasoning_effort: "ultra" }, "claude");
    expect(JSON.stringify(out)).not.toMatch(/ultra/);
  });

  it("the model(ultra) suffix behaves the same on a non-ultra model", () => {
    const out = apply("claude", "claude-opus-5(ultra)", {}, "claude");
    expect(out.output_config.effort).toBe("max");
  });
});
