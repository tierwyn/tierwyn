import { useEffect, useState } from 'react';
import type { AgentProfile, BtwSettings } from '@tierwyn/shared';
import { api } from '../api.js';
import { ModelSelector } from './ModelSelector.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

interface Props {
  profiles: AgentProfile[];
  profilesLoaded?: boolean;
  disabled?: boolean;
}

const primingModeOptions: SelectDropdownOption<BtwSettings['primingMode']>[] = [
  { value: 'question-aware', label: 'Question-aware' },
  { value: 'generic', label: 'Generic' },
];

export function BtwSettings({ profiles, profilesLoaded = true, disabled = false }: Props) {
  const [btw, setBtw] = useState<BtwSettings | null>(null);

  useEffect(() => {
    api.getBtwSettings().then(setBtw).catch(() => { /* offline */ });
  }, []);

  if (!btw) return null;

  const save = async (patch: Partial<BtwSettings>) => {
    const updated = await api.updateBtwSettings(patch);
    setBtw(updated);
  };

  return (
    <>
      <div className="modal-field">
        <span className="modal-label">Priming mode</span>
        <SelectDropdown
          options={primingModeOptions}
          value={btw.primingMode}
          onChange={(val) => void save({ primingMode: val })}
          placement="bottom"
          disabled={disabled}
        />
        <span className="modal-hint">
          The conversation is summarised first so the answering model sees it.
          Question-aware focuses that summary on your side question. Generic uses
          the same summary a normal handoff would.
        </span>
      </div>

      <div className="modal-field">
        <span className="modal-label">Priming profile</span>
        {/* ponytail: allowEmpty so null renders as "Select model" = use compaction default.
            No way to revert to null after picking a profile via this UI — use synthetic
            option approach if the operator needs a clear button. */}
        <ModelSelector
          profiles={profiles}
          profilesLoaded={profilesLoaded}
          selectedProfileId={btw.primingProfileId ?? ''}
          allowEmpty
          disabled={disabled}
          onChange={(val) => void save({ primingProfileId: val || null })}
          placement="bottom"
        />
        <span className="modal-hint">
          Which model writes that summary. Empty uses Compaction's Preferred
          Summariser. The summariser runs tool-free (no file or shell tools).
        </span>
      </div>
    </>
  );
}
