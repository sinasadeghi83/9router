import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  logOpenAIRequest: vi.fn(),
  appendOpenAIChunk: vi.fn(),
  getCredentials: vi.fn(),
  accountUnavailable: vi.fn(),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  default: mocks.fetch,
  proxyAwareFetch: mocks.fetch,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getCredentials,
  markAccountUnavailable: mocks.accountUnavailable,
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: () => null,
  isValidApiKey: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, creds) => creds,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getComboTarget: async () => null,
  getComboOptions: async () => null,
  getModelInfo: async (id) => {
    const [provider, model] = id.split("/");
    return { provider, model };
  },
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
  filterAdapterModels: async (_ctx, models) => models,
}));
vi.mock("open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logOpenAIRequest: mocks.logOpenAIRequest,
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
    appendRawChunk: vi.fn(),
    appendProviderChunk: vi.fn(),
    appendConvertedChunk: vi.fn(),
    appendOpenAIChunk: mocks.appendOpenAIChunk,
  }),
}));

import { POST } from "@/app/api/v1/responses/route.js";
import { PROVIDERS } from "open-sse/config/providers.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const USAGE = { input_tokens: 9, cache_read_input_tokens: 4, cache_creation_input_tokens: 3, output_tokens: 5 };
const FUNCTIONS = [
  { type: "function", name: "lookup", parameters: { type: "object", properties: {} } },
  { type: "custom", name: "write_note", format: { type: "text" } },
];
const terminal = events => events.filter(event => /^response\.(completed|failed|incomplete)$/.test(event.type));
const upstreamMessage = (content, extra = {}) => ({
  type: "message", id: "msg_test", role: "assistant", model: MODEL, content, stop_reason: "end_turn", usage: USAGE, ...extra,
});
const jsonReply = (content, extra) => Response.json(upstreamMessage(content, extra));
const dataLine = (type, fields) => `event: ${type}\r\ndata: ${JSON.stringify(fields)}\r\n\r\n`;

function streamEvents(content, stop = "end_turn", details) {
  const { output_tokens, ...inputUsage } = USAGE;
  const frames = [dataLine("message_start", { message: upstreamMessage([], { stop_reason: null, usage: { ...inputUsage, output_tokens: 1 } }) })];
  for (const [index, block] of content.entries()) {
    const start = { ...block };
    const deltas = [];
    if (block.type === "text") {
      start.text = "";
      delete start.citations;
      deltas.push({ type: "text_delta", text: block.text });
      for (const citation of block.citations || []) deltas.push({ type: "citations_delta", citation });
    } else if (block.type === "thinking") {
      start.thinking = "";
      deltas.push({ type: "thinking_delta", thinking: block.thinking });
      deltas.push({ type: "signature_delta", signature: block.signature });
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      start.input = {};
      const json = JSON.stringify(block.input);
      deltas.push({ type: "input_json_delta", partial_json: json.slice(0, 4) }, { type: "input_json_delta", partial_json: json.slice(4) });
    }
    frames.push(dataLine("content_block_start", { index, content_block: start }));
    for (const delta of deltas) frames.push(dataLine("content_block_delta", { index, delta }));
    frames.push(dataLine("content_block_stop", { index }));
  }
  frames.push(dataLine("message_delta", { delta: { stop_reason: stop, stop_details: details }, usage: { output_tokens } }));
  frames.push(dataLine("message_stop", {}));
  return frames;
}

function sseReply(frames) {
  const bytes = new TextEncoder().encode(frames.join(""));
  const chunks = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.subarray(i, i + 17));
      controller.close();
    }
  });
  return new Response(chunks, { headers: { "Content-Type": "text/event-stream" } });
}

function post(body, headers = {}) {
  return POST(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: `anthropic/${MODEL}`, input: "hello", ...body }),
  }));
}

function sent() {
  const [url, init] = mocks.fetch.mock.calls.at(-1);
  expect(url).toBe(ENDPOINT);
  const result = JSON.parse(init.body);
  expect(result).not.toHaveProperty("input");
  expect(result).not.toHaveProperty("choices");
  expect(result).not.toHaveProperty("_customToolNames");
  return result;
}

async function eventsFrom(response) {
  expect(response.status).toBe(200);
  return (await response.text()).split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
}

describe("/v1/responses → Anthropic Messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentials.mockImplementation(async () => ({ apiKey: "test", connectionId: "test", connectionName: "test" }));
    mocks.accountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.fetch.mockResolvedValue(jsonReply([{ type: "text", text: "ok" }]));
  });

  it("sends native messages with system roles and remote/inline media", async () => {
    const response = await post({
      instructions: "Follow these instructions.",
      max_output_tokens: 29,
      input: [
        { role: "developer", content: [{ type: "input_text", text: "Keep it short." }] },
        { role: "user", content: [
          { type: "input_text", text: "Read these." },
          { type: "input_image", image_url: "https://example.com/image.png" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_file", file_url: "https://example.com/document.pdf" },
          { type: "input_file", file_data: "data:application/pdf;base64,AAAA" },
        ] },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: "response", status: "completed" });
    const wire = sent();
    expect(wire).toMatchObject({
      model: MODEL,
      stream: false,
      max_tokens: 29,
      system: [{ type: "text", text: "Follow these instructions." }, { type: "text", text: "Keep it short." }],
      messages: [{ role: "user", content: [
        { type: "text", text: "Read these." },
        { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "document", source: { type: "url", url: "https://example.com/document.pdf" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } },
      ] }],
    });
    expect(mocks.logOpenAIRequest).not.toHaveBeenCalled();
  });

  it("replays ordered assistant blocks and groups parallel tool results at the start of the user turn", async () => {
    const response = await post({
      tools: FUNCTIONS,
      parallel_tool_calls: false,
      input: [
        { role: "user", content: "Look up the item." },
        { role: "assistant", content: "I will look it up." },
        { type: "function_call", id: "fc_unrelated", call_id: "call_lookup", name: "lookup", arguments: '{"query":"item"}' },
        { role: "assistant", content: "I will also keep a note." },
        { type: "custom_tool_call", call_id: "call_note", name: "write_note", input: "raw note" },
        { role: "user", content: "Summarize." },
        { type: "function_call_output", call_id: "call_lookup", output: [
          { type: "input_text", text: "found" },
          { type: "input_image", image_url: "https://example.com/result.jpg" },
        ] },
        { type: "custom_tool_call_output", call_id: "call_note", output: "saved" },
      ],
    });

    expect(response.status).toBe(200);
    const wire = sent();
    expect(wire.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(wire.tools[1].input_schema.required).toEqual(["input"]);
    expect(wire.messages[1]).toMatchObject({ role: "assistant", content: [
      { type: "text", text: "I will look it up." },
      { type: "tool_use", id: "call_lookup", name: "lookup", input: { query: "item" } },
      { type: "text", text: "I will also keep a note." },
      { type: "tool_use", id: "call_note", name: "write_note", input: { input: "raw note" } },
    ] });
    expect(wire.messages[2]).toMatchObject({ role: "user", content: [
      { type: "tool_result", tool_use_id: "call_lookup", content: [
        { type: "text", text: "found" }, { type: "image", source: { type: "url", url: "https://example.com/result.jpg" } },
      ] },
      { type: "tool_result", tool_use_id: "call_note", content: "saved" },
      { type: "text", text: "Summarize." },
    ] });
    expect(mocks.logOpenAIRequest).not.toHaveBeenCalled();
  });

  it("can replay the visible history from a truncated turn", async () => {
    const response = await post({ input: [
      { role: "user", content: "Look up the item." },
      { role: "assistant", content: "I started looking it up." },
      { type: "function_call", status: "incomplete", call_id: "call_old", name: "lookup", arguments: '{"q":' },
      { role: "user", content: "Try again." },
    ] });
    expect(response.status).toBe(200);
    expect(sent().messages.flatMap(message => message.content).map(block => block.type)).toEqual(["text", "text", "text"]);
  });

  it("combines native schema, strict tools and adaptive thinking", async () => {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
    const response = await post({
      text: { format: { type: "json_schema", name: "answer", schema, strict: true } },
      reasoning: { effort: "high", summary: "auto" },
      tools: [{ type: "function", name: "lookup", parameters: schema, strict: true }],
    });
    expect(response.status).toBe(200);
    expect(sent()).toMatchObject({
      output_config: { effort: "high", format: { type: "json_schema", schema } },
      thinking: { type: "adaptive", display: "summarized" },
      tools: [{ name: "lookup", strict: true, input_schema: schema }],
    });
  });

  it.each([
    [{ previous_response_id: "resp_old" }, "previous_response_id"],
    [{ conversation: "conv_old" }, "conversation"],
    [{ input: [{ type: "item_reference", id: "item_old" }] }, "input[0].type"],
    [{ input: [{ role: "user", content: [{ type: "input_file", file_id: "file_old" }] }] }, "input[0].content[0].file_id"],
    [{ input: [null] }, "input[0]"],
    [{ input: [{ type: "function_call_output", call_id: "call_missing", output: "" }] }, "input[0].call_id"],
    [{ input: [{ type: "function_call", call_id: "call1", name: "lookup", arguments: "{}" }] }, "input"],
    [{ input: [
      { type: "function_call", call_id: "call1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call1", output: "ok" },
      { type: "function_call_output", call_id: "call1", output: "again" },
    ] }, "input[2].call_id"],
    [{ tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }] }, "tools[0].type"],
    [{ model: "anthropic/claude-sonnet-4-20250514", tools: [{ ...FUNCTIONS[0], strict: true }] }, "tools[0].strict"],
    [{ model: "anthropic/claude-sonnet-5-5", tools: FUNCTIONS, tool_choice: "required" }, "tool_choice"],
  ])("returns a field-specific 400 before contacting upstream %#", async (body, param) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { param } });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("uses the same ordered output and cumulative usage for JSON, collected SSE, and streaming", async () => {
    const content = [
      { type: "thinking", thinking: "a summary", signature: "native-signature" },
      { type: "text", text: "Checking π." },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { query: "pi" } },
      { type: "text", text: "Also saving the note." },
      { type: "tool_use", id: "toolu_2", name: "write_note", input: { input: "π and \"quotes\"" } },
    ];
    const body = { tools: FUNCTIONS, reasoning: { effort: "high", summary: "auto" } };
    const frames = streamEvents(content, "tool_use");

    mocks.fetch.mockResolvedValueOnce(jsonReply(content, { stop_reason: "tool_use" }));
    const json = await (await post(body)).json();

    mocks.fetch.mockResolvedValueOnce(sseReply(frames));
    const collected = await (await post(body)).json();
    expect(sent().stream).toBe(false);

    const provider = PROVIDERS.anthropic;
    const original = provider.forceStream;
    try {
      provider.forceStream = true;
      mocks.fetch.mockResolvedValueOnce(sseReply(frames));
      const forced = await (await post({ ...body, stream: false })).json();
      expect(sent().stream).toBe(true);
      expect(forced).toEqual({ ...json, created_at: forced.created_at });
    } finally {
      if (original === undefined) delete provider.forceStream;
      else provider.forceStream = original;
    }

    mocks.fetch.mockResolvedValueOnce(sseReply(frames));
    const events = await eventsFrom(await post({ ...body, stream: true }));
    expect(sent().stream).toBe(true);
    expect(terminal(events)).toHaveLength(1);
    const { response: streamed } = terminal(events)[0];
    expect(collected).toEqual({ ...json, created_at: collected.created_at });
    expect(streamed).toEqual({ ...json, created_at: streamed.created_at });
    expect(streamed.output.map(item => item.type)).toEqual(["reasoning", "message", "function_call", "message", "custom_tool_call"]);
    expect(streamed.output[4]).toMatchObject({ call_id: "toolu_2", input: "π and \"quotes\"" });
    expect(streamed.usage).toEqual({
      input_tokens: 16, input_tokens_details: { cached_tokens: 4 },
      output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 21,
    });
    expect(events.map(e => e.sequence_number)).toEqual(events.map((_e, index) => index));
    expect(events.filter(e => e.type === "response.output_item.done").map(e => e.item)).toEqual(streamed.output);
    expect(JSON.stringify(events)).not.toContain("native-signature");
    expect(mocks.logOpenAIRequest).not.toHaveBeenCalled();
    expect(mocks.appendOpenAIChunk).not.toHaveBeenCalled();
  });

  it("restores the client tool name before decoding a custom tool call", async () => {
    mocks.getCredentials.mockResolvedValueOnce({ accessToken: "sk-ant-oat-test", connectionId: "test", connectionName: "test" });
    mocks.fetch.mockImplementationOnce((_url, request) => {
      const wire = JSON.parse(request.body);
      const name = wire.tools[0].name;
      expect(name).not.toBe("write_note");
      return sseReply(streamEvents([{ type: "tool_use", id: "toolu_1", name, input: { input: "note" } }], "tool_use"));
    });

    const events = await eventsFrom(await post({ model: `claude/${MODEL}`, stream: true, tools: [FUNCTIONS[1]] }));
    expect(terminal(events)[0].response.output).toMatchObject([{ type: "custom_tool_call", name: "write_note", call_id: "toolu_1", input: "note" }]);
  });

  it("maps hosted search and citations without returning Anthropic continuation data", async () => {
    const url = "https://example.com/source";
    const content = [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "news" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
        { type: "web_search_result", url, title: "Source", encrypted_content: "native-only" },
      ] },
      { type: "text", text: "The source says hello.", citations: [
        { type: "web_search_result_location", url, title: "Source", cited_text: "hello", encrypted_index: "native-only" },
      ] },
    ];
    mocks.fetch.mockResolvedValueOnce(sseReply(streamEvents(content)));
    const events = await eventsFrom(await post({
      stream: true, tools: [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }],
      include: ["web_search_call.action.sources"], max_tool_calls: 2,
    }));
    expect(sent().tools).toMatchObject([{ type: "web_search_20250305", name: "web_search", allowed_domains: ["example.com"], max_uses: 2 }]);
    const [search, message] = terminal(events)[0].response.output;
    expect(search).toMatchObject({ type: "web_search_call", status: "completed", action: { type: "search", query: "news", sources: [{ type: "url", url }] } });
    expect(message.content[0].annotations).toEqual([{ type: "url_citation", url, title: "Source", start_index: 16, end_index: 21 }]);
    expect(events.some(event => event.type === "response.output_text.annotation.added")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("native-only");
  });

  it("keeps reasoning out of output unless requested and maps a refusal", async () => {
    mocks.fetch.mockResolvedValueOnce(sseReply(streamEvents([
      { type: "thinking", thinking: "private", signature: "native-signature" },
    ], "refusal", { explanation: "Cannot comply." })));
    const events = await eventsFrom(await post({ stream: true }));
    expect(events.some(event => event.type === "response.refusal.delta")).toBe(true);
    expect(terminal(events)[0].response.output[0].content).toEqual([{ type: "refusal", refusal: "Cannot comply." }]);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("keeps the response ID and emits one failure on a transport abort", async () => {
    const frames = streamEvents([{ type: "text", text: "partial answer" }]);
    let upstream;
    const body = new ReadableStream({
      start(controller) {
        upstream = controller;
        const head = frames.slice(0, 3).join("");
        controller.enqueue(new TextEncoder().encode(head));
      },
    });
    mocks.fetch.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const response = await post({ stream: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = decoder.decode((await reader.read()).value);
    upstream.error(new Error("socket hang up"));
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      raw += decoder.decode(next.value);
    }
    const events = raw.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(terminal(events)).toMatchObject([{ type: "response.failed", response: { id: "resp_msg_test" } }]);
    expect(events.filter(event => event.type === "response.created")).toHaveLength(1);
  });

  it.each([true, false])("finishes at message_stop without upstream EOF, stream=%s", async (stream) => {
    const frames = streamEvents([{ type: "text", text: "ok" }]);
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(frames.join(""))); },
      cancel,
    });
    mocks.fetch.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const response = await post({ stream });
    if (stream) expect(terminal(await eventsFrom(response))).toMatchObject([{ type: "response.completed" }]);
    else expect(await response.json()).toMatchObject({ status: "completed" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["max_tokens", frames => frames, "incomplete"],
    ["pause_turn", frames => frames, "failed"],
    ["end_turn", frames => frames.slice(0, -1), "failed"],
    ["end_turn", frames => [...frames.slice(0, -1), "data: no-json\n\n", frames.at(-1)], "failed"],
    ["end_turn", frames => [...frames.slice(0, -1), dataLine("error", { error: { message: "upstream overload" } }), frames.at(-1)], "failed"],
  ])("emits one terminal event for %s %#", async (stop, change, expected) => {
    const frames = streamEvents([{ type: "text", text: "partial answer" }], stop);
    mocks.fetch.mockResolvedValueOnce(sseReply(change(frames)));
    const events = await eventsFrom(await post({ stream: true }));
    expect(terminal(events)).toMatchObject([{ type: `response.${expected}`, response: { status: expected, id: "resp_msg_test" } }]);
    if (expected === "incomplete") expect(terminal(events)[0].response.incomplete_details.reason).toBe("max_output_tokens");
  });
});
