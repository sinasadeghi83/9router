"use client";

// Combo groups chip editor. Groups are implicit labels: typing a new name adds
// it to the combo and makes it available everywhere else. Shared by the combo
// forms and the media combo detail page.
import { useState } from "react";
import PropTypes from "prop-types";
import { normalizeComboGroupName, collectComboGroups } from "@/shared/utils/comboGroups.js";
import { COMBO_GROUP_MAX_PER_COMBO } from "@/shared/constants/comboGroups.js";

export default function ComboGroupsField({
  groups = [],
  onChange,
  suggestions = [],
  error = "",
  label = "Combo groups",
  hint = "Optional. An API key can be restricted to one or more groups; it may then call every combo in those groups.",
  disabled = false,
}) {
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState("");

  const add = (raw) => {
    const name = normalizeComboGroupName(raw);
    if (!name) {
      setLocalError("Use 1-64 characters, no control characters.");
      return;
    }
    if (groups.some((g) => g.toLowerCase() === name.toLowerCase())) {
      setDraft("");
      setLocalError("");
      return;
    }
    if (groups.length >= COMBO_GROUP_MAX_PER_COMBO) {
      setLocalError(`At most ${COMBO_GROUP_MAX_PER_COMBO} groups per combo.`);
      return;
    }
    onChange([...groups, name]);
    setDraft("");
    setLocalError("");
  };

  const remove = (name) => {
    onChange(groups.filter((g) => g !== name));
    setLocalError("");
  };

  const availableSuggestions = collectComboGroups(
    (Array.isArray(suggestions) ? suggestions : []).map((name) => ({ groups: [name] }))
  ).filter((entry) => !groups.some((g) => g.toLowerCase() === entry.name.toLowerCase()));

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text-main">{label}</label>
      <div className="flex flex-wrap items-center gap-1.5">
        {groups.map((group) => (
          <span
            key={group}
            className="flex items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-xs text-text-main"
          >
            {group}
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(group)}
                className="rounded text-text-muted hover:text-red-500"
                title={`Remove group ${group}`}
                aria-label={`Remove group ${group}`}
              >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: "12px" }}>close</span>
              </button>
            )}
          </span>
        ))}
        {groups.length === 0 && (
          <span className="text-xs text-text-muted">No groups</span>
        )}
      </div>
      {!disabled && (
        <div className="flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setLocalError(""); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); add(draft); }
              if (e.key === "Escape") { setDraft(""); setLocalError(""); }
            }}
            placeholder="Add a group and press Enter"
            className="min-w-0 flex-1 rounded-[10px] border border-transparent bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-main placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            aria-label="Add combo group"
          />
          <button
            type="button"
            onClick={() => add(draft)}
            disabled={!draft.trim()}
            className="rounded-lg border border-dashed border-black/10 px-2 py-1.5 text-xs font-medium text-primary hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10"
          >
            Add
          </button>
        </div>
      )}
      {(localError || error) && <p className="text-xs text-red-500">{localError || error}</p>}
      {!disabled && availableSuggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-text-muted">Existing:</span>
          {availableSuggestions.slice(0, 12).map((entry) => (
            <button
              key={entry.name}
              type="button"
              onClick={() => add(entry.name)}
              className="rounded-md border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:bg-primary/5"
              title={`Add ${entry.name}`}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      <p className="text-[11px] text-text-muted">{hint}</p>
    </div>
  );
}

ComboGroupsField.propTypes = {
  groups: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
  suggestions: PropTypes.arrayOf(PropTypes.string),
  error: PropTypes.string,
  label: PropTypes.string,
  hint: PropTypes.string,
  disabled: PropTypes.bool,
};
