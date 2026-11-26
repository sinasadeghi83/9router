import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
// Relative path (not the open-sse alias) so the DB layer also loads under plain Node.
import { readComboOptions } from "../../../../open-sse/services/comboOptions.js";
import { readComboGroups } from "@/shared/utils/comboGroups.js";

export function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    groups: readComboGroups(parseJson(row.groups, [])),
    options: readComboOptions(parseJson(row.options, {})),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Empty options are stored as NULL so the column stays sparse.
export function optionsToColumn(options) {
  const clean = readComboOptions(options);
  return Object.keys(clean).length ? stringifyJson(clean) : null;
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    groups: readComboGroups(data.groups),
    options: readComboOptions(data.options),
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, groups, options, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), stringifyJson(combo.groups), optionsToColumn(combo.options), combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    merged.options = readComboOptions(merged.options);
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, groups = ?, options = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), stringifyJson(readComboGroups(merged.groups)), optionsToColumn(merged.options), merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
