/** Pure trigger/empty-copy for ModelSelector. Distinguishes "fetch pending" from "zero enabled". */

export function modelSelectorTriggerLabel(
  selected: { label: string } | null | undefined,
  profiles: readonly unknown[],
  allowEmpty: boolean,
  loaded: boolean,
): string {
  if (selected) return selected.label;
  if (!loaded) return 'Loading';
  if (profiles.length === 0) return 'No agents enabled';
  return allowEmpty ? 'Select model' : 'Loading';
}

export function modelSelectorEmptyCopy(
  profiles: readonly unknown[],
  loaded: boolean,
): string {
  if (!loaded) return 'Loading';
  if (profiles.length === 0) return 'No agents enabled — turn one on in Settings → Agents.';
  return 'No matches';
}
