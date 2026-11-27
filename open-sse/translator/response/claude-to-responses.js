import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { CLAUDE_BLOCK, CLAUDE_EVENT, CLAUDE_DELTA, CLAUDE_STOP, RESPONSES_EVENT, RESPONSES_INCOMPLETE_REASON, RESPONSES_ITEM, ROLE } from "../schema/index.js";

const { TEXT, THINKING, TOOL_USE, SERVER_TOOL_USE, WEB_SEARCH_TOOL_RESULT } = CLAUDE_BLOCK;
const { FUNCTION_CALL, CUSTOM_TOOL_CALL, MESSAGE, OUTPUT_TEXT, REASONING, SUMMARY_TEXT, REFUSAL, WEB_SEARCH_CALL } = RESPONSES_ITEM;
const WEB_SEARCH = "web_search";

export function createClaudeResponsesState(body, model, toolNameMap, customToolNames) {
  return {
    model,
    toolNameMap,
    customToolNames: new Set(customToolNames || []),
    reasoningSummary: !!body?.reasoning?.summary && body.reasoning.summary !== "none",
    includeSearchSources: Array.isArray(body?.include) && body.include.includes("web_search_call.action.sources"),
    sequence: 0,
    blocks: new Map(),
    output: [],
    searches: new Map(),
    usage: {},
  };
}

function event(state, type, fields) {
  return { event: type, data: { type, sequence_number: state.sequence++, ...fields } };
}

function start(state, message = {}) {
  state.response = {
    id: message.id ? `resp_${message.id}` : `resp_${globalThis.crypto.randomUUID()}`,
    object: "response",
    created_at: message.created_at ?? Math.floor(Date.now() / 1000),
    model: message.model || state.model || "unknown",
    status: "in_progress",
    background: false,
    error: null,
    incomplete_details: null,
    output: [],
    usage: null,
  };
  state.usage = { ...message.usage };
  return [
    event(state, RESPONSES_EVENT.CREATED, { response: state.response }),
    event(state, RESPONSES_EVENT.IN_PROGRESS, { response: state.response }),
  ];
}

function itemEvent(state, type, entry) {
  return event(state, type, { output_index: entry.outputIndex, item: structuredClone(entry.item) });
}

function contentEvent(state, type, entry, fields) {
  return event(state, type, { item_id: entry.item.id, output_index: entry.outputIndex, ...fields });
}

function openBlock(state, index, block) {
  const id = `${state.response.id.slice(5)}_${index}`;
  const entry = { block, json: "", closed: false };
  const events = [];
  state.blocks.set(index, entry);

  switch (block.type) {
    case TEXT:
      entry.item = { type: MESSAGE, id: `msg_${id}`, status: "in_progress", role: ROLE.ASSISTANT, content: [] };
      entry.part = { type: OUTPUT_TEXT, text: "", annotations: [], logprobs: [] };
      break;
    case THINKING:
      if (state.reasoningSummary && block.thinking) {
        entry.item = { type: REASONING, id: `rs_${id}`, summary: [] };
        entry.part = { type: SUMMARY_TEXT, text: "" };
      }
      break;
    case TOOL_USE: {
      const name = state.toolNameMap?.get(block.name) ?? block.name;
      const custom = state.customToolNames.has(name);
      entry.item = {
        type: custom ? CUSTOM_TOOL_CALL : FUNCTION_CALL,
        id: `${custom ? "ctc" : "fc"}_${id}`,
        call_id: block.id,
        name,
        ...(custom ? { input: "" } : { arguments: "", status: "in_progress" }),
      };
      break;
    }
    case SERVER_TOOL_USE:
      if (block.name === WEB_SEARCH) {
        entry.item = { type: WEB_SEARCH_CALL, id: `ws_${id}`, status: "in_progress" };
        state.searches.set(block.id, entry);
      }
      break;
  }

  if (entry.item) {
    entry.outputIndex = state.output.push(entry.item) - 1;
    events.push(itemEvent(state, RESPONSES_EVENT.OUTPUT_ITEM_ADDED, entry));
    if (entry.part) {
      const thinking = entry.item.type === REASONING;
      const position = thinking ? { summary_index: 0 } : { content_index: 0 };
      events.push(contentEvent(state, thinking ? RESPONSES_EVENT.REASONING_PART_ADDED : RESPONSES_EVENT.CONTENT_PART_ADDED, entry, {
        ...position, part: { ...entry.part },
      }));
      const initial = thinking ? block.thinking : block.text;
      if (initial) events.push(contentEvent(state, thinking ? RESPONSES_EVENT.REASONING_TEXT_DELTA : RESPONSES_EVENT.OUTPUT_TEXT_DELTA, entry, {
        ...position, delta: initial, ...(!thinking && { logprobs: [] }),
      }));
    } else if (entry.item.type === WEB_SEARCH_CALL) {
      events.push(contentEvent(state, RESPONSES_EVENT.WEB_SEARCH_IN_PROGRESS, entry, {}));
    }
  }
  return events;
}

function deltaBlock(state, entry, index, delta) {
  if (!entry || entry.closed) return [];
  const block = entry.block;
  switch (delta.type) {
    case CLAUDE_DELTA.TEXT:
      if (block.type !== TEXT || typeof delta.text !== "string") return [];
      block.text = (block.text || "") + delta.text;
      return [contentEvent(state, RESPONSES_EVENT.OUTPUT_TEXT_DELTA, entry, { content_index: 0, delta: delta.text, logprobs: [] })];
    case CLAUDE_DELTA.THINKING:
      if (!state.reasoningSummary || block.type !== THINKING || typeof delta.thinking !== "string" || !delta.thinking) return [];
      if (!entry.item) return openBlock(state, index, { ...block, thinking: delta.thinking });
      block.thinking += delta.thinking;
      return [contentEvent(state, RESPONSES_EVENT.REASONING_TEXT_DELTA, entry, { summary_index: 0, delta: delta.thinking })];
    case CLAUDE_DELTA.INPUT_JSON:
      if (typeof delta.partial_json !== "string") return [];
      entry.json += delta.partial_json;
      if (entry.item?.type !== FUNCTION_CALL) return [];
      return [contentEvent(state, RESPONSES_EVENT.FUNCTION_CALL_ARGUMENTS_DELTA, entry, { delta: delta.partial_json })];
    case CLAUDE_DELTA.CITATIONS:
      if (block.type === TEXT && delta.citation) block.citations = [...(block.citations || []), delta.citation];
      return [];
    default:
      return [];
  }
}

function annotationsFor(block) {
  const text = block.text || "";
  return (block.citations || []).flatMap(citation => {
    if (citation?.type !== "web_search_result_location" || typeof citation.url !== "string" || !text) return [];
    // Claude supplies the quoted source text but no offsets into its generated text.
    const match = citation.cited_text ? text.indexOf(citation.cited_text) : -1;
    const startIndex = match < 0 ? 0 : [...text.slice(0, match)].length;
    const endIndex = match < 0 ? [...text].length : startIndex + [...citation.cited_text].length;
    return [{ type: "url_citation", url: citation.url, title: citation.title || "", start_index: startIndex, end_index: endIndex }];
  });
}

function toolInput(entry) {
  if (entry.json) {
    try { return JSON.parse(entry.json); } catch { return null; }
  }
  return entry.block.input ?? {};
}

function closeBlock(state, entry, status = "completed") {
  if (!entry || entry.closed) return [];
  entry.closed = true;
  const { block, item } = entry;
  if (block.type === WEB_SEARCH_TOOL_RESULT) {
    const search = state.searches.get(block.tool_use_id);
    if (!search) return [];
    const results = Array.isArray(block.content) ? block.content : null;
    const sources = results?.filter(result => result?.type === "web_search_result" && typeof result.url === "string")
      .map(result => ({ type: "url", url: result.url }));
    if (state.includeSearchSources && sources) search.item.action.sources = sources;
    search.item.status = results ? "completed" : "failed";
    return [
      ...(results ? [contentEvent(state, RESPONSES_EVENT.WEB_SEARCH_COMPLETED, search, {})] : []),
      itemEvent(state, RESPONSES_EVENT.OUTPUT_ITEM_DONE, search),
    ];
  }
  if (!item) return [];
  const events = [];

  switch (item.type) {
    case MESSAGE: {
      const text = block.text || "";
      const annotations = annotationsFor(block);
      const part = { type: OUTPUT_TEXT, text, annotations, logprobs: [] };
      item.content = [part];
      item.status = status;
      for (const [annotation_index, annotation] of annotations.entries()) {
        events.push(contentEvent(state, RESPONSES_EVENT.OUTPUT_TEXT_ANNOTATION_ADDED, entry, { content_index: 0, annotation_index, annotation }));
      }
      events.push(
        contentEvent(state, RESPONSES_EVENT.OUTPUT_TEXT_DONE, entry, { content_index: 0, text, logprobs: [] }),
        contentEvent(state, RESPONSES_EVENT.CONTENT_PART_DONE, entry, { content_index: 0, part }),
      );
      break;
    }
    case REASONING: {
      const text = block.thinking || "";
      const part = { type: SUMMARY_TEXT, text };
      item.summary = [part];
      events.push(
        contentEvent(state, RESPONSES_EVENT.REASONING_TEXT_DONE, entry, { summary_index: 0, text }),
        contentEvent(state, RESPONSES_EVENT.REASONING_PART_DONE, entry, { summary_index: 0, part }),
      );
      break;
    }
    case FUNCTION_CALL: {
      const input = toolInput(entry);
      if (!input || Array.isArray(input) || typeof input !== "object") state.invalidToolInput = true;
      item.arguments = entry.json || JSON.stringify(input ?? {});
      item.status = input && !Array.isArray(input) && typeof input === "object" ? status : "incomplete";
      const fields = { arguments: item.arguments };
      if (!entry.json) events.push(contentEvent(state, RESPONSES_EVENT.FUNCTION_CALL_ARGUMENTS_DELTA, entry, { delta: item.arguments }));
      events.push(contentEvent(state, RESPONSES_EVENT.FUNCTION_CALL_ARGUMENTS_DONE, entry, fields));
      break;
    }
    case CUSTOM_TOOL_CALL: {
      const input = toolInput(entry)?.input;
      if (typeof input !== "string") state.invalidToolInput = true;
      item.input = typeof input === "string" ? input : "";
      if (item.input) events.push(contentEvent(state, RESPONSES_EVENT.CUSTOM_TOOL_CALL_INPUT_DELTA, entry, { delta: item.input }));
      events.push(contentEvent(state, RESPONSES_EVENT.CUSTOM_TOOL_CALL_INPUT_DONE, entry, { input: item.input }));
      break;
    }
    case WEB_SEARCH_CALL: {
      const query = toolInput(entry)?.query;
      item.action = { type: "search", ...(typeof query === "string" && { query }) };
      item.status = status === "completed" ? "searching" : "failed";
      return [contentEvent(state, RESPONSES_EVENT.WEB_SEARCH_SEARCHING, entry, {})];
    }
  }
  events.push(itemEvent(state, RESPONSES_EVENT.OUTPUT_ITEM_DONE, entry));
  return events;
}

function emitRefusal(state) {
  const refusal = state.stopDetails?.explanation || "The upstream model refused to continue.";
  const id = `msg_${state.response.id.slice(5)}_refusal`;
  const item = { type: MESSAGE, id, status: "in_progress", role: ROLE.ASSISTANT, content: [] };
  const entry = { item, outputIndex: state.output.push(item) - 1 };
  const part = { type: REFUSAL, refusal };
  const position = { content_index: 0 };
  const events = [
    itemEvent(state, RESPONSES_EVENT.OUTPUT_ITEM_ADDED, entry),
    contentEvent(state, RESPONSES_EVENT.CONTENT_PART_ADDED, entry, { ...position, part: { type: REFUSAL, refusal: "" } }),
    contentEvent(state, RESPONSES_EVENT.REFUSAL_DELTA, entry, { ...position, delta: refusal }),
    contentEvent(state, RESPONSES_EVENT.REFUSAL_DONE, entry, { ...position, refusal }),
    contentEvent(state, RESPONSES_EVENT.CONTENT_PART_DONE, entry, { ...position, part }),
  ];
  item.content = [part];
  item.status = "completed";
  events.push(itemEvent(state, RESPONSES_EVENT.OUTPUT_ITEM_DONE, entry));
  return events;
}

function usageFor(usage) {
  const cached = usage.cache_read_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage.reasoning_tokens ?? 0 },
    total_tokens: input + output,
  };
}

function finish(state, error = null) {
  if (state.terminal) return [];
  const events = state.response ? [] : start(state);
  const lengthLimit = state.stopReason === CLAUDE_STOP.MAX_TOKENS || state.stopReason === CLAUDE_STOP.MODEL_CONTEXT_WINDOW_EXCEEDED;
  for (const entry of state.blocks.values()) {
    events.push(...closeBlock(state, entry, error || lengthLimit ? "incomplete" : "completed"));
  }
  for (const search of state.searches.values()) {
    if (search.item.status === "completed" || search.item.status === "failed") continue;
    search.item.status = "failed";
    events.push(itemEvent(state, RESPONSES_EVENT.OUTPUT_ITEM_DONE, search));
  }
  if (!error && !lengthLimit && state.invalidToolInput) {
    error = { code: "server_error", message: "The upstream returned invalid tool arguments." };
  }
  if (!error && state.stopReason === CLAUDE_STOP.PAUSE_TURN) {
    error = { code: "server_error", message: "The upstream paused for a native continuation." };
  }
  if (!error && state.stopReason === CLAUDE_STOP.REFUSAL) events.push(...emitRefusal(state));

  const status = error ? "failed" : lengthLimit ? "incomplete" : "completed";
  state.terminal = {
    ...state.response,
    status,
    error,
    incomplete_details: status === "incomplete" ? { reason: RESPONSES_INCOMPLETE_REASON.MAX_OUTPUT_TOKENS } : null,
    output: state.output,
    usage: usageFor(state.usage),
  };
  const type = error ? RESPONSES_EVENT.FAILED : lengthLimit ? RESPONSES_EVENT.INCOMPLETE : RESPONSES_EVENT.COMPLETED;
  events.push(event(state, type, { response: state.terminal }));
  return events;
}

export function failClaudeResponses(state, message) {
  return finish(state, { code: "server_error", message });
}

export function claudeToResponsesEvent(chunk, state) {
  if (state.terminal) return [];
  if (chunk == null || chunk.done) return failClaudeResponses(state, "The Anthropic stream ended before message_stop.");
  if (chunk.type === CLAUDE_EVENT.ERROR || chunk.error) {
    return failClaudeResponses(state, chunk.error?.message || "The Anthropic stream reported an error.");
  }
  if (chunk.type === CLAUDE_EVENT.PING) return [];
  if (chunk.type === CLAUDE_EVENT.MESSAGE_START) {
    if (state.response || !chunk.message || typeof chunk.message !== "object") {
      return failClaudeResponses(state, "Invalid Anthropic message_start.");
    }
    return start(state, chunk.message);
  }
  if (!state.response) return failClaudeResponses(state, "The Anthropic stream did not start with message_start.");
  const entry = state.blocks.get(chunk.index);
  switch (chunk.type) {
    case CLAUDE_EVENT.CONTENT_BLOCK_START:
      if (entry || !Number.isInteger(chunk.index) || chunk.index < 0 || typeof chunk.content_block?.type !== "string") {
        return failClaudeResponses(state, "Invalid Anthropic content_block_start.");
      }
      return openBlock(state, chunk.index, { ...chunk.content_block });
    case CLAUDE_EVENT.CONTENT_BLOCK_DELTA:
      if (!entry || entry.closed || !chunk.delta) return failClaudeResponses(state, "Invalid Anthropic content_block_delta.");
      return deltaBlock(state, entry, chunk.index, chunk.delta);
    case CLAUDE_EVENT.CONTENT_BLOCK_STOP:
      if (!entry || entry.closed) return failClaudeResponses(state, "Invalid Anthropic content_block_stop.");
      return closeBlock(state, entry);
    case CLAUDE_EVENT.MESSAGE_DELTA:
      if (chunk.delta?.stop_reason) state.stopReason = chunk.delta.stop_reason;
      if (chunk.delta?.stop_details || chunk.stop_details) state.stopDetails = chunk.delta?.stop_details ?? chunk.stop_details;
      Object.assign(state.usage, chunk.usage);
      return [];
    case CLAUDE_EVENT.MESSAGE_STOP:
      if (!state.stopReason || [...state.blocks.values()].some(block => !block.closed)) {
        return failClaudeResponses(state, "The Anthropic stream stopped before its message was complete.");
      }
      return finish(state);
    default:
      return [];
  }
}

export function claudeMessageToResponses(message, body, model, toolNameMap, customToolNames) {
  const state = createClaudeResponsesState(body, model, toolNameMap, customToolNames);
  if (!Array.isArray(message?.content) || !message.stop_reason || message.error) {
    failClaudeResponses(state, message?.error?.message || "Invalid Anthropic message response.");
    return state.terminal;
  }
  start(state, message);
  for (const [index, block] of message.content.entries()) {
    if (typeof block?.type !== "string") {
      failClaudeResponses(state, "Invalid Anthropic content block.");
      return state.terminal;
    }
    openBlock(state, index, { ...block });
    closeBlock(state, state.blocks.get(index));
  }
  state.stopReason = message.stop_reason;
  state.stopDetails = message.stop_details;
  finish(state);
  return state.terminal;
}

/** Parse Claude SSE lines for both the streaming and collected JSON paths. */
export function parseClaudeResponsesLine(line, state) {
  if (!line) {
    state.eventName = null;
    return null;
  }
  if (line.startsWith(":")) return null;
  if (line.startsWith("event:")) {
    state.eventName = line.slice(6).trim();
    return null;
  }
  if (!line.startsWith("data:")) return null;
  const name = state.eventName;
  state.eventName = null;
  const data = line.slice(5).trim();
  if (data === "[DONE]") return { done: true };
  try {
    const chunk = JSON.parse(data);
    if (chunk && typeof chunk === "object" && !Array.isArray(chunk)) {
      return !chunk.type && name ? { ...chunk, type: name } : chunk;
    }
  } catch { /* Errors become a Responses terminal event. */ }
  return { type: CLAUDE_EVENT.ERROR, error: { message: "Invalid Anthropic SSE data." } };
}

export async function collectClaudeResponses(stream, body, model, toolNameMap, customToolNames) {
  const state = createClaudeResponsesState(body, model, toolNameMap, customToolNames);
  const reader = stream?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (reader && !state.terminal) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop();
      for (const line of lines) {
        const chunk = parseClaudeResponsesLine(line.trim(), state);
        if (chunk) claudeToResponsesEvent(chunk, state);
        if (state.terminal) break;
      }
      if (done) break;
    }
  } catch {
    failClaudeResponses(state, "The Anthropic connection closed while reading the response.");
  } finally {
    reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
  if (!state.terminal) claudeToResponsesEvent(null, state);
  return { response: state.terminal, usage: state.usage };
}

function translateClaudeResponses(chunk, state) {
  state.claudeResponses ??= createClaudeResponsesState(null, state.model, state.toolNameMap, state.customToolNames);
  return claudeToResponsesEvent(chunk, state.claudeResponses);
}

register(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, null, translateClaudeResponses);
