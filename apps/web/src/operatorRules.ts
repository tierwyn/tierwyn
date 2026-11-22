import type { Conversation, Project } from '@tierwyn/shared';
import {
  RULES_CHAIN_GUARD_DEPTH,
  RULES_MAX_BYTES,
  RULES_TOTAL_MAX_BYTES,
  RULE_PRESETS_MAX_PER_LAYER,
  composeRuleBlocks,
  renderedRules,
  rulesByteLength,
  type RulesComposeLayer,
  type RulesComposePreset,
} from '@tierwyn/shared';

export {
  RULES_MAX_BYTES,
  RULES_TOTAL_MAX_BYTES,
  RULE_PRESETS_MAX_PER_LAYER,
  RULES_CHAIN_GUARD_DEPTH,
  rulesByteLength,
  composeRuleBlocks,
  renderedRules,
};

export type { RulesComposeLayer, RulesComposePreset };

/** True when project or any ancestor-chain conversation has custom rules or presets. */
export function conversationHasAppliedRules(
  project: Pick<Project, 'rules' | 'rulePresetIds' | 'system'> | undefined,
  conversation: Pick<Conversation, 'id' | 'rules' | 'rulePresetIds' | 'parentConversationId'> | undefined,
  byId: Map<string, Pick<Conversation, 'id' | 'rules' | 'rulePresetIds' | 'parentConversationId'>>,
): boolean {
  if (!project || project.system || !conversation) return false;
  if (project.rules?.trim() || (project.rulePresetIds?.length ?? 0) > 0) return true;
  const seen = new Set<string>();
  let cur: Pick<Conversation, 'id' | 'rules' | 'rulePresetIds' | 'parentConversationId'> | undefined = conversation;
  let depth = 0;
  while (cur && depth < RULES_CHAIN_GUARD_DEPTH) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    if (cur.rules?.trim() || (cur.rulePresetIds?.length ?? 0) > 0) return true;
    cur = cur.parentConversationId ? byId.get(cur.parentConversationId) : undefined;
    depth += 1;
  }
  return false;
}

export function livePreview(layers: RulesComposeLayer[]): { rendered: string; bytes: number; omitted: number } {
  const { blocks, omitted } = composeRuleBlocks(layers);
  const rendered = renderedRules({ blocks, omitted });
  return { rendered, bytes: rulesByteLength(rendered), omitted };
}

export const RULE_PRESETS_CHANGED_EVENT = 'rule-presets-changed';

export function notifyRulePresetsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(RULE_PRESETS_CHANGED_EVENT));
  }
}
