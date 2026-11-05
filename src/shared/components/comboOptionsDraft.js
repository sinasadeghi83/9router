// Pure draft helpers for the combo settings panel (no React/JSX, so they are unit-testable).
import { COMBO_OPTION_LIMITS } from "open-sse/services/comboOptions.js";

// Form state keeps raw strings so partially typed numbers survive re-renders.
export function comboOptionsToDraft(options = {}) {
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  return {
    displayName: str(options.displayName),
    description: str(options.description),
    contextWindow: str(options.contextWindow),
    maxOutputTokens: str(options.maxOutputTokens),
    temperature: str(options.temperature),
    topP: str(options.topP),
    reasoningEffort: options.reasoningEffort || "",
    thinkingLevels: Array.isArray(options.thinkingLevels) ? [...options.thinkingLevels] : [],
    hidden: !!options.hidden,
  };
}

// Draft → API payload. Empty strings are dropped; the server validates the rest.
export function draftToComboOptions(draft) {
  const out = {};
  const text = (k) => { const v = draft[k]?.trim(); if (v) out[k] = v; };
  const num = (k) => { const v = draft[k]?.trim(); if (v) out[k] = Number(v); };
  text("displayName");
  text("description");
  num("contextWindow");
  num("maxOutputTokens");
  num("temperature");
  num("topP");
  if (draft.reasoningEffort) out.reasoningEffort = draft.reasoningEffort;
  if (Array.isArray(draft.thinkingLevels) && draft.thinkingLevels.length > 0) out.thinkingLevels = draft.thinkingLevels;
  if (draft.hidden) out.hidden = true;
  return out;
}

// Client-side mirror of the server rules, for inline errors only.
export function validateComboOptionsDraft(draft) {
  const errors = {};
  const L = COMBO_OPTION_LIMITS;
  const checkNum = (key, { min, max, integer }) => {
    const raw = draft[key]?.trim();
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) errors[key] = "Must be a number";
    else if (integer && !Number.isInteger(n)) errors[key] = "Must be a whole number";
    else if (n < min || n > max) errors[key] = `Between ${min.toLocaleString()} and ${max.toLocaleString()}`;
  };
  checkNum("contextWindow", { ...L.contextWindow, integer: true });
  checkNum("maxOutputTokens", { ...L.maxOutputTokens, integer: true });
  checkNum("temperature", L.temperature);
  checkNum("topP", L.topP);
  if ((draft.displayName || "").trim().length > L.displayName.maxLength) errors.displayName = `At most ${L.displayName.maxLength} characters`;
  if ((draft.description || "").trim().length > L.description.maxLength) errors.description = `At most ${L.description.maxLength} characters`;
  if (draft.reasoningEffort && Array.isArray(draft.thinkingLevels) && draft.thinkingLevels.length > 0
    && !draft.thinkingLevels.includes(draft.reasoningEffort)) {
    errors.reasoningEffort = "Must be one of the selected thinking levels";
  }
  return errors;
}

export function countComboOptions(draft) {
  return Object.keys(draftToComboOptions(draft)).length;
}
