// Per-thinking-level combo model selection.
//
// A combo may map thinking levels to ordered model lists (options.levelModels).
// The level comes from the request's model suffix (Combo(high)) or, when there
// is no suffix, from an explicit client thinking intent in the body. The combo's
// own default reasoningEffort is NOT an intent: it is applied later as a request
// default and must not reroute a plain request.
//
// Pure module (no I/O) so both the chat handler and tests can use it.

import { parseSuffix, extractThinking } from "../translator/concerns/thinkingUnified.js";
import { budgetToLevel } from "../translator/concerns/thinking.js";

const MODEL_LEVEL_SUFFIX = /\([^()]+\)\s*$/;

function lower(value) {
  return String(value).toLowerCase();
}

/** Suffix override ({mode,level|budget}) -> level name, or null for auto. */
export function levelFromOverride(override) {
  if (!override || typeof override !== "object") return null;
  if (override.mode === "level") return override.level ? lower(override.level) : null;
  if (override.mode === "none") return "none";
  if (override.mode === "budget") {
    const level = budgetToLevel(override.budget);
    return level || "none";
  }
  return null; // auto
}

/** Unified thinking intent -> level name, or null for auto/absent. */
export function levelFromThinkingIntent(intent) {
  if (!intent || typeof intent !== "object") return null;
  if (intent.mode === "level") return intent.level ? lower(intent.level) : null;
  if (intent.mode === "none") return "none";
  if (intent.mode === "budget") {
    const level = budgetToLevel(intent.budget);
    return level || "none";
  }
  return null;
}

/** Parse a trailing thinking suffix off a model string. */
export function parseComboLevelSuffix(modelStr) {
  if (typeof modelStr !== "string" || !modelStr) {
    return { base: modelStr, override: null, level: null };
  }
  const parsed = parseSuffix(modelStr);
  if (!parsed.override) return { base: modelStr, override: null, level: null };
  return {
    base: parsed.cleanModel,
    override: parsed.override,
    level: levelFromOverride(parsed.override),
  };
}

/** Explicit client thinking intent from the request body, as a level name. */
export function explicitLevelFromBody(body) {
  return levelFromThinkingIntent(extractThinking(body));
}

/** Rebuild the canonical suffix for forwarding to the selected member model. */
export function formatLevelSuffix(override) {
  if (!override || typeof override !== "object") return "";
  if (override.mode === "level") return `(${override.level})`;
  if (override.mode === "budget") return `(${override.budget})`;
  if (override.mode === "none") return "(none)";
  if (override.mode === "auto") return "(auto)";
  return "";
}

function mergeMapped(mapped, base) {
  const seen = new Set(mapped);
  return [...mapped, ...base.filter((model) => !seen.has(model))];
}

function appendSuffix(models, override) {
  const suffix = formatLevelSuffix(override);
  if (!suffix) return models;
  return models.map((model) => {
    if (typeof model !== "string") return model;
    // A model that already carries an explicit suffix keeps it.
    if (MODEL_LEVEL_SUFFIX.test(model)) return model;
    return `${model}${suffix}`;
  });
}

/**
 * Resolve the model list a combo request should use, plus diagnostics for logs.
 *
 * @param {{ name?: string, models?: string[], options?: object }} combo
 * @param {{ override?: object|null, level?: string|null }|null} parsedSuffix
 * @param {object} body - client request body (original, before combo defaults)
 * @returns {{ models: string[], requestedLevel: string|null, mappedLevel: string|null, forwardedSuffix: object|null }}
 */
export function resolveComboModelsWithLevel(combo, parsedSuffix, body, explicitLevel = undefined) {
  const base = Array.isArray(combo?.models) ? combo.models.filter((m) => typeof m === "string") : [];
  const levelModels = combo?.options?.levelModels && typeof combo.options.levelModels === "object"
    ? combo.options.levelModels
    : {};

  if (parsedSuffix?.override) {
    const requestedLevel = parsedSuffix.level || null;
    const mapped = requestedLevel ? levelModels[requestedLevel] : null;
    const mappedModels = Array.isArray(mapped) ? mapped.filter((m) => typeof m === "string") : [];
    const models = mappedModels.length ? mergeMapped(mappedModels, base) : base;
    return {
      models: appendSuffix(models, parsedSuffix.override),
      requestedLevel,
      mappedLevel: mappedModels.length ? requestedLevel : null,
      forwardedSuffix: parsedSuffix.override,
    };
  }

  // undefined = derive from the body (direct calls/tests); null = no intent
  // (the handler captured the original client intent before combo defaults).
  const requestedLevel = explicitLevel === undefined ? explicitLevelFromBody(body) : explicitLevel;
  const mapped = requestedLevel ? levelModels[requestedLevel] : null;
  const mappedModels = Array.isArray(mapped) ? mapped.filter((m) => typeof m === "string") : [];
  return {
    models: mappedModels.length ? mergeMapped(mappedModels, base) : base,
    requestedLevel,
    mappedLevel: mappedModels.length ? requestedLevel : null,
    forwardedSuffix: null,
  };
}
