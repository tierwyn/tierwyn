import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Conversation, ConversationRulesResponse, Project, RulePreset } from '@tierwyn/shared';
import { api } from '../api.js';
import {
  RULES_MAX_BYTES,
  RULES_TOTAL_MAX_BYTES,
  RULE_PRESETS_MAX_PER_LAYER,
  livePreview,
  rulesByteLength,
  type RulesComposeLayer,
  RULE_PRESETS_CHANGED_EVENT,
  notifyRulePresetsChanged,
} from '../operatorRules.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Modal } from './Modal.js';
import { RulePresetEditorModal } from './RulePresetsSettings.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';

export type RulesTarget =
  | { kind: 'project'; project: Project }
  | { kind: 'conversation'; conversation: Conversation; project: Project };

interface Props {
  target: RulesTarget;
  onClose: () => void;
  onSaved: (updated: Project | Conversation) => void;
  onRulesSubmitted?: (updated: Project | Conversation) => void;
  prefill?: string;
}

export function RulesModal({ target, onClose, onSaved, onRulesSubmitted, prefill }: Props) {
  const isProject = target.kind === 'project';
  const projectId = isProject ? target.project.id : target.project.id;
  const baseText = isProject ? (target.project.rules ?? '') : (target.conversation.rules ?? '');
  const initialText = prefill
    ? (baseText.trim().length > 0 ? `${baseText.trimEnd()}\n${prefill}` : prefill)
    : baseText;
  const initialStack = isProject
    ? [...(target.project.rulePresetIds ?? [])]
    : [...(target.conversation.rulePresetIds ?? [])];

  const [text, setText] = useState(initialText);
  const [stack, setStack] = useState<string[]>(initialStack);
  const [presets, setPresets] = useState<RulePreset[]>([]);
  const [rulesDoc, setRulesDoc] = useState<ConversationRulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const [editor, setEditor] = useState<{ mode: 'new' } | { mode: 'edit'; preset: RulePreset } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RulePreset | null>(null);
  const bytes = rulesByteLength(text.trim());
  const over = bytes > RULES_MAX_BYTES;

  const reloadPresets = () => {
    void api.listRulePresets(projectId).then(setPresets).catch(() => { /* catalogue is best-effort */ });
  };

  useEffect(() => {
    reloadPresets();
    const handlePresetsChanged = () => {
      reloadPresets();
    };
    window.addEventListener(RULE_PRESETS_CHANGED_EVENT, handlePresetsChanged);
    return () => window.removeEventListener(RULE_PRESETS_CHANGED_EVENT, handlePresetsChanged);
  }, [projectId]);

  useEffect(() => {
    if (target.kind !== 'conversation') return;
    let cancelled = false;
    void api.getConversationRules(target.conversation.id).then((r) => {
      if (!cancelled) setRulesDoc(r);
    }).catch(() => { /* inherited panel is best-effort */ });
    return () => { cancelled = true; };
  }, [target]);

  const byId = useMemo(() => new Map(presets.map((p) => [p.id, p])), [presets]);

  const composePreset = (id: string) => {
    const p = byId.get(id);
    return {
      id,
      name: p?.name ?? 'unavailable',
      content: p?.content ?? '',
      available: !!p,
    };
  };

  const preview = useMemo(() => {
    const layers: RulesComposeLayer[] = [];
    if (!isProject && rulesDoc?.project) {
      layers.push({
        customLabel: 'Project',
        custom: rulesDoc.project.rules,
        presets: rulesDoc.project.presets.map((r) => {
          const p = byId.get(r.id);
          return { id: r.id, name: r.name, content: p?.content ?? '', available: r.available && !!p };
        }),
      });
      for (const c of rulesDoc.chain) {
        if (target.kind === 'conversation' && c.conversationId === target.conversation.id) continue;
        layers.push({
          customLabel: `Conversation: ${c.title}`,
          custom: c.rules,
          presets: c.presets.map((r) => {
            const p = byId.get(r.id);
            return { id: r.id, name: r.name, content: p?.content ?? '', available: r.available && !!p };
          }),
        });
      }
    }
    layers.push({
      customLabel: isProject ? 'Project' : `Conversation: ${target.kind === 'conversation' ? target.conversation.title : ''}`,
      custom: text,
      presets: stack.map(composePreset),
    });
    return livePreview(layers);
  }, [isProject, rulesDoc, stack, text, byId, target]);

  const addable = presets.filter((p) => !stack.includes(p.id));
  const globalAddable = addable.filter((p) => !p.projectId);
  const projectAddable = addable.filter((p) => p.projectId === projectId);

  const presetPlaceholder = stack.length >= RULE_PRESETS_MAX_PER_LAYER
    ? 'Maximum 8 presets'
    : addable.length === 0
      ? 'No more presets'
      : 'Add preset…';

  const presetOptions: SelectDropdownOption<string>[] = useMemo(() => [
    { value: '', label: presetPlaceholder },
    ...globalAddable.map((p) => ({
      value: p.id,
      label: p.name,
      description: p.description || undefined,
      badge: 'Global',
    })),
    ...projectAddable.map((p) => ({
      value: p.id,
      label: p.name,
      description: p.description || undefined,
      badge: 'Project',
    })),
  ], [presetPlaceholder, globalAddable, projectAddable]);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= stack.length) return;
    setStack((s) => {
      const next = [...s];
      const tmp = next[i]!;
      next[i] = next[j]!;
      next[j] = tmp;
      return next;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (over) return;
    setError(null);
    setSaving(true);
    try {
      const value = text.trim() ? text.trim() : null;
      const rulePresetIds = stack.length ? stack : null;
      if (isProject) {
        const updated = await api.updateProject(target.project.id, { rules: value, rulePresetIds });
        onRulesSubmitted?.(updated);
        onSaved(updated);
      } else {
        const updated = await api.updateConversation(target.conversation.id, { rules: value, rulePresetIds });
        onRulesSubmitted?.(updated);
        onSaved(updated);
      }
      onClose();
    } catch (err) {
      setError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const chipLit = stack.length > 0 || !!text.trim() || (!isProject && (
    !!(rulesDoc?.project?.rules?.trim())
    || (rulesDoc?.project?.presets.length ?? 0) > 0
    || (rulesDoc?.chain.some((c) => (target.kind === 'conversation' && c.conversationId !== target.conversation.id) && (!!c.rules?.trim() || c.presets.length > 0)) ?? false)
  ));

  return (
    <Modal
      title={isProject ? `Project rules — ${target.project.name}` : `Conversation rules — ${target.conversation.title}`}
      onClose={onClose}
      className="modal-content--roomy"
      footer={
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="modal-btn"
            onClick={() => { setText(''); setStack([]); }}
            disabled={!text && stack.length === 0}
          >Clear</button>
          <button
            type="submit"
            form="rules-form"
            className="modal-btn primary"
            disabled={saving || over}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <form id="rules-form" onSubmit={submit}>
        <div className="rules-badge-preview">
          <span className={`conversation-title-bar-rules${chipLit ? '' : ' rules-chip-off'}`}>Rules</span>
          <span className="modal-hint">{chipLit ? 'Chip lights when any custom rules or presets apply' : 'Chip is off — nothing applies yet'}</span>
        </div>

        {!isProject && rulesDoc && (
          <div className="rules-inherited">
            <div className="modal-label">Inherited (read-only)</div>
            {rulesDoc.project && (rulesDoc.project.rules?.trim() || rulesDoc.project.presets.length > 0) && (
              <div className="rules-inherited-block">
                <div className="rules-inherited-title">Project: {target.project.name}</div>
                {rulesDoc.project.presets.map((p) => (
                  <div key={p.id} className="modal-hint">{p.available ? p.name : `${p.name} (unavailable)`}</div>
                ))}
                {rulesDoc.project.rules?.trim() ? <pre className="rules-inherited-body">{rulesDoc.project.rules}</pre> : null}
              </div>
            )}
            {rulesDoc.chain.filter((c) => target.kind === 'conversation' && c.conversationId !== target.conversation.id).map((row) => (
              <div key={row.conversationId} className="rules-inherited-block">
                <div className="rules-inherited-title">{row.title}</div>
                {row.presets.map((p) => (
                  <div key={p.id} className="modal-hint">{p.available ? p.name : `${p.name} (unavailable)`}</div>
                ))}
                {row.rules?.trim() ? <pre className="rules-inherited-body">{row.rules}</pre> : null}
              </div>
            ))}
          </div>
        )}

        <div className="modal-field">
          <div className="modal-label">Presets</div>
          {stack.length === 0 && <div className="modal-hint">No presets on this layer. Add one, or write custom rules below.</div>}
          <ul className="rules-preset-stack">
            {stack.map((id, i) => {
              const p = byId.get(id);
              const unavailable = !p;
              return (
                <li key={id} className={`rules-preset-chip${unavailable ? ' rules-preset-unavailable' : ''}`}>
                  <span>{unavailable ? `${id.slice(0, 8)}… unavailable` : p.name}</span>
                  <button type="button" className="modal-btn rules-chip-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button type="button" className="modal-btn rules-chip-btn" onClick={() => move(i, 1)} disabled={i === stack.length - 1} aria-label="Move down">↓</button>
                  <button type="button" className="modal-btn rules-chip-btn" onClick={() => setStack((s) => s.filter((x) => x !== id))} aria-label="Remove">×</button>
                </li>
              );
            })}
          </ul>
          <div className="rules-preset-add">
            <SelectDropdown
              options={presetOptions}
              value=""
              disabled={stack.length >= RULE_PRESETS_MAX_PER_LAYER || addable.length === 0}
              searchable={addable.length > 5}
              onChange={(id) => {
                if (id) setStack((s) => s.includes(id) ? s : [...s, id]);
              }}
            />
            <button type="button" className="modal-btn" onClick={() => setManaging(true)}>Manage…</button>
          </div>
        </div>

        <div className="modal-field">
          <label className="modal-label" htmlFor="rules-text">
            {isProject ? 'Custom rules for every conversation in this project' : 'Custom rules for this conversation and its descendants'}
          </label>
          <textarea
            id="rules-text"
            className="modal-input rules-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            autoFocus
            spellCheck={false}
          />
          <div className={`modal-hint${over ? ' rules-over' : ''}`}>
            {bytes} / {RULES_MAX_BYTES} bytes
            {over ? ' — too long to save' : ''}
          </div>
        </div>

        <details className="rules-preview" open>
          <summary>Preview (stacked result)</summary>
          <div className={`modal-hint${preview.omitted ? ' rules-over' : ''}`}>
            {preview.bytes} / {RULES_TOTAL_MAX_BYTES} bytes total
            {preview.omitted ? ` — ${preview.omitted} earlier block(s) omitted` : ''}
          </div>
          <pre className="rules-preview-body">{preview.rendered.trim() || '(nothing will be injected)'}</pre>
        </details>

        <p className="modal-hint">
          Operator instructions, not reference notes. More specific (later) rules win on conflict; your current message wins over all rules. Agents cannot edit these.
        </p>
        {error && <div className="error">{error}</div>}
      </form>

      {managing && (
        <Modal title="Manage presets" onClose={() => setManaging(false)} overlayClassName="modal-overlay--stack-2">
          {presets.length === 0 && <p className="modal-hint">No presets yet. Create one instead of shipping defaults.</p>}
          <ul className="rules-preset-manage">
            {presets.map((p) => (
              <li key={p.id} className="rules-preset-manage-row">
                <div>
                  <strong>{p.name}</strong>
                  <div className="modal-hint">
                    {p.projectId ? 'This project' : 'Global'}
                    {p.usage ? ` · ${p.usage.projects} projects, ${p.usage.conversations} conversations` : ''}
                  </div>
                </div>
                <div>
                  <button type="button" className="modal-btn" onClick={() => setEditor({ mode: 'edit', preset: p })}>Edit</button>
                  <button type="button" className="modal-btn" onClick={() => setPendingDelete(p)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
          <div className="modal-footer">
            <button type="button" className="modal-btn" onClick={() => setManaging(false)}>Close</button>
            <button type="button" className="modal-btn primary" onClick={() => setEditor({ mode: 'new' })}>New preset</button>
          </div>
        </Modal>
      )}

      {editor && (
        <RulePresetEditorModal
          defaultProjectId={projectId}
          existing={editor.mode === 'edit' ? editor.preset : null}
          onClose={() => setEditor(null)}
          onSaved={(preset, meta) => {
            setPresets((list) => {
              const i = list.findIndex((x) => x.id === preset.id);
              if (i === -1) return [...list, preset].sort((a, b) => a.name.localeCompare(b.name));
              const next = [...list];
              next[i] = preset;
              return next;
            });
            setEditor(null);
            const mine = meta?.updatedProjects.find((p) => p.id === projectId);
            if (!mine) return;
            if (isProject) {
              const ids = mine.rulePresetIds ?? [];
              setStack((s) => {
                if (ids.includes(preset.id)) {
                  if (s.includes(preset.id) || s.length >= RULE_PRESETS_MAX_PER_LAYER) return s;
                  return [...s, preset.id];
                }
                return s.filter((id) => id !== preset.id);
              });
            }
            onSaved(mine);
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete preset"
          danger
          body={`Used by ${pendingDelete.usage?.projects ?? 0} projects, ${pendingDelete.usage?.conversations ?? 0} conversations — they will lose this preset.`}
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          overlayClassName="modal-overlay--stack-2"
          onConfirm={() => {
            const id = pendingDelete.id;
            void api.deleteRulePreset(id).then(() => {
              setPresets((list) => list.filter((p) => p.id !== id));
              setStack((s) => s.filter((x) => x !== id));
              setPendingDelete(null);
              notifyRulePresetsChanged();
            }).catch((err) => {
              setError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
              setPendingDelete(null);
            });
          }}
        />
      )}
    </Modal>
  );
}

