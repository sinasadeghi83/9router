"use client";

// Per-API-key access control on the Endpoint page.
// "Restrict access" per key; when on, the key may call only the listed
// combos/models and every combo in the granted combo groups. Entries are picked
// with the same shared ModelSelectModal the combo editor uses.
import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Toggle, ModelSelectModal, Modal, Input } from "@/shared/components";
import { collectComboGroups } from "@/shared/utils/comboGroups.js";

export default function KeyAccessControls({ apiKey, onChange, onRequestRestrict }) {
  const access = apiKey.access || { restricted: false, allow: [], groups: [] };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupQuery, setGroupQuery] = useState("");
  const [availableGroups, setAvailableGroups] = useState([]);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  const openPicker = async () => {
    setPickerOpen(true);
    // Same sources the combo editor feeds the picker with.
    try {
      const [providersRes, aliasRes] = await Promise.all([fetch("/api/providers"), fetch("/api/models/alias")]);
      if (providersRes.ok) setActiveProviders((await providersRes.json()).connections || []);
      if (aliasRes.ok) setModelAliases((await aliasRes.json()).aliases || {});
    } catch (error) {
      console.log("Error loading picker data:", error);
    }
  };

  const openGroups = async () => {
    setGroupQuery("");
    setGroupsOpen(true);
    try {
      const res = await fetch("/api/combos");
      const data = res.ok ? await res.json() : {};
      setAvailableGroups(collectComboGroups(data.combos || []).map((g) => g.name));
    } catch (error) {
      console.log("Error loading combo groups:", error);
      setAvailableGroups([]);
    }
  };

  const setAllow = (allow) => onChange({ restricted: true, allow, groups: access.groups || [] });
  const setGroups = (groups) => onChange({ restricted: true, allow: access.allow, groups });
  const add = (model) => {
    const value = model?.value;
    if (value && !access.allow.some((e) => e.toLowerCase() === value.toLowerCase())) setAllow([...access.allow, value]);
  };
  const remove = (value) => setAllow(access.allow.filter((e) => e !== value));
  const addGroup = (name) => {
    if (!access.groups.some((g) => g.toLowerCase() === name.toLowerCase())) setGroups([...access.groups, name]);
  };
  const removeGroup = (name) => setGroups(access.groups.filter((g) => g !== name));

  const filteredGroups = useMemo(() => {
    const q = groupQuery.trim().toLowerCase();
    if (!q) return availableGroups;
    return availableGroups.filter((name) => name.toLowerCase().includes(q));
  }, [availableGroups, groupQuery]);

  const empty = access.allow.length === 0 && (access.groups || []).length === 0;

  return (
    <div className="mt-2" data-testid="key-access">
      <Toggle
        size="sm"
        checked={access.restricted}
        label="Restrict access"
        onChange={(checked) => (checked
          ? onRequestRestrict()
          : onChange({ restricted: false, allow: access.allow, groups: access.groups || [] }))}
      />
      {access.restricted && (
        <div className="mt-2 flex flex-col gap-2">
          {empty && (
            <span className="text-xs text-orange-500">No combos, models or groups allowed — this key can call nothing.</span>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-text-muted">Groups</span>
            {(access.groups || []).map((group) => (
              <span key={group} className="flex items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-xs text-text-main">
                {group}
                <button
                  onClick={() => removeGroup(group)}
                  className="rounded text-text-muted hover:text-red-500"
                  title={`Remove group ${group}`}
                  aria-label={`Remove group ${group}`}
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: "12px" }}>close</span>
                </button>
              </span>
            ))}
            <button
              onClick={openGroups}
              className="flex items-center gap-0.5 rounded-xl border border-dashed border-black/10 px-2 py-0.5 text-xs font-medium text-primary hover:border-primary/50 dark:border-white/10"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>add</span>
              Add group
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-text-muted">Combos &amp; models</span>
            {access.allow.map((entry) => (
              <span key={entry} className="flex items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-xs text-text-main">
                {entry}
                <button
                  onClick={() => remove(entry)}
                  className="rounded text-text-muted hover:text-red-500"
                  title={`Remove ${entry}`}
                  aria-label={`Remove ${entry}`}
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: "12px" }}>close</span>
                </button>
              </span>
            ))}
            <button
              onClick={openPicker}
              className="flex items-center gap-0.5 rounded-xl border border-dashed border-black/10 px-2 py-0.5 text-xs font-medium text-primary hover:border-primary/50 dark:border-white/10"
            >
              <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>add</span>
              Add combo or model
            </button>
          </div>
          <p className="text-[11px] text-text-muted">
            A group grants the combos currently in it; their member models are still reached through those combos.
          </p>
        </div>
      )}

      {pickerOpen && (
        <ModelSelectModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={add}
          onDeselect={(model) => remove(access.allow.find((e) => e.toLowerCase() === String(model?.value).toLowerCase()))}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title={`Allowed for "${apiKey.name}"`}
          addedModelValues={access.allow}
          closeOnSelect={false}
        />
      )}

      <Modal isOpen={groupsOpen} onClose={() => setGroupsOpen(false)} title={`Combo groups for "${apiKey.name}"`}>
        <div className="flex flex-col gap-3">
          <Input
            label="Search groups"
            value={groupQuery}
            onChange={(e) => setGroupQuery(e.target.value)}
            placeholder="Filter groups…"
          />
          <div className="max-h-64 overflow-y-auto rounded-lg border border-black/10 dark:border-white/10">
            {filteredGroups.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-text-muted">No combo groups yet. Assign groups on the Combos page.</p>
            ) : (
              filteredGroups.map((name) => {
                const on = access.groups.some((g) => g.toLowerCase() === name.toLowerCase());
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => (on ? removeGroup(access.groups.find((g) => g.toLowerCase() === name.toLowerCase())) : addGroup(name))}
                    className="flex w-full items-center justify-between gap-2 border-b border-black/5 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-black/[0.03] dark:border-white/5 dark:hover:bg-white/[0.03]"
                  >
                    <code className="font-mono text-xs text-text-main">{name}</code>
                    <span className="material-symbols-outlined text-[18px] text-primary">{on ? "check_circle" : "add_circle"}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setGroupsOpen(false)}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90"
            >
              Done
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

KeyAccessControls.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    access: PropTypes.shape({
      restricted: PropTypes.bool,
      allow: PropTypes.arrayOf(PropTypes.string),
      groups: PropTypes.arrayOf(PropTypes.string),
    }),
  }).isRequired,
  onChange: PropTypes.func.isRequired,
  onRequestRestrict: PropTypes.func.isRequired,
};
