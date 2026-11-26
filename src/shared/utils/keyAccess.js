// Per-API-key access control: pure helpers (no DB, no
// request objects), shared by the DB repo, the API routes and the engine.
import {
  KEY_ACCESS_MAX_ENTRIES,
  KEY_ACCESS_MAX_ENTRY_LENGTH,
  KEY_ACCESS_UNRESTRICTED,
} from "@/shared/constants/keyAccess.js";
import { normalizeComboGroups, validateComboGroupsInput } from "@/shared/utils/comboGroups.js";

/**
 * Normalize an allow list: keep strings only, trim, drop empties, de-duplicate
 * case-insensitively (the first spelling wins). Order is preserved.
 */
export function normalizeAllowList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const entry = item.trim();
    if (!entry) continue;
    const k = entry.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(entry);
  }
  return out;
}

/**
 * Build the access object from the apiKeys columns.
 *
 * Fails CLOSED: the restricted flag has its own INTEGER column, so a corrupt or
 * unparsable allow list / group list can only ever shrink what a restricted key
 * may call (to nothing); it can never turn a restricted key into an
 * unrestricted one.
 */
export function keyAccessFromColumns(restrictedCol, allowCol, groupsCol) {
  const restricted = restrictedCol === 1 || restrictedCol === true;
  if (!restricted) return { restricted: false, allow: [], groups: [] };
  let parsed = [];
  if (typeof allowCol === "string" && allowCol) {
    try { parsed = JSON.parse(allowCol); } catch { parsed = []; }
  }
  let parsedGroups = [];
  if (typeof groupsCol === "string" && groupsCol) {
    try { parsedGroups = JSON.parse(groupsCol); } catch { parsedGroups = []; }
  }
  return {
    restricted: true,
    allow: normalizeAllowList(parsed),
    groups: normalizeComboGroups(parsedGroups, { maxEntries: KEY_ACCESS_MAX_ENTRIES }),
  };
}

/** Columns to persist for an access object (already validated/normalized). */
export function keyAccessToColumns(access) {
  const value = access || KEY_ACCESS_UNRESTRICTED;
  const restricted = Boolean(value.restricted);
  return {
    accessRestricted: restricted ? 1 : 0,
    accessAllow: JSON.stringify(restricted ? normalizeAllowList(value.allow) : []),
    accessGroups: JSON.stringify(restricted
      ? normalizeComboGroups(value.groups, { maxEntries: KEY_ACCESS_MAX_ENTRIES })
      : []),
  };
}

/**
 * Validate client input for an access update ({ restricted, allow, groups }).
 * Rejects rather than repairs: wrong types, too many entries, overlong entries.
 * @returns {{ ok: true, value: {restricted: boolean, allow: string[], groups: string[]} } | { ok: false, error: string }}
 */
export function validateKeyAccessInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "access must be an object { restricted, allow, groups }" };
  }
  const extra = Object.keys(input).filter((k) => k !== "restricted" && k !== "allow" && k !== "groups");
  if (extra.length) return { ok: false, error: `access: unexpected field(s) ${extra.join(", ")}` };
  if (typeof input.restricted !== "boolean") {
    return { ok: false, error: "access.restricted must be a boolean" };
  }
  const allow = input.allow === undefined ? [] : input.allow;
  if (!Array.isArray(allow) || allow.some((e) => typeof e !== "string")) {
    return { ok: false, error: "access.allow must be an array of strings" };
  }
  if (allow.length > KEY_ACCESS_MAX_ENTRIES) {
    return { ok: false, error: `access.allow has more than ${KEY_ACCESS_MAX_ENTRIES} entries` };
  }
  if (allow.some((e) => e.trim().length > KEY_ACCESS_MAX_ENTRY_LENGTH)) {
    return { ok: false, error: `access.allow entries must be at most ${KEY_ACCESS_MAX_ENTRY_LENGTH} characters` };
  }
  const groups = validateComboGroupsInput(input.groups, { maxEntries: KEY_ACCESS_MAX_ENTRIES });
  if (!groups.ok) return { ok: false, error: `access.groups: ${groups.error}` };
  return {
    ok: true,
    value: { restricted: input.restricted, allow: normalizeAllowList(allow), groups: groups.value },
  };
}
