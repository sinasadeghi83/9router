// Combo groups: pure helpers shared by the DB layer, API routes, engine and UI.
// Group identity is case-insensitive; the first spelling wins for display.
import {
  COMBO_GROUP_CONTROL_CHARS,
  COMBO_GROUP_MAX_NAME_LENGTH,
  COMBO_GROUP_MAX_PER_COMBO,
} from "@/shared/constants/comboGroups.js";

const lower = (s) => String(s).toLowerCase();

/** Trim, collapse whitespace and strip control chars. Null when invalid. */
export function normalizeComboGroupName(value) {
  if (typeof value !== "string") return null;
  const name = value
    .replace(COMBO_GROUP_CONTROL_CHARS, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!name || name.length > COMBO_GROUP_MAX_NAME_LENGTH) return null;
  return name;
}

/**
 * Normalize a group list: strings only, trimmed, de-duplicated case-insensitively.
 * Invalid entries are dropped (lenient read path).
 */
export function normalizeComboGroups(list, { maxEntries = COMBO_GROUP_MAX_PER_COMBO } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const name = normalizeComboGroupName(item);
    if (!name) continue;
    const key = lower(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= maxEntries) break;
  }
  return out;
}

/** Lenient read of stored/backup data. */
export function readComboGroups(value) {
  return normalizeComboGroups(value);
}

/**
 * Validate client input for a group list. Rejects rather than repairs wrong
 * types, overlong names and too many entries.
 * @returns {{ ok: true, value: string[] } | { ok: false, error: string }}
 */
export function validateComboGroupsInput(input, { maxEntries = COMBO_GROUP_MAX_PER_COMBO } = {}) {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: "groups must be an array of strings" };
  if (input.length > maxEntries) return { ok: false, error: `groups has more than ${maxEntries} entries` };
  const seen = new Set();
  const out = [];
  for (const item of input) {
    if (typeof item !== "string") return { ok: false, error: "groups must be an array of strings" };
    const name = normalizeComboGroupName(item);
    if (!name) {
      return { ok: false, error: `group names must be 1-${COMBO_GROUP_MAX_NAME_LENGTH} characters` };
    }
    const key = lower(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return { ok: true, value: out };
}

/**
 * Distinct groups across combos, for the suggestion lists.
 * @returns {{ name: string, count: number }[]}
 */
export function collectComboGroups(combos) {
  const map = new Map();
  for (const combo of Array.isArray(combos) ? combos : []) {
    for (const group of Array.isArray(combo?.groups) ? combo.groups : []) {
      const name = normalizeComboGroupName(group);
      if (!name) continue;
      const key = lower(name);
      const existing = map.get(key);
      if (existing) existing.count += 1;
      else map.set(key, { name, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** group (lower) -> Set of combo names (lower). Used by the key-access engine. */
export function groupCombosByName(combos) {
  const map = new Map();
  for (const combo of Array.isArray(combos) ? combos : []) {
    if (typeof combo?.name !== "string") continue;
    for (const group of Array.isArray(combo?.groups) ? combo.groups : []) {
      const name = normalizeComboGroupName(group);
      if (!name) continue;
      const key = lower(name);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(lower(combo.name));
    }
  }
  return map;
}
