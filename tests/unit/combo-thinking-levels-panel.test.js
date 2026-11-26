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

  it("round-trips levelModels and drops mappings for unselected or cleared levels", () => {
    const draft = panel.comboOptionsToDraft({
      thinkingLevels: ["low", "high"],
      levelModels: { high: ["cx/gpt-6-sol"], low: ["oc/cheap"] },
    });
    expect(draft.levelModels).toEqual({ high: ["cx/gpt-6-sol"], low: ["oc/cheap"] });
    expect(panel.draftToComboOptions(draft).levelModels).toEqual({ high: ["cx/gpt-6-sol"], low: ["oc/cheap"] });

    const cleared = { ...draft, thinkingLevels: [] };
    expect(panel.draftToComboOptions(cleared).levelModels).toBeUndefined();
    expect(panel.draftToComboOptions(cleared).thinkingLevels).toBeUndefined();

    const partial = { ...draft, thinkingLevels: ["high"] };
    expect(panel.draftToComboOptions(partial).levelModels).toEqual({ high: ["cx/gpt-6-sol"] });
  });

  it("flags a mapping for an unselected level", () => {
    const draft = { ...panel.comboOptionsToDraft({ thinkingLevels: ["low"] }), levelModels: { high: ["x/y"] } };
    expect(panel.validateComboOptionsDraft(draft).levelModels).toMatch(/not a selected/);
  });

  it("carries ultra through unchanged", () => {
    const draft = panel.comboOptionsToDraft({ thinkingLevels: ["max", "ultra"], reasoningEffort: "ultra" });
    expect(panel.draftToComboOptions(draft)).toEqual({ thinkingLevels: ["max", "ultra"], reasoningEffort: "ultra" });
    expect(panel.validateComboOptionsDraft(draft)).toEqual({});
  });
});
