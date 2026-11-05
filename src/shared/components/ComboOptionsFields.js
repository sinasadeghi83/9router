"use client";

import { useState } from "react";
import Input from "./Input";
import Select from "./Select";
import Toggle from "./Toggle";
import { COMBO_OPTION_LIMITS, COMBO_REASONING_EFFORTS } from "open-sse/services/comboOptions.js";
import { countComboOptions } from "./comboOptionsDraft";
// Re-exported so existing imports from this module (and components/index.js) keep working.
export { comboOptionsToDraft, draftToComboOptions, validateComboOptionsDraft, countComboOptions } from "./comboOptionsDraft";

const fmtTokens = (n) => {
  if (!Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  return `${Math.round(n / 1000)}k`;
};

const REASONING_OPTIONS = [
  { value: "default", label: "Client decides (default)" },
  ...COMBO_REASONING_EFFORTS.map((e) => ({ value: e, label: e === "none" ? "none — thinking off" : e })),
];

/**
 * Per-combo settings editor (collapsible). Controlled via draft/onChange.
 * @param {{ draft: object, onChange: (draft: object) => void, errors?: object,
 *           derived?: { contextWindow?: number, maxOutput?: number }, defaultOpen?: boolean }} props
 */
export default function ComboOptionsFields({ draft, onChange, errors = {}, derived = {}, defaultOpen = false }) {
  const selectedLevels = Array.isArray(draft.thinkingLevels) ? draft.thinkingLevels : [];
  const derivedLevels = Array.isArray(derived.thinkingLevels) ? derived.thinkingLevels : null;
  const toggleLevel = (level) => {
    const next = selectedLevels.includes(level)
      ? selectedLevels.filter((l) => l !== level)
      : COMBO_REASONING_EFFORTS.filter((l) => l === level || selectedLevels.includes(l));
    onChange({ ...draft, thinkingLevels: next });
  };
  const [open, setOpen] = useState(defaultOpen);
  const set = (key) => (e) => onChange({ ...draft, [key]: e?.target ? e.target.value : e });
  const count = countComboOptions(draft);
  const derivedCtx = fmtTokens(derived.contextWindow);
  const derivedMax = fmtTokens(derived.maxOutput);

  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[16px] text-text-muted">tune</span>
          Settings
          {count > 0 && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{count} set</span>
          )}
        </span>
        <span className="material-symbols-outlined text-[18px] text-text-muted">{open ? "expand_less" : "expand_more"}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-black/5 px-3 py-3 dark:border-white/5">
          <p className="text-[11px] text-text-muted">
            Leave a field empty to keep the default. Limits are what <code className="font-mono">/v1/models</code> advertises;
            request defaults apply only when the client doesn&apos;t send the field (max output also caps larger requests).
          </p>

          <Input
            label="Display name"
            value={draft.displayName}
            onChange={set("displayName")}
            placeholder="e.g. Fast Coder"
            error={errors.displayName}
            hint="Shown to clients as the model's name. Clients still call it by the combo name."
          />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-main">Description</label>
            <textarea
              value={draft.description}
              onChange={set("description")}
              rows={2}
              placeholder="Optional note shown in model pickers"
              className="w-full resize-y rounded-[10px] border border-transparent bg-surface-2 px-3 py-2 text-[16px] text-text-main placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm"
            />
            {errors.description && <p className="text-xs text-red-500">{errors.description}</p>}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="Context window"
              type="number"
              inputMode="numeric"
              min={COMBO_OPTION_LIMITS.contextWindow.min}
              value={draft.contextWindow}
              onChange={set("contextWindow")}
              placeholder={derivedCtx ? `auto (${derivedCtx})` : "auto"}
              error={errors.contextWindow}
            />
            <Input
              label="Max output tokens"
              type="number"
              inputMode="numeric"
              min={COMBO_OPTION_LIMITS.maxOutputTokens.min}
              value={draft.maxOutputTokens}
              onChange={set("maxOutputTokens")}
              placeholder={derivedMax ? `auto (${derivedMax})` : "auto"}
              error={errors.maxOutputTokens}
            />
            <Input
              label="Temperature"
              type="number"
              step="0.1"
              min={COMBO_OPTION_LIMITS.temperature.min}
              max={COMBO_OPTION_LIMITS.temperature.max}
              value={draft.temperature}
              onChange={set("temperature")}
              placeholder="client default"
              error={errors.temperature}
            />
            <Input
              label="Top P"
              type="number"
              step="0.05"
              min={COMBO_OPTION_LIMITS.topP.min}
              max={COMBO_OPTION_LIMITS.topP.max}
              value={draft.topP}
              onChange={set("topP")}
              placeholder="client default"
              error={errors.topP}
            />
          </div>

          <Select
            label="Reasoning effort"
            options={REASONING_OPTIONS}
            value={draft.reasoningEffort || "default"}
            onChange={(e) => onChange({ ...draft, reasoningEffort: e.target.value === "default" ? "" : e.target.value })}
            hint="Mapped to each model's native thinking format; ignored by models that can't reason. ultra is native on Codex GPT-5.6 and becomes max (or xhigh) elsewhere."
          />

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-sm font-medium text-text-main">Thinking levels</label>
              {selectedLevels.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange({ ...draft, thinkingLevels: [] })}
                  className="text-[11px] text-primary hover:underline"
                >
                  Reset to auto
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Thinking levels">
              {COMBO_REASONING_EFFORTS.map((level) => {
                const on = selectedLevels.includes(level);
                const auto = selectedLevels.length === 0 && derivedLevels?.includes(level);
                return (
                  <button
                    key={level}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleLevel(level)}
                    className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                      on
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : auto
                          ? "border-dashed border-primary/40 text-primary/80 hover:bg-primary/5"
                          : "border-black/10 text-text-muted hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.03]"
                    }`}
                  >
                    {level}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-text-muted">
              {selectedLevels.length > 0
                ? "Advertised on /v1/models as this combo's supported levels. ultra is only native on Codex GPT-5.6; other models take it as max. Clients can still send the model(level) suffix."
                : derivedLevels
                  ? `Auto: the levels every reasoning model in this combo accepts (dashed). Pick levels to override.`
                  : "Auto: none of this combo's models reasons. Pick levels to advertise reasoning support anyway."}
            </p>
          </div>

          <Toggle
            checked={draft.hidden}
            onChange={(v) => onChange({ ...draft, hidden: v })}
            label="Hide from /v1/models"
            description="Still callable by name; just not listed to clients."
            size="sm"
          />
        </div>
      )}
    </div>
  );
}
