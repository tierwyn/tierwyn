export interface SidecarHostAdvisory {
  site: string;
  adapter: string;
  model: string;
  reason: string;
}

const REASON_TEXT: Record<string, string> = {
  agent_not_installed: 'agent not installed',
  model_not_on_host: 'model not on host',
  no_one_shot_on_host: 'no one-shot on host',
  mode_read_only_unsupported_on_host: 'read-only not supported on host',
  mode_none_unsupported_on_host: 'tools-off not supported on host',
  agent_not_remote: 'agent not remote',
};

function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason.replace(/_/g, ' ');
}

function siteTitle(a: SidecarHostAdvisory): string {
  return a.site === 'enhance' && a.reason === 'mode_read_only_unsupported_on_host'
    ? 'enhance project'
    : a.site;
}

function formatOne(a: SidecarHostAdvisory): string {
  return `${siteTitle(a)} (${a.adapter} · ${a.model} — ${reasonText(a.reason)})`;
}

/** Operator-facing line for hub tools-off sidecar fallbacks. Empty list → empty string. */
export function sidecarAdvisoryText(advisories: SidecarHostAdvisory[]): string {
  if (advisories.length === 0) return '';
  return `⚠ Sidecars that will run tools-off on the hub instead: ${advisories.map(formatOne).join(', ')}.`;
}
