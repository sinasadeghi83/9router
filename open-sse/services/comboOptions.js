// Per-combo options: user-set metadata + request defaults for a combo.
//
// Two groups of settings live here:
//   • Published metadata — what /v1/models advertises for the combo
//     (display name, description, context window, max output, visibility).
//   • Request defaults — applied to the client body when the combo is called.
//     temperature / topP / reasoningEffort only fill fields the client did not
//     send. maxOutputTokens is both: it fills an absent limit and caps a larger one.
//
// Pure module (no I/O): shared by the API validation, the DB repo, the chat
// handler, and the dashboard bundle.

import { EFFORT_LEVELS, LEVEL_TO_BUDGET } from "../translator/concerns/thinking.js";
import { FORMATS } from "../translator/formats.js";

export const COMBO_REASONING_EFFORTS = ["none", ...EFFORT_LEVELS];

export const COMBO_OPTION_LIMITS = {
  displayName: { maxLength: 80 },
  description: { maxLength: 500 },
  contextWindow: { min: 1024, max: 10_000_000 },
  maxOutputTokens: { min: 256, max: 2_000_000 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
};

// Smallest thinking budget upstreams accept (Anthropic minimum).
const MIN_THINKING_BUDGET = 1024;

// Control chars (incl. newlines) never belong in a one-line label.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const isUnset = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

function cleanText(value, key, maxLength, errors, { multiline = false } = {}) {
  if (isUnset(value)) return undefined;
  if (typeof value !== "string") { errors.push(`${key} must be a string`); return undefined; }
  let text = multiline
    ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    : value.replace(CONTROL_CHARS, " ");
  text = text.trim();
  if (!text) return undefined;
  if (text.length > maxLength) { errors.push(`${key} must be at most ${maxLength} characters`); return undefined; }
  return text;
}

function cleanNumber(value, key, { min, max, integer }, errors) {
  if (isUnset(value)) return undefined;
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) { errors.push(`${key} must be a number`); return undefined; }
  if (integer && !Number.isInteger(n)) { errors.push(`${key} must be a whole number`); return undefined; }
  if (n < min || n > max) { errors.push(`${key} must be between ${min} and ${max}`); return undefined; }
  return n;
}

/**
 * Validate and normalize a combo options object.
 * Unset/empty fields are dropped, so the stored object only carries overrides.
 * @param {unknown} input
 * @returns {{ value: object, errors: string[] }}
 */
export function normalizeComboOptions(input) {
  const errors = [];
  const value = {};
  if (input === undefined || input === null) return { value, errors };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { value, errors: ["options must be an object"] };
  }

  const L = COMBO_OPTION_LIMITS;
  const set = (key, v) => { if (v !== undefined) value[key] = v; };

  set("displayName", cleanText(input.displayName, "displayName", L.displayName.maxLength, errors));
  set("description", cleanText(input.description, "description", L.description.maxLength, errors, { multiline: true }));
  set("contextWindow", cleanNumber(input.contextWindow, "contextWindow", { ...L.contextWindow, integer: true }, errors));
  set("maxOutputTokens", cleanNumber(input.maxOutputTokens, "maxOutputTokens", { ...L.maxOutputTokens, integer: true }, errors));
  set("temperature", cleanNumber(input.temperature, "temperature", L.temperature, errors));
  set("topP", cleanNumber(input.topP, "topP", L.topP, errors));

  if (!isUnset(input.reasoningEffort)) {
    const effort = typeof input.reasoningEffort === "string" ? input.reasoningEffort.trim().toLowerCase() : null;
    if (effort && COMBO_REASONING_EFFORTS.includes(effort)) value.reasoningEffort = effort;
    else errors.push(`reasoningEffort must be one of: ${COMBO_REASONING_EFFORTS.join(", ")}`);
  }

  if (input.hidden !== undefined && input.hidden !== null) {
    if (typeof input.hidden !== "boolean") errors.push("hidden must be a boolean");
    else if (input.hidden) value.hidden = true;
  }

  const known = new Set(["displayName", "description", "contextWindow", "maxOutputTokens", "temperature", "topP", "reasoningEffort", "hidden"]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors.push(`unknown option: ${key}`);
  }

  return { value, errors };
}

/** Lenient read: drop anything invalid (stored data from older/other versions). */
export function readComboOptions(input) {
  return normalizeComboOptions(input && typeof input === "object" && !Array.isArray(input) ? input : null).value;
}

export function hasRequestOptions(options) {
  return !!options && (
    options.maxOutputTokens !== undefined ||
    options.temperature !== undefined ||
    options.topP !== undefined ||
    options.reasoningEffort !== undefined
  );
}

// Field names per client wire format. Gemini keeps its knobs in generationConfig.
const FIELD_MAP = {
  [FORMATS.OPENAI]: { maxTokens: ["max_tokens", "max_completion_tokens"], temperature: "temperature", topP: "top_p" },
  [FORMATS.OPENAI_RESPONSES]: { maxTokens: ["max_output_tokens"], temperature: "temperature", topP: "top_p" },
  [FORMATS.CLAUDE]: { maxTokens: ["max_tokens"], temperature: "temperature", topP: "top_p" },
};

function hasReasoningIntent(body) {
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort) return true;
  if (body.reasoning && typeof body.reasoning === "object" && body.reasoning.effort) return true;
  if (body.output_config?.effort) return true;
  if (body.thinking && typeof body.thinking === "object") return true;
  if (body.enable_thinking !== undefined) return true;
  if (body.thinkingConfig || body.generationConfig?.thinkingConfig) return true;
  return false;
}

function applyReasoningDefault(body, effort, format) {
  if (hasReasoningIntent(body)) return;
  switch (format) {
    case FORMATS.OPENAI_RESPONSES:
      body.reasoning = { ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}), effort };
      break;
    case FORMATS.CLAUDE:
      // extractThinking() reads output_config.effort and maps it per target model.
      body.output_config = { ...(body.output_config || {}), effort };
      break;
    case FORMATS.GEMINI: {
      const gc = body.generationConfig && typeof body.generationConfig === "object" ? body.generationConfig : {};
      body.generationConfig = { ...gc, thinkingConfig: { thinkingBudget: LEVEL_TO_BUDGET[effort] ?? -1 } };
      break;
    }
    default:
      body.reasoning_effort = effort;
  }
}

function clampClaudeThinking(body, ceiling) {
  const budget = Number(body.thinking?.budget_tokens);
  if (!Number.isFinite(budget) || budget < ceiling) return;
  // Anthropic requires max_tokens > budget_tokens.
  const next = ceiling - 1;
  if (next >= MIN_THINKING_BUDGET) body.thinking = { ...body.thinking, budget_tokens: next };
}

/**
 * Apply a combo's request options to a client body (in the client's format).
 * Returns a new body when anything changed; the input is never mutated.
 * @param {object} body
 * @param {object} options - normalized combo options
 * @param {string|null} format - client source format (FORMATS.*)
 * @returns {{ body: object, applied: string[] }}
 */
export function applyComboRequestOptions(body, options, format) {
  const applied = [];
  if (!body || typeof body !== "object" || !hasRequestOptions(options)) return { body, applied };

  const out = { ...body };
  const fmt = format || FORMATS.OPENAI;

  if (fmt === FORMATS.GEMINI) {
    const gc = { ...(out.generationConfig && typeof out.generationConfig === "object" ? out.generationConfig : {}) };
    if (options.maxOutputTokens !== undefined) {
      const current = Number(gc.maxOutputTokens);
      if (!Number.isFinite(current) || current > options.maxOutputTokens) {
        gc.maxOutputTokens = options.maxOutputTokens; applied.push("maxOutputTokens");
      }
    }
    if (options.temperature !== undefined && gc.temperature === undefined) { gc.temperature = options.temperature; applied.push("temperature"); }
    if (options.topP !== undefined && gc.topP === undefined) { gc.topP = options.topP; applied.push("topP"); }
    out.generationConfig = gc;
  } else {
    const fields = FIELD_MAP[fmt] || FIELD_MAP[FORMATS.OPENAI];
    if (options.maxOutputTokens !== undefined) {
      const present = fields.maxTokens.filter((key) => typeof out[key] === "number" && Number.isFinite(out[key]));
      if (present.length === 0) {
        out[fields.maxTokens[0]] = options.maxOutputTokens;
        applied.push("maxOutputTokens");
      }
      for (const key of present) {
        if (out[key] > options.maxOutputTokens) {
          out[key] = options.maxOutputTokens;
          if (!applied.includes("maxOutputTokens")) applied.push("maxOutputTokens");
        }
      }
      if (fmt === FORMATS.CLAUDE) clampClaudeThinking(out, out.max_tokens);
    }
    if (options.temperature !== undefined && out[fields.temperature] === undefined) {
      out[fields.temperature] = options.temperature; applied.push("temperature");
    }
    if (options.topP !== undefined && out[fields.topP] === undefined) {
      out[fields.topP] = options.topP; applied.push("topP");
    }
  }

  if (options.reasoningEffort !== undefined && !hasReasoningIntent(out)) {
    applyReasoningDefault(out, options.reasoningEffort, fmt);
    applied.push("reasoningEffort");
  }

  return { body: applied.length ? out : body, applied };
}
