import { useState } from 'react';
import {
  DEFAULT_ROLE_MATCH_KEYWORDS,
  ROLE_MATCH_KEYWORD_RE,
  ROLE_MATCH_MAX_KEYWORDS,
  ROLE_MATCH_MAX_STAGES,
  STAGE_ID_RE,
} from '@tierwyn/shared';

const BUILTIN_STAGES = Object.keys(DEFAULT_ROLE_MATCH_KEYWORDS);

interface Props {
  value: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
}

function stageOrder(value: Record<string, string[]>): string[] {
  const extras = Object.keys(value).filter((k) => !Object.hasOwn(DEFAULT_ROLE_MATCH_KEYWORDS, k));
  return [...BUILTIN_STAGES, ...extras];
}

function keywordsFor(value: Record<string, string[]>, stage: string): string[] {
  return value[stage] ?? DEFAULT_ROLE_MATCH_KEYWORDS[stage] ?? [];
}

export function RoleMatchKeywordsEditor({ value, onChange }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newStage, setNewStage] = useState('');

  const commitKeyword = (stage: string, raw: string) => {
    const kw = raw.trim().toLowerCase();
    if (!kw || !ROLE_MATCH_KEYWORD_RE.test(kw)) return;
    const current = keywordsFor(value, stage);
    if (current.includes(kw) || current.length >= ROLE_MATCH_MAX_KEYWORDS) return;
    onChange({ ...value, [stage]: [...current, kw] });
    setDrafts((d) => ({ ...d, [stage]: '' }));
  };

  const removeKeyword = (stage: string, kw: string) => {
    onChange({ ...value, [stage]: keywordsFor(value, stage).filter((k) => k !== kw) });
  };

  const addStage = () => {
    const id = newStage.trim().toLowerCase();
    if (!STAGE_ID_RE.test(id)) return;
    if (Object.hasOwn(value, id) || Object.hasOwn(DEFAULT_ROLE_MATCH_KEYWORDS, id)) return;
    if (stageOrder(value).length >= ROLE_MATCH_MAX_STAGES) return;
    onChange({ ...value, [id]: [id] });
    setNewStage('');
  };

  const removeStage = (stage: string) => {
    if (Object.hasOwn(DEFAULT_ROLE_MATCH_KEYWORDS, stage)) return;
    const next = { ...value };
    delete next[stage];
    onChange(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {stageOrder(value).map((stage) => {
        const kws = keywordsFor(value, stage);
        const isBuiltin = Object.hasOwn(DEFAULT_ROLE_MATCH_KEYWORDS, stage);
        const draft = drafts[stage] ?? '';
        return (
          <div
            key={stage}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '10px 12px',
              background: 'var(--surface-2, rgba(255, 255, 255, 0.02))',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="modal-label" style={{ fontFamily: 'var(--mono, monospace)', fontSize: 11, letterSpacing: '0.06em' }}>
                  {stage}
                </span>
                {isBuiltin && (
                  <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 400, opacity: 0.8 }}>
                    (built-in)
                  </span>
                )}
              </div>
              {!isBuiltin && (
                <button
                  type="button"
                  className="modal-btn"
                  onClick={() => removeStage(stage)}
                  aria-label={`Remove stage ${stage}`}
                  title={`Remove stage ${stage}`}
                  style={{
                    color: 'var(--accent-danger, #ef4444)',
                    fontSize: 11,
                    padding: '2px 8px',
                    height: 'auto',
                    lineHeight: '18px',
                    borderColor: 'rgba(239, 68, 68, 0.3)',
                    background: 'rgba(239, 68, 68, 0.05)',
                  }}
                >
                  Remove stage
                </button>
              )}
            </div>
            <div className="modal-tag-chips" style={{ marginBottom: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              {kws.map((k) => (
                <span key={k} className="modal-tag-chip">
                  {k}
                  <button
                    type="button"
                    className="modal-tag-remove"
                    aria-label={`Remove keyword ${k}`}
                    onClick={() => removeKeyword(stage, k)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="text"
                  className="modal-input"
                  style={{ width: 140, height: 26, padding: '2px 8px', fontSize: 12 }}
                  placeholder="+ Add keyword"
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [stage]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      commitKeyword(stage, drafts[stage] ?? '');
                    }
                  }}
                  onBlur={() => commitKeyword(stage, drafts[stage] ?? '')}
                  aria-label={`Add keyword for ${stage}`}
                />
                {draft.trim().length > 0 && (
                  <button
                    type="button"
                    className="modal-btn"
                    style={{ fontSize: 11, padding: '2px 8px', height: 26, lineHeight: '20px' }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitKeyword(stage, drafts[stage] ?? '');
                    }}
                    aria-label={`Confirm add keyword for ${stage}`}
                  >
                    Add
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <input
          type="text"
          className="modal-input"
          style={{ width: 180, height: 28 }}
          placeholder="New stage (e.g. test)"
          value={newStage}
          onChange={(e) => setNewStage(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStage(); } }}
          aria-label="New stage id"
        />
        <button
          type="button"
          className="modal-btn"
          style={{ height: 28, padding: '0 12px' }}
          onClick={addStage}
          disabled={!newStage.trim()}
        >
          Add stage
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="modal-btn"
          style={{ height: 28, padding: '0 10px', color: 'var(--text-2)' }}
          onClick={() => onChange(structuredClone(DEFAULT_ROLE_MATCH_KEYWORDS))}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
