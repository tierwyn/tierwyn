import { useEffect, useState } from 'react';
import type { CompactionSettings as Settings, AgentProfile, Workdir } from '@tierwyn/shared';
import { api } from '../api.js';
import { ModelSelector } from './ModelSelector.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

interface Props {
  profiles: AgentProfile[];
  profilesLoaded?: boolean;
  onClose: () => void;
  /** Called with the updated settings after every successful save so the
   *  parent can refresh any cached mode it passes down to InputBar. */
  onChanged?: (s: Settings) => void;
}

const verbosityOptions: SelectDropdownOption<Settings['summaryVerbosity']>[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const handoffModeOptions: SelectDropdownOption<Settings['handoffMode']>[] = [
  { value: 'summary', label: 'Always summarize' },
  { value: 'transcript', label: 'Pass full transcript' },
  { value: 'prompt', label: 'Ask at each handoff' },
];

const interactionModeOptions: SelectDropdownOption<Settings['interactionMode']>[] = [
  { value: 'bypass', label: 'Bypass (auto-approve all tools)' },
  { value: 'questions', label: 'Questions only (bypass permissions, surface plans/questions)' },
  { value: 'prompt', label: 'Prompt (ask for permissions and questions)' },
];

const workdirOptions: SelectDropdownOption<Workdir>[] = [
  { value: 'shared', label: 'Shared' },
  { value: 'worktree', label: 'Worktree' },
];

export function CompactionSettings({ profiles, profilesLoaded = true, onClose, onChanged }: Props) {
  const [s, setS] = useState<Settings | null>(null);

  useEffect(() => {
    api.getCompaction().then(setS);
  }, []);

  if (!s) return null;

  const save = async (patch: Partial<Settings>) => {
    const updated = await api.updateCompaction(patch);
    setS(updated);
    onChanged?.(updated);
  };

  const showSummaryFields = s.compactionEnabled && (s.handoffMode === 'summary' || s.handoffMode === 'prompt');
  const showTranscriptFields = s.compactionEnabled && s.handoffMode === 'transcript';
  const disabledStyle: React.CSSProperties = { opacity: 0.5, pointerEvents: 'none' };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Compaction Settings</span>
          <button className="usage-close" onClick={onClose} style={{ fontSize: '18px' }}>×</button>
        </div>

        <div className="modal-body">
          <div className="modal-field">
            <span className="modal-label">Interaction mode</span>
            <SelectDropdown
              options={interactionModeOptions}
              value={s.interactionMode}
              onChange={(val) => save({ interactionMode: val })}
              placement="bottom"
            />
          </div>

          <div className="modal-field modal-field-row">
            <span className="modal-label">Require operator approval for agent spawns</span>
            <button
              type="button"
              role="switch"
              aria-checked={s.spawnApprovalRequired}
              className={`toggle-switch${s.spawnApprovalRequired ? ' on' : ''}`}
              onClick={() => save({ spawnApprovalRequired: !s.spawnApprovalRequired })}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          <div className="modal-field">
            <span className="modal-label">Default delegate workdir</span>
            <SelectDropdown<Workdir>
              options={workdirOptions}
              value={s.defaultSpawnWorkdir ?? 'shared'}
              onChange={(val) => save({ defaultSpawnWorkdir: val })}
              placement="bottom"
            />
          </div>

          <div className="modal-field modal-field-row">
            <span className="modal-label">Enable handoff priming</span>
            <button
              type="button"
              role="switch"
              aria-checked={s.compactionEnabled}
              className={`toggle-switch${s.compactionEnabled ? ' on' : ''}`}
              onClick={() => save({ compactionEnabled: !s.compactionEnabled })}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          <div className="modal-field" style={s.compactionEnabled ? {} : disabledStyle}>
            <span className="modal-label">Handoff mode</span>
            <SelectDropdown
              options={handoffModeOptions}
              value={s.handoffMode}
              onChange={(val) => save({ handoffMode: val })}
              placement="bottom"
            />
          </div>

          {showSummaryFields && (
            <>
              <div className="modal-field">
                <span className="modal-label">Preferred Summariser</span>
                <ModelSelector
                  profiles={profiles}
                  profilesLoaded={profilesLoaded}
                  selectedProfileId={s.preferredProfileId}
                  onChange={(val) => save({ preferredProfileId: val })}
                  placement="bottom"
                />
              </div>

              <div className="modal-field">
                <span className="modal-label">Fallback Summariser</span>
                <ModelSelector
                  profiles={profiles}
                  profilesLoaded={profilesLoaded}
                  selectedProfileId={s.fallbackProfileId}
                  onChange={(val) => save({ fallbackProfileId: val })}
                  placement="bottom"
                />
              </div>

              <div className="modal-field">
                <span className="modal-label">Max Compactor Context (Tokens)</span>
                <input
                  type="number"
                  className="modal-input"
                  value={s.maxCompactorContextTokens}
                  onChange={(e) => save({ maxCompactorContextTokens: Number(e.target.value) })}
                />
              </div>

              <div className="modal-field">
                <span className="modal-label">Summary Verbosity</span>
                <SelectDropdown
                  options={verbosityOptions}
                  value={s.summaryVerbosity}
                  onChange={(val) => save({ summaryVerbosity: val })}
                  placement="bottom"
                />
              </div>

              <div className="modal-field">
                <span className="modal-label">Output Token Cap</span>
                <input
                  type="number"
                  className="modal-input"
                  value={s.outputTokenCap}
                  onChange={(e) => save({ outputTokenCap: Number(e.target.value) })}
                />
              </div>

              {s.handoffMode === 'prompt' && (
                <div className="modal-field">
                  <span className="modal-label" style={{ fontStyle: 'italic', opacity: 0.7 }}>
                    User will choose per handoff (Summarize / Pass full transcript).
                  </span>
                </div>
              )}
            </>
          )}

          {showTranscriptFields && (
            <>
              <div className="modal-field">
                <span className="modal-label">Max Transcript Tokens</span>
                <input
                  type="number"
                  className="modal-input"
                  value={s.maxTranscriptHandoffTokens}
                  onChange={(e) => save({ maxTranscriptHandoffTokens: Number(e.target.value) })}
                />
              </div>

              <div className="modal-field">
                <span className="modal-label">Context Safety Factor (0.1–0.9)</span>
                <input
                  type="number"
                  className="modal-input"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={s.transcriptContextSafetyFactor}
                  onChange={(e) => save({ transcriptContextSafetyFactor: Number(e.target.value) })}
                />
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

