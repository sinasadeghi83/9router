// Combo groups: shared constants for `combos.groups` and `apiKeys.access.groups`.
// Groups are implicit labels derived from combos (no separate table): typing a
// new label on a combo creates it, and removing it from every combo removes it.

// Upper bound for one combo's group list and for one key's granted groups.
export const COMBO_GROUP_MAX_PER_COMBO = 50;
export const COMBO_GROUP_MAX_NAME_LENGTH = 64;

// Control characters never belong in a one-line label.
export const COMBO_GROUP_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
