// Per-combo options: validation, request-default application, DB round-trip,
// /v1/models publishing, and chat-handler wiring.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeComboOptions, readComboOptions, applyComboRequestOptions } from "../../open-sse/services/comboOptions.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("normalizeComboOptions", () => {
  it("keeps valid fields, coerces numeric strings, drops empties", () => {
    const { value, errors } = normalizeComboOptions({
      displayName: "  Fast Coder ",
      description: "",
      contextWindow: "200000",
      maxOutputTokens: 16000,
      temperature: "",
      topP: 0.9,
      reasoningEffort: "HIGH",
      hidden: false,
    });
    expect(errors).toEqual([]);
    expect(value).toEqual({ displayName: "Fast Coder", contextWindow: 200000, maxOutputTokens: 16000, topP: 0.9, reasoningEffort: "high" });
  });

  it("rejects out-of-range, non-integer, unknown and wrongly-typed fields", () => {
    const { errors } = normalizeComboOptions({
      contextWindow: 10, maxOutputTokens: 1000.5, temperature: 3, reasoningEffort: "turbo", hidden: "yes", foo: 1, displayName: 42,
    });
    expect(errors.join("|")).toMatch(/contextWindow/);
    expect(errors.join("|")).toMatch(/maxOutputTokens must be a whole number/);
    expect(errors.join("|")).toMatch(/temperature/);
    expect(errors.join("|")).toMatch(/reasoningEffort/);
    expect(errors.join("|")).toMatch(/hidden/);
    expect(errors.join("|")).toMatch(/unknown option: foo/);
    expect(errors.join("|")).toMatch(/displayName must be a string/);
  });

  it("strips control characters from the display name", () => {
    expect(normalizeComboOptions({ displayName: "a\nb\u0000c" }).value.displayName).toBe("a b c");
  });

  it("rejects non-object input; readComboOptions is lenient", () => {
    expect(normalizeComboOptions([]).errors).toEqual(["options must be an object"]);
    expect(readComboOptions("garbage")).toEqual({});
    expect(readComboOptions({ contextWindow: 5, displayName: "ok" })).toEqual({ displayName: "ok" });
  });
});

describe("applyComboRequestOptions", () => {
  it("fills absent OpenAI fields and caps an oversized max_tokens", () => {
    const opts = { maxOutputTokens: 8000, temperature: 0.2, topP: 0.9, reasoningEffort: "low" };
    const filled = applyComboRequestOptions({ messages: [] }, opts, FORMATS.OPENAI).body;
    expect(filled).toMatchObject({ max_tokens: 8000, temperature: 0.2, top_p: 0.9, reasoning_effort: "low" });

    const capped = applyComboRequestOptions({ messages: [], max_completion_tokens: 64000 }, opts, FORMATS.OPENAI).body;
    expect(capped.max_completion_tokens).toBe(8000);
    expect(capped.max_tokens).toBeUndefined();
  });

  it("never overrides what the client sent (except capping max tokens)", () => {
    const body = { messages: [], max_tokens: 1000, temperature: 1, top_p: 0.5, reasoning_effort: "high" };
    const { body: out, applied } = applyComboRequestOptions(body, { maxOutputTokens: 8000, temperature: 0.2, topP: 0.9, reasoningEffort: "low" }, FORMATS.OPENAI);
    expect(out).toBe(body);
    expect(applied).toEqual([]);
  });

  it("does not mutate the input body", () => {
    const body = { messages: [], max_tokens: 64000 };
    applyComboRequestOptions(body, { maxOutputTokens: 8000 }, FORMATS.OPENAI);
    expect(body.max_tokens).toBe(64000);
  });

  it("uses Responses field names", () => {
    const out = applyComboRequestOptions({ input: "hi" }, { maxOutputTokens: 4000, reasoningEffort: "medium" }, FORMATS.OPENAI_RESPONSES).body;
    expect(out).toMatchObject({ max_output_tokens: 4000, reasoning: { effort: "medium" } });
    expect(out.max_tokens).toBeUndefined();
  });

  it("keeps Claude thinking budget below the capped max_tokens", () => {
    const out = applyComboRequestOptions(
      { messages: [], max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 32000 } },
      { maxOutputTokens: 16000, reasoningEffort: "low" },
      FORMATS.CLAUDE,
    ).body;
    expect(out.max_tokens).toBe(16000);
    expect(out.thinking.budget_tokens).toBe(15999);
    expect(out.output_config).toBeUndefined(); // client already expressed thinking intent
  });

  it("expresses Claude reasoning default via output_config.effort", () => {
    const out = applyComboRequestOptions({ messages: [], max_tokens: 1000 }, { reasoningEffort: "high" }, FORMATS.CLAUDE).body;
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("writes Gemini knobs into generationConfig", () => {
    const out = applyComboRequestOptions({ contents: [], generationConfig: { maxOutputTokens: 99999 } }, { maxOutputTokens: 2048, temperature: 0.3, reasoningEffort: "none" }, FORMATS.GEMINI).body;
    expect(out.generationConfig).toMatchObject({ maxOutputTokens: 2048, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } });
  });

  it("is a no-op with display-only options", () => {
    const body = { messages: [] };
    expect(applyComboRequestOptions(body, { displayName: "x", contextWindow: 100000 }, FORMATS.OPENAI)).toEqual({ body, applied: [] });
  });
});

describe("combos repo: options persistence", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;
  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("creates, updates, clears, exports and imports options", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-opts-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    const db = await import("@/lib/db/index.js");

    const created = await db.createCombo({ name: "c1", models: ["openai/gpt-x"], options: { displayName: "One", contextWindow: 100000 } });
    expect((await db.getComboByName("c1")).options).toEqual({ displayName: "One", contextWindow: 100000 });

    // Updating other fields keeps options.
    await db.updateCombo(created.id, { models: ["openai/gpt-y"] });
    expect((await db.getComboById(created.id)).options).toEqual({ displayName: "One", contextWindow: 100000 });

    await db.updateCombo(created.id, { options: { maxOutputTokens: 4096 } });
    expect((await db.getComboById(created.id)).options).toEqual({ maxOutputTokens: 4096 });

    const exported = await db.exportDb();
    expect(exported.combos[0].options).toEqual({ maxOutputTokens: 4096 });

    await db.updateCombo(created.id, { options: {} });
    expect((await db.getComboById(created.id)).options).toEqual({});

    await db.importDb(exported);
    expect((await db.getComboByName("c1")).options).toEqual({ maxOutputTokens: 4096 });

    // Combos without options (older rows/backups) read back as {}.
    await db.createCombo({ name: "c2", models: [] });
    expect((await db.getComboByName("c2")).options).toEqual({});
  });
});

describe("combos.options column on an existing DB", () => {
  let tempDir;
  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it("adds the column to a pre-options combos table and keeps rows", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-upgrade-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter } = await import("@/lib/db/driver.js");
    let db = await getAdapter();
    // Simulate the old schema: rebuild combos without the options column.
    db.exec("DROP TABLE combos");
    db.exec("CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
    db.run("INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES('old', 'legacy', NULL, '[\"openai/gpt-x\"]', 't', 't')");
    db.run("UPDATE _meta SET value = '2' WHERE key = 'backupSchemaVersion'");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: reopen } = await import("@/lib/db/driver.js");
    db = await reopen();
    const cols = db.all("PRAGMA table_info(combos)").map((c) => c.name);
    expect(cols).toContain("options");

    const repo = await import("@/lib/db/repos/combosRepo.js");
    const legacy = await repo.getComboByName("legacy");
    expect(legacy).toMatchObject({ models: ["openai/gpt-x"], options: {} });
    const updated = await repo.updateCombo("old", { options: { displayName: "Legacy" } });
    expect(updated.options).toEqual({ displayName: "Legacy" });
  });
});
