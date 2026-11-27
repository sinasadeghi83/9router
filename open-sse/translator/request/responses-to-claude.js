import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { normalizeResponsesInput } from "../formats/responsesApi.js";
import { adjustMaxTokens } from "../formats/maxTokens.js";
import { parseDataUri } from "../concerns/image.js";
import { stripAnthropicBillingHeader } from "../concerns/message.js";
import { stripUnsupportedModalities } from "../concerns/modality.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";
import { getCapabilitiesForModel, getClaudeResponsesCapabilities } from "../../providers/capabilities.js";
import { ROLE, CLAUDE_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

export class ResponsesToClaudeRequestError extends Error {
  constructor(param, message) {
    super(`${param}: ${message}`);
    this.param = param;
  }
}

function invalid(param, message) {
  throw new ResponsesToClaudeRequestError(param, message);
}

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isBase64 = (value) => typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
const isNativeName = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const isToolId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
const textBlock = (text) => ({ type: CLAUDE_BLOCK.TEXT, text });

function mediaSource(part, field, image) {
  if (part.file_id != null) invalid(`${field}.file_id`, "use inline data or an HTTP(S) URL");
  const dataField = image ? "image_url" : "file_data";
  const urlField = image ? "image_url" : "file_url";
  const data = part[dataField];
  const url = part[urlField];
  const inline = parseDataUri(data);
  if (inline || (!image && data != null)) {
    const mediaType = inline?.mimeType ?? "application/pdf";
    const base64 = inline?.base64 ?? data;
    if (!isBase64(base64) || !(image ? /^image\/(jpeg|png|gif|webp)$/.test(mediaType) : mediaType === "application/pdf")) {
      invalid(`${field}.${dataField}`, image ? "expected a base64 JPEG, PNG, GIF, or WebP image" : "expected base64 PDF data");
    }
    return { type: "base64", media_type: mediaType, data: base64 };
  }
  if (typeof url === "string" && URL.canParse(url) && /^https?:\/\//i.test(url)) return { type: "url", url };
  invalid(`${field}.${urlField}`, image ? "expected an HTTP(S) or base64 image URL" : "expected an HTTP(S) PDF URL or inline PDF data");
}

function contentBlocks(content, field, role) {
  if (typeof content === "string") return content ? [textBlock(content)] : [];
  if (!Array.isArray(content)) invalid(field, "expected text or an array of content parts");
  return content.flatMap((part, index) => {
    const at = `${field}[${index}]`;
    switch (part?.type) {
      case RESPONSES_ITEM.INPUT_TEXT:
      case RESPONSES_ITEM.OUTPUT_TEXT:
      case CLAUDE_BLOCK.TEXT:
      case RESPONSES_ITEM.REFUSAL: {
        const text = part.type === RESPONSES_ITEM.REFUSAL ? part.refusal : part.text;
        if (typeof text !== "string") invalid(at, "expected text");
        return text ? [textBlock(text)] : [];
      }
      case RESPONSES_ITEM.INPUT_IMAGE:
      case RESPONSES_ITEM.INPUT_FILE: {
        if (role !== ROLE.USER) invalid(at, "media is supported in user and tool result content");
        const image = part.type === RESPONSES_ITEM.INPUT_IMAGE;
        const source = mediaSource(part, at, image);
        return [{ type: image ? CLAUDE_BLOCK.IMAGE : CLAUDE_BLOCK.DOCUMENT, source }];
      }
      default:
        invalid(`${at}.type`, "unsupported content type");
    }
  });
}

function functionInput(args, field) {
  if (isObject(args)) return args;
  if (typeof args === "string") {
    let input;
    try { input = JSON.parse(args); } catch { /* Report the source field below. */ }
    if (isObject(input)) return input;
  }
  invalid(field, "expected a JSON object");
}

function buildMessages(items, system) {
  const messages = [];
  const callIds = new Set();
  const pending = new Map();

  function append(role, blocks) {
    if (!blocks.length) return;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }

  function finishToolTurn(field) {
    if (pending.size) invalid(field, `missing tool output for ${[...pending.keys()].join(", ")}`);
  }

  for (const [index, item] of items.entries()) {
    const field = `input[${index}]`;
    if (!isObject(item)) invalid(field, "expected an input item");
    switch (item.type ?? (item.role ? RESPONSES_ITEM.MESSAGE : null)) {
      case RESPONSES_ITEM.MESSAGE: {
        const { role } = item;
        if (![ROLE.SYSTEM, ROLE.DEVELOPER, ROLE.USER, ROLE.ASSISTANT].includes(role)) invalid(`${field}.role`, "unsupported message role");
        const blocks = contentBlocks(item.content, `${field}.content`, role);
        if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER) {
          system.push(...blocks.map(({ text }) => textBlock(stripAnthropicBillingHeader(text))).filter(({ text }) => text));
        } else {
          if (role === ROLE.ASSISTANT && messages.at(-1)?.role !== ROLE.ASSISTANT) finishToolTurn(field);
          append(role, blocks);
        }
        break;
      }
      case RESPONSES_ITEM.FUNCTION_CALL:
      case RESPONSES_ITEM.CUSTOM_TOOL_CALL: {
        // A truncated call cannot be executed or paired with a tool result.
        if (item.status === "incomplete") break;
        if (!isToolId(item.call_id) || callIds.has(item.call_id)) invalid(`${field}.call_id`, "expected a unique tool call ID");
        if (!isNativeName(item.name)) invalid(`${field}.name`, "invalid Anthropic tool name");
        if (messages.at(-1)?.role === ROLE.USER) finishToolTurn(field);
        const custom = item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL;
        if (custom && typeof item.input !== "string") invalid(`${field}.input`, "expected a string");
        const input = custom ? { input: item.input } : functionInput(item.arguments, `${field}.arguments`);
        callIds.add(item.call_id);
        pending.set(item.call_id, custom);
        append(ROLE.ASSISTANT, [{ type: CLAUDE_BLOCK.TOOL_USE, id: item.call_id, name: item.name, input }]);
        break;
      }
      case RESPONSES_ITEM.FUNCTION_CALL_OUTPUT:
      case RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT: {
        const custom = item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT;
        if (pending.get(item.call_id) !== custom) invalid(`${field}.call_id`, "expected a matching tool call with no previous output");
        const content = typeof item.output === "string"
          ? item.output
          : contentBlocks(item.output, `${field}.output`, ROLE.USER);
        pending.delete(item.call_id);
        const result = { type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: item.call_id, content };
        const previous = messages.at(-1);
        const firstText = previous?.role === ROLE.USER
          ? previous.content.findIndex(block => block.type !== CLAUDE_BLOCK.TOOL_RESULT) : -1;
        if (firstText >= 0) previous.content.splice(firstText, 0, result);
        else append(ROLE.USER, [result]);
        break;
      }
      case RESPONSES_ITEM.REASONING:
      case RESPONSES_ITEM.WEB_SEARCH_CALL:
      case RESPONSES_ITEM.ADDITIONAL_TOOLS:
        break;
      case RESPONSES_ITEM.ITEM_REFERENCE:
        invalid(`${field}.type`, "item references require stored state; send the item inline");
        break;
      default:
        invalid(`${field}.type`, "unsupported input item");
    }
  }
  finishToolTurn("input");
  if (!messages.length) invalid("input", "expected a conversation message");
  return messages;
}

function buildTools(body, items, caps, customToolNames) {
  if (body.tools != null && !Array.isArray(body.tools)) invalid("tools", "expected an array");
  if (body.max_tool_calls != null && (!Number.isSafeInteger(body.max_tool_calls) || body.max_tool_calls < 1)) {
    invalid("max_tool_calls", "expected a positive integer");
  }
  const definitions = (body.tools ?? []).map((tool, index) => [tool, `tools[${index}]`]);
  for (const [index, item] of items.entries()) {
    if (item?.type !== RESPONSES_ITEM.ADDITIONAL_TOOLS) continue;
    const field = `input[${index}].tools`;
    if (!Array.isArray(item.tools)) invalid(field, "expected an array");
    definitions.push(...item.tools.map((tool, toolIndex) => [tool, `${field}[${toolIndex}]`]));
  }

  const names = new Set();
  return definitions.map(([tool, field]) => {
    if (!isObject(tool)) invalid(field, "expected a tool definition");
    let native;
    if (tool.type === "web_search" || tool.type === "web_search_preview") {
      if (!caps.webSearch) invalid(field, "hosted web search is unsupported on this route");
      const unsupported = Object.keys(tool).find(key => !["type", "filters", "user_location", "search_context_size", "external_web_access"].includes(key));
      if (unsupported) invalid(`${field}.${unsupported}`, "unsupported web search option");
      if (tool.external_web_access === false) invalid(`${field}.external_web_access`, "Anthropic web search requires external access");
      if (tool.filters != null && (!isObject(tool.filters) || Object.keys(tool.filters).some(key => key !== "allowed_domains"))) {
        invalid(`${field}.filters`, "only allowed_domains is supported");
      }
      native = {
        type: caps.webSearch,
        name: "web_search",
        ...(tool.filters?.allowed_domains && { allowed_domains: tool.filters.allowed_domains }),
        ...(tool.user_location && { user_location: tool.user_location }),
        ...(body.max_tool_calls != null && { max_uses: body.max_tool_calls }),
      };
    } else {
      const definition = tool.function ?? tool;
      const custom = tool.type === "custom";
      if (!custom && tool.type !== "function" && !tool.function) invalid(`${field}.type`, "unsupported hosted tool");
      if (!isNativeName(definition.name)) invalid(`${field}.name`, "invalid Anthropic tool name");
      if (definition.strict === true && !caps.structuredOutputs) invalid(`${field}.strict`, "strict tools are unsupported on this route");
      if (custom && tool.format && tool.format.type !== "text") invalid(`${field}.format`, "custom-tool grammars are unsupported");
      const schema = custom
        ? { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }
        : definition.parameters ?? { type: "object", properties: {} };
      if (!isObject(schema) || schema.type !== "object") invalid(`${field}.parameters`, "expected an object JSON Schema");
      native = {
        name: definition.name,
        ...(definition.description != null && { description: definition.description }),
        input_schema: schema,
        ...(definition.strict === true && { strict: true }),
      };
      if (custom) customToolNames.add(native.name);
    }
    if (names.has(native.name)) invalid(field, `duplicate tool name ${native.name}`);
    names.add(native.name);
    return native;
  });
}

function chooseTools(choice, parallel, tools) {
  if (parallel != null && typeof parallel !== "boolean") invalid("parallel_tool_calls", "expected a boolean");
  let toolChoice;
  switch (typeof choice === "string" ? choice : choice?.type) {
    case undefined:
    case "auto": toolChoice = { type: "auto" }; break;
    case "none": toolChoice = { type: "none" }; break;
    case "required": toolChoice = { type: "any" }; break;
    case "function":
    case "custom":
    case "web_search":
    case "web_search_preview": {
      const type = typeof choice === "string" ? choice : choice.type;
      const name = choice.name ?? choice.function?.name ?? (type.startsWith("web_search") ? "web_search" : undefined);
      if (!tools.some(tool => tool.name === name)) invalid("tool_choice", "the selected tool was not declared");
      toolChoice = { type: "tool", name };
      break;
    }
    default: invalid("tool_choice", "unsupported tool choice");
  }
  if (!tools.length) {
    if (toolChoice.type === "any" || toolChoice.type === "tool") invalid("tool_choice", "declare at least one tool");
    return undefined;
  }
  if (parallel === false && toolChoice.type !== "none") toolChoice.disable_parallel_tool_use = true;
  return toolChoice;
}

export function responsesToClaudeRequest(model, body, stream, _credentials, { provider, stripList = [] } = {}) {
  for (const field of ["previous_response_id", "conversation", "prompt", "context_management"]) {
    if (body[field] != null) invalid(field, "unsupported on this stateless route; send explicit input history");
  }
  if (body.background === true || body.store === true) {
    invalid(body.background === true ? "background" : "store", "requires stored state on this stateless route");
  }
  if (body.instructions != null && typeof body.instructions !== "string") invalid("instructions", "expected a string");
  if (body.max_output_tokens != null && (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1)) {
    invalid("max_output_tokens", "expected a positive integer");
  }

  const items = normalizeResponsesInput(body.input ?? []);
  if (!items) invalid("input", "expected a string or an array");
  const system = [];
  const instructions = stripAnthropicBillingHeader(body.instructions);
  if (instructions) system.push(textBlock(instructions));
  const messages = buildMessages(items, system);
  const caps = getCapabilitiesForModel(provider, model);
  const features = getClaudeResponsesCapabilities(provider, model);
  const customToolNames = new Set();
  let tools = buildTools(body, items, features, customToolNames);
  let choice = body.tool_choice;
  if (choice?.type === "allowed_tools") {
    if (!["required", "auto"].includes(choice.mode) || !Array.isArray(choice.tools) || !choice.tools.length) {
      invalid("tool_choice", "expected a mode and a nonempty array of allowed tools");
    }
    const names = new Set(choice.tools.map(tool => tool?.name ?? (tool?.type === "web_search" || tool?.type === "web_search_preview" ? "web_search" : undefined)));
    if ([...names].some(name => !tools.some(tool => tool.name === name))) invalid("tool_choice.tools", "the allowed tool was not declared");
    tools = tools.filter(tool => names.has(tool.name));
    choice = choice.mode;
  }
  const toolChoice = chooseTools(choice, body.parallel_tool_calls, tools);
  const result = {
    model,
    stream,
    max_tokens: body.max_output_tokens ?? adjustMaxTokens({ tools }, caps.maxOutput),
    messages,
    ...(body.temperature != null && { temperature: body.temperature }),
    ...(body.top_p != null && { top_p: body.top_p }),
    ...(tools.length && { tools, tool_choice: toolChoice }),
    ...(customToolNames.size && { _customToolNames: customToolNames }),
  };

  const format = body.text?.format;
  if (format?.type === "json_schema") {
    if (!isObject(format.schema)) invalid("text.format.schema", "expected a JSON Schema");
    if (features.structuredOutputs) {
      result.output_config = { format: { type: "json_schema", schema: format.schema } };
    } else if (format.strict === true) {
      invalid("text.format.strict", "strict JSON Schema output is unsupported on this route");
    } else {
      system.push(textBlock(`Respond only with JSON matching this schema:\n${JSON.stringify(format.schema)}`));
    }
  } else if (format?.type === "json_object") {
    system.push(textBlock("Respond only with a valid JSON object."));
  } else if (format != null && format.type !== "text") {
    invalid("text.format.type", "unsupported text format");
  }

  if (system.length) result.system = system;
  const mediaCaps = stripList.includes("image") ? { ...caps, vision: false } : caps;
  stripUnsupportedModalities(result, FORMATS.CLAUDE, mediaCaps, { includeToolResults: true });
  return result;
}

export function validateResponsesToClaudeThinking(result, body, model, provider) {
  const caps = getCapabilitiesForModel(provider, model);
  const { native } = getClaudeResponsesCapabilities(provider, model);
  const manual = result.thinking?.type === "enabled";
  if ((result.tool_choice?.type === "any" || result.tool_choice?.type === "tool") &&
      (caps.forcedToolChoice === false || (native && manual))) {
    invalid("tool_choice", "forced tool choice is unsupported with this model or thinking setting");
  }
  if (!native || !manual) return;
  if (result.messages.at(-1)?.content.some(block => block.type === CLAUDE_BLOCK.TOOL_RESULT)) {
    invalid("reasoning.effort", "manual thinking cannot resume a tool turn without Anthropic thinking blocks");
  }
  if (body.max_output_tokens != null) {
    const limit = Math.min(body.max_output_tokens, caps.maxOutput || DEFAULT_MAX_TOKENS);
    if (limit <= 1024) invalid("max_output_tokens", "manual thinking needs more than 1024 output tokens");
    result.thinking.budget_tokens = Math.min(result.thinking.budget_tokens, limit - 1);
  }
}

register(FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, responsesToClaudeRequest, null);
