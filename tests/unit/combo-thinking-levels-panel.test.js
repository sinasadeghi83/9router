import { describe, expect, it } from "vitest";
import * as panel from "../../src/shared/components/comboOptionsDraft.js";

describe("combo panel draft helpers", () => {
  it("round-trips thinkingLevels between stored options, draft and API payload", () => {
    const draft = panel.comboOptionsToDraft({ thinkingLevels: ["low", "high"] });
    expect(draft.thinkingLevels).toEqual(["low", "high"]);
    expect(panel.draftToComboOptions(draft).thinkingLevels).toEqual(["low", "high"]);
    expect(panel.draftToComboOptions(panel.comboOptionsToDraft({})).thinkingLevels).toBeUndefined();
  });

  it("flags a default effort outside the selected levels", () => {
    const draft = { ...panel.comboOptionsToDraft({}), thinkingLevels: ["low"], reasoningEffort: "high" };
    expect(panel.validateComboOptionsDraft(draft).reasoningEffort).toMatch(/selected/);
  });

  it("carries ultra through unchanged", () => {
    const draft = panel.comboOptionsToDraft({ thinkingLevels: ["max", "ultra"], reasoningEffort: "ultra" });
    expect(panel.draftToComboOptions(draft)).toEqual({ thinkingLevels: ["max", "ultra"], reasoningEffort: "ultra" });
    expect(panel.validateComboOptionsDraft(draft)).toEqual({});
  });
});
