// Combo groups through the /api/combos routes.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [],
  created: [],
  updated: [],
}));

vi.mock("@/lib/localDb", () => ({
  getCombos: async () => fx.combos,
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getComboById: async (id) => fx.combos.find((c) => c.id === id) || null,
  createCombo: async (data) => {
    const combo = { id: "new-id", ...data };
    fx.created.push(combo);
    return combo;
  },
  updateCombo: async (id, data) => {
    const combo = { id, name: "c1", models: [], groups: [], options: {}, ...data };
    fx.updated.push(combo);
    return combo;
  },
  deleteCombo: async () => true,
}));

const { POST } = await import("../../src/app/api/combos/route.js");
const { PUT } = await import("../../src/app/api/combos/[id]/route.js");

const post = (body) => new Request("http://localhost/api/combos", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const put = (body) => new Request("http://localhost/api/combos/c1", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  fx.combos = [{ id: "c1", name: "c1", models: ["openai/gpt-4o"], groups: ["old"], options: {} }];
  fx.created = [];
  fx.updated = [];
});

describe("POST /api/combos groups", () => {
  it("normalizes and persists groups", async () => {
    const res = await POST(post({ name: "new", models: ["openai/gpt-4o"], groups: [" Team A ", "team a", "Premium"] }));
    expect(res.status).toBe(201);
    expect((await res.json()).groups).toEqual(["Team A", "Premium"]);
  });

  it("rejects an invalid group instead of truncating it", async () => {
    const res = await POST(post({ name: "new", models: [], groups: [42] }));
    expect(res.status).toBe(400);
    expect(fx.created).toEqual([]);
  });
});

describe("PUT /api/combos/[id] groups", () => {
  it("updates only groups when they are sent", async () => {
    const res = await PUT(put({ groups: ["basic"] }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(fx.updated[0].groups).toEqual(["basic"]);
  });

  it("rejects invalid group input", async () => {
    const res = await PUT(put({ groups: "basic" }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(400);
    expect(fx.updated).toEqual([]);
  });
});
