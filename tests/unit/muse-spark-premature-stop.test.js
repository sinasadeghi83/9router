// Muse Spark premature-stop guards: output floor, incomplete→length mapping,
// and no fabricated STOP on premature stream close.
import { describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { isMuseSparkModel, clampMuseSparkOutputTokens } = await import(
  "../../open-sse/providers/models/helpers.js"
);
const { responsesToOpenAICompletion, responsesToClaudeMessage } = await import(
  "../../open-sse/handlers/chatCore/responseFormats.js"
);
const { openaiResponsesToOpenAIResponse } = await import(
  "../../open-sse/translator/response/openai-responses.js"
);
const { fromOpenAIFinish } = await import(
  "../../open-sse/translator/concerns/finishReason.js"
);

const INCOMPLETE_BODY = {
  id: "resp_trunc1",
  object: "response",
  created_at: 1700000000,
  model: "muse-spark-1.3",
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I'm going to check the file now…" }],
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
};

describe("muse spark output floor", () => {
  it("matches spark model ids", () => {
    expect(isMuseSparkModel("muse-spark-1.3")).toBe(true);
    expect(isMuseSparkModel("muse/muse-spark-1.3")).toBe(true);
    expect(isMuseSparkModel("gpt-5-codex")).toBe(false);
  });

  it("raises small caps to the 8000 floor", () => {
    expect(clampMuseSparkOutputTokens(1024)).toBe(8000);
    expect(clampMuseSparkOutputTokens(undefined)).toBe(8000);
    expect(clampMuseSparkOutputTokens(32000)).toBe(32000);
  });
});

describe("incomplete responses surface as length, not a clean stop", () => {
  it("maps non-streaming incomplete (no tool calls) to length", () => {
    const out = responsesToOpenAICompletion(INCOMPLETE_BODY);
    expect(out.choices[0].finish_reason).toBe("length");
  });

  it("keeps tool_calls priority on incomplete turns that did emit calls", () => {
    const withCall = {
      ...INCOMPLETE_BODY,
      output: [
        ...INCOMPLETE_BODY.output,
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"/tmp/x"}',
        },
      ],
    };
    expect(responsesToOpenAICompletion(withCall).choices[0].finish_reason).toBe("tool_calls");
  });

  it("delivers incomplete to a Claude client as max_tokens", () => {
    const claude = responsesToClaudeMessage(INCOMPLETE_BODY);
    expect(claude.stop_reason).toBe(fromOpenAIFinish("length", "claude"));
    expect(claude.stop_reason).toBe("max_tokens");
  });
});

describe("premature stream close never fabricates a clean stop", () => {
  const freshState = () => ({
    started: true,
    finishReasonSent: false,
    toolCallIndex: 0,
    currentToolCallId: null,
    chatId: "chatcmpl-test",
    created: 1700000000,
    model: "muse-spark-1.3",
  });

  it("emits length (not stop) when the stream closes with no terminal event and no tool call", () => {
    const chunk = openaiResponsesToOpenAIResponse(null, freshState());
    expect(chunk).toBeTruthy();
    expect(chunk.choices[0].finish_reason).toBe("length");
  });

  it("still emits tool_calls when a call was seen before the close", () => {
    const state = freshState();
    state.toolCallIndex = 1;
    const chunk = openaiResponsesToOpenAIResponse(null, state);
    expect(chunk.choices[0].finish_reason).toBe("tool_calls");
  });
});
