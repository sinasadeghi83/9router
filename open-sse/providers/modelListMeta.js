// Standard-compatible metadata for the /v1/models list — pure helpers, no I/O.
//
// One entry is meant to be readable by every client family without 9router-specific
// knowledge:
//   • OpenAI      id / object / created / owned_by / shutdown_date
//   • Anthropic   type / display_name / created_at / max_input_tokens / max_tokens
//                 + capabilities.{effort,thinking,image_input,pdf_input}
//   • OpenRouter  name / context_length / supported_parameters
//   • 9router     capabilities.{thinkingLevels,thinkingFormat,...} (full level set,
//                 including the suffix-only "ultra"/"thinking" levels)
// Thinking levels come from getThinkingLevels (the same source the dashboard picker
// and the wire translator use), so what is published is what the gateway accepts.
import { getThinkingLevels } from "./thinkingLevels.js";

// OpenAI's reasoning_effort enum. A strict SDK can only send these, so
// `reasoning_efforts` is limited to them; 9router-only levels ("ultra", "thinking")
// stay in capabilities.thinkingLevels and are reachable through the model(level) suffix.
export const OPENAI_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const OPENAI_EFFORT_SET = new Set(OPENAI_REASONING_EFFORTS);

// Effort keys Anthropic's capabilities.effort object carries.
const ANTHROPIC_EFFORT_KEYS = ["low", "medium", "high", "xhigh", "max"];

// Same default set getThinkingLevels falls back to for an unknown reasoning format.
const INFERRED_LEVELS = ["none", "low", "medium", "high"];

/** Seconds since epoch from seconds, milliseconds, a Date string or Date; 0 when unknown. */
export function toUnixSeconds(value) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 1e11 ? value / 1000 : value);
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return 0;
}

/** RFC 3339 (second precision, Z) — Anthropic's created_at format. */
export function toRfc3339(seconds) {
  return new Date((Number.isFinite(seconds) ? seconds : 0) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function sanitizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return Array.from(new Set(
    levels.filter((l) => typeof l === "string" && l.trim()).map((l) => l.trim().toLowerCase())
  ));
}

/**
 * Thinking levels a model accepts, or null when it does not reason.
 *   live      the upstream catalog itself listed the levels (caps.thinkingLevels)
 *   static    9router's pattern table (getThinkingLevels)
 *   inferred  a live catalog says the model reasons but nothing lists levels
 * @param {string} provider provider id
 * @param {string} model model id (no provider prefix)
 * @param {{ caps?: object|null, liveCaps?: object|null }} [ctx]
 * @returns {{ levels: string[], source: "live"|"static"|"inferred" } | null}
 */
export function resolveModelThinkingLevels(provider, model, { caps = null, liveCaps = null } = {}) {
  const live = sanitizeLevels(liveCaps?.thinkingLevels);
  if (live.length) return { levels: live, source: "live" };
  if (caps?.reasoning === false) return null;
  const known = getThinkingLevels(provider, model);
  if (known) return { levels: known, source: "static" };
  if (liveCaps?.reasoning === true) {
    const levels = caps?.thinkingCanDisable === false ? INFERRED_LEVELS.filter((l) => l !== "none") : INFERRED_LEVELS;
    return { levels, source: "inferred" };
  }
  return null;
}

/**
 * Levels every list accepts, in the first list's order; null when there is none.
 * A combo can only honour a level its reasoning seats all take.
 */
export function intersectLevels(lists) {
  const valid = (lists || []).filter((l) => Array.isArray(l) && l.length > 0);
  if (valid.length === 0) return null;
  const [first, ...rest] = valid;
  const out = first.filter((level) => rest.every((l) => l.includes(level)));
  return out.length > 0 ? out : null;
}

/**
 * Levels a combo can honour: those every reasoning seat accepts. A seat that does not
 * reason ignores an effort hint, so it does not narrow the set. Nested combo names
 * recurse (cycle-guarded). Shared by /v1/models and the dashboard, so the panel shows
 * exactly what the API would publish when the user has not overridden it.
 * @param {{ name?: string, models?: string[] }} combo
 * @param {(name: string) => { name?: string, models?: string[] } | null | undefined} lookupCombo
 * @param {(alias: string) => string} [resolveProvider] seat alias → provider id
 */
export function deriveComboThinkingLevels(combo, lookupCombo, resolveProvider = (a) => a, visiting = new Set()) {
  const name = typeof combo?.name === "string" ? combo.name : null;
  if (name) {
    if (visiting.has(name)) return null;
    visiting.add(name);
  }
  const lists = [];
  try {
    for (const seat of Array.isArray(combo?.models) ? combo.models : []) {
      if (typeof seat !== "string") continue;
      const slash = seat.indexOf("/");
      if (slash <= 0) {
        const nested = lookupCombo?.(seat);
        if (nested) {
          const nestedLevels = deriveComboThinkingLevels(nested, lookupCombo, resolveProvider, visiting);
          if (nestedLevels) lists.push(nestedLevels);
          continue;
        }
      }
      const provider = slash > 0 ? resolveProvider(seat.slice(0, slash)) : null;
      const found = resolveModelThinkingLevels(provider, slash > 0 ? seat.slice(slash + 1) : seat);
      if (found) lists.push(found.levels);
    }
  } finally {
    if (name) visiting.delete(name);
  }
  return intersectLevels(lists);
}

/** The subset of levels that is valid for OpenAI's reasoning_effort. */
export function openAIEfforts(levels) {
  return (levels || []).filter((l) => OPENAI_EFFORT_SET.has(l));
}

/** OpenRouter-style supported_parameters for an LLM entry. */
export function buildSupportedParameters(caps, levelInfo) {
  const params = ["max_tokens"];
  if (caps?.tools !== false) {
    params.push("tools");
    if (caps?.forcedToolChoice !== false) params.push("tool_choice");
  }
  if (levelInfo || caps?.reasoning === true) {
    params.push("reasoning", "include_reasoning");
    if (openAIEfforts(levelInfo?.levels).some((l) => l !== "none")) params.push("reasoning_effort");
  }
  return params;
}

/**
 * Anthropic-shaped capability blocks. They describe what a client can send *to this
 * gateway*: the translator maps every thinking.type / effort onto the provider's own
 * wire format, so "enabled" and "adaptive" are accepted for any reasoning model.
 * Returned separately so callers can merge them without mutating shared caps objects.
 */
export function anthropicCapabilityBlocks(caps, levels) {
  const supported = (value) => ({ supported: Boolean(value) });
  const reasons = Array.isArray(levels) && levels.length > 0;
  const effort = { supported: reasons && levels.some((l) => ANTHROPIC_EFFORT_KEYS.includes(l)) };
  for (const key of ANTHROPIC_EFFORT_KEYS) effort[key] = supported(reasons && levels.includes(key));
  return {
    effort,
    thinking: {
      supported: reasons,
      types: {
        adaptive: supported(reasons),
        enabled: supported(reasons),
        // Anthropic: true on a model that does not think at all.
        disabled: supported(!reasons || caps?.thinkingCanDisable !== false),
        between_tools: supported(reasons && caps?.thinkingOffType === "between_tools"),
      },
    },
    image_input: supported(caps?.vision),
    pdf_input: supported(caps?.pdf),
  };
}

/**
 * Add the standard fields to a model entry (mutates `entry`, copies `caps`).
 * @param {object} entry
 * @param {{ created?: number|string, displayName?: string, caps?: object|null,
 *           levelInfo?: { levels: string[], source: string } | null, llm?: boolean }} [meta]
 */
export function decorateModelEntry(entry, { created, displayName, caps = null, levelInfo = null, llm = true } = {}) {
  const seconds = toUnixSeconds(created);
  entry.created = seconds;
  entry.created_at = toRfc3339(seconds);
  entry.type = "model";
  entry.shutdown_date = null;
  const label = entry.display_name || entry.name || displayName || entry.id;
  entry.display_name = label;
  if (!entry.name) entry.name = label;
  if (!llm) return entry;

  const base = entry.capabilities || caps || null;
  if (base || levelInfo) {
    const merged = { ...(base || {}) };
    // Kiro's live catalog uses a boolean "thinking" (the -thinking variant flag);
    // Anthropic's capabilities.thinking is an object, so keep the flag under its own key.
    if (typeof merged.thinking === "boolean") merged.thinkingVariant = merged.thinking;
    if (levelInfo) {
      merged.thinkingLevels = levelInfo.levels;
      merged.thinkingLevelsSource = levelInfo.source;
    }
    Object.assign(merged, anthropicCapabilityBlocks(merged, levelInfo?.levels));
    entry.capabilities = merged;
  }
  if (levelInfo) {
    const efforts = openAIEfforts(levelInfo.levels);
    if (efforts.length > 0) entry.reasoning_efforts = efforts;
  }
  entry.supported_parameters = buildSupportedParameters(base, levelInfo);
  if (Number.isFinite(entry.context_length)) entry.max_input_tokens = entry.context_length;
  if (Number.isFinite(entry.max_completion_tokens)) entry.max_tokens = entry.max_completion_tokens;
  return entry;
}
