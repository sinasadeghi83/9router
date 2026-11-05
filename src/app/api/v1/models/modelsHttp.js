// Shared HTTP helpers for the /v1/models routes (list, retrieve, info).

export const LLM_KIND = "llm";

// URL slug → service kind(s). `web` covers both webSearch and webFetch.
export const KIND_SLUG_MAP = {
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

// Every kind a model can have. Retrieval searches all of them so any routable
// model can be fetched by id, not just chat models.
export const ALL_KINDS = [LLM_KIND, "image", "tts", "stt", "embedding", "imageToText", "video", "webSearch", "webFetch"];

/**
 * Kinds named by a `?kind=` query value: "all", a slug (image-to-text), a kind
 * (imageToText) or a comma-separated mix. Returns null when any token is unknown.
 */
export function parseKindsParam(value) {
  const tokens = String(value ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  const out = new Set();
  for (const token of tokens) {
    if (token === "all") { ALL_KINDS.forEach((k) => out.add(k)); continue; }
    if (token === "llm") { out.add(LLM_KIND); continue; }
    const kinds = KIND_SLUG_MAP[token] || (ALL_KINDS.includes(token) ? [token] : null);
    if (!kinds) return null;
    kinds.forEach((k) => out.add(k));
  }
  return Array.from(out);
}

export const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

export function corsPreflight(methods = "GET, OPTIONS") {
  return new Response(null, {
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export function jsonResponse(data, options = {}) {
  return Response.json(data, {
    ...options,
    headers: { ...CORS_HEADERS, ...options.headers },
  });
}

/** OpenAI error envelope: all four fields are required by the spec. */
export function openAIError(status, message, { type = "invalid_request_error", code = null, param = null, headers } = {}) {
  return jsonResponse({ error: { message, type, param, code } }, { status, headers });
}

export function serverError() {
  return openAIError(500, "Internal server error", { type: "server_error", code: "internal_server_error" });
}

/**
 * List envelope. `object`/`data` are OpenAI's; `has_more`/`first_id`/`last_id`
 * are what Anthropic-style SDK paginators read (the list is never paginated).
 */
export function listEnvelope(data) {
  return {
    object: "list",
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.length > 0 ? data[data.length - 1].id : null,
  };
}
