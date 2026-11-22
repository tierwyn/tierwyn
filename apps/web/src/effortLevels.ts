import {
  effortLevelsFor, modelNameBakesEffort, modelRejectsEffort,
  type AgentProfile, type EffortLevel,
} from '@tierwyn/shared';

/**
 * Levels an effort PICKER may offer for a profile — the composer pill and the
 * Prompt timer modal both call this so they can never disagree about whether a
 * model has an effort knob.
 *
 * Empty result = render no control and send no flag.
 */
export function pickerEffortLevels(profile: AgentProfile | undefined): readonly EffortLevel[] {
  if (!profile) return [];
  const levels = effortLevelsFor(profile.agentType);
  if (levels.length === 0) return levels;
  // agy Gemini/GPT-OSS rows already pick low/medium/high in the model list.
  if (modelNameBakesEffort(profile.model) || modelNameBakesEffort(profile.label)) return [];
  // agy Claude Thinking rows reject --effort outright ("--effort is not
  // supported for model …"): hide the picker and never send the flag.
  if (modelRejectsEffort(profile.agentType, profile.model)
      || modelRejectsEffort(profile.agentType, profile.label)) return [];
  return levels;
}
