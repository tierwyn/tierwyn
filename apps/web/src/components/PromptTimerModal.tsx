import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentProfile, ConversationTimer, EffortLevel, HandoffOverride, PromptAttachment, PromptOptions,
} from '@tierwyn/shared';
import { DEFAULT_EFFORT, TIMER_MAX_PROMPT_CHARS, resolveEffortForModel } from '@tierwyn/shared';
import { Modal } from './Modal.js';
import { ModelSelector } from './ModelSelector.js';
import {
  TIMER_PRESET_MINUTES, TIMER_NUDGE_MINUTES, TIMER_DEFAULT_MINUTES,
  TIMER_MIN_MINUTES, TIMER_MAX_MINUTES,
  clampTimerMinutes, draftsFromTotal, totalFromDrafts, durationLabel,
  datetimeLocalToEpoch, epochToDatetimeLocal, fireAtLabel, optionChipLabels,
  timerOriginBadge,
} from '../promptTimer.js';
import { pickerEffortLevels } from '../effortLevels.js';

export interface PromptTimerSchedulePayload {
  prompt: string;
  when?: { fireInMs?: number; fireAtMs?: number };
  profileId: string;
  effort: EffortLevel | null;
  options: PromptOptions | null;
  attachments: PromptAttachment[];
  handoffOverride: HandoffOverride | null;
}

export interface PromptTimerModalProps {
  mode?: 'create' | 'edit';
  /** Required when mode === 'edit'. */
  initialTimer?: ConversationTimer;
  conversationTitle: string;
  /** Seed for the local prompt copy (composer text on create, timer prompt on edit). */
  prompt: string;
  profiles: AgentProfile[];
  profilesLoaded?: boolean;
  composerProfileId: string;
  composerEffort: EffortLevel | null;
  composerOptions: PromptOptions;
  /** Already converted by InputBar's `attachmentsForPersist`. */
  attachments: PromptAttachment[];
  lastSessionProfileId?: string;
  isRemoteAgents: boolean;
  onClose: () => void;
  onSchedule: (payload: PromptTimerSchedulePayload) => Promise<void>;
  overlayClassName?: string;
}

function presetShort(m: number): string {
  return m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}

export function PromptTimerModal({
  mode: modalMode = 'create',
  initialTimer,
  conversationTitle,
  prompt,
  profiles,
  profilesLoaded,
  composerProfileId,
  composerEffort,
  composerOptions,
  attachments,
  lastSessionProfileId,
  isRemoteAgents,
  onClose,
  onSchedule,
  overlayClassName,
}: PromptTimerModalProps) {
  const isEdit = modalMode === 'edit';
  const now = Date.now();
  const seedMinutes = isEdit && initialTimer
    ? clampTimerMinutes(Math.round((initialTimer.fireAtMs - now) / 60_000))
    : TIMER_DEFAULT_MINUTES;
  const [mode, setMode] = useState<'in' | 'at'>('in');
  const [minutes, setMinutes] = useState(seedMinutes);
  // Free-typing drafts: the H and MM boxes hold raw strings while focused and
  // only commit (clamp + carry) on blur / preset / nudge. Re-deriving them on
  // every keystroke makes "1" untypeable in the MM box.
  const [drafts, setDrafts] = useState(() => draftsFromTotal(seedMinutes));
  const [at, setAt] = useState(() => epochToDatetimeLocal(
    isEdit && initialTimer ? initialTimer.fireAtMs : now + 3_600_000,
  ));
  const [timeTouched, setTimeTouched] = useState(false);
  const [editPrompt, setEditPrompt] = useState(
    isEdit ? (initialTimer?.prompt ?? prompt) : prompt,
  );
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState('');
  const previewRef = useRef<HTMLButtonElement>(null);
  const wasPromptEditorOpen = useRef(false);
  const [timerProfileId, setTimerProfileId] = useState(composerProfileId);
  const [effort, setEffort] = useState<EffortLevel | null>(composerEffort);
  const [handoff, setHandoff] = useState<HandoffOverride>(
    (isEdit && initialTimer?.handoffOverride) || 'summary',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerProfile = useMemo(
    () => profiles.find((p) => p.id === timerProfileId),
    [profiles, timerProfileId],
  );
  const composerProfile = useMemo(
    () => profiles.find((p) => p.id === composerProfileId),
    [profiles, composerProfileId],
  );
  const effortChoices = useMemo(() => {
    const base = [...pickerEffortLevels(timerProfile)];
    // Edit: a stored level the picker hides (baked/rejecting models) must
    // remain visible and selectable, otherwise submit would send null.
    // Only while the operator is still on the timer's original profile —
    // switching model must not re-union a stale level onto a baked/rejecting
    // (or effort-less) target.
    const stored = isEdit && timerProfileId === initialTimer?.profileId
      ? initialTimer?.effort
      : null;
    if (stored && !base.includes(stored)) base.push(stored);
    return base;
  }, [timerProfile, isEdit, timerProfileId, initialTimer?.profileId, initialTimer?.effort]);
  // Options are adapter-shaped. Carrying claude-code flags onto a codex timer
  // would fail sanitisePromptOptions server-side, so drop them on a type switch.
  const sameAgentType = !!timerProfile && !!composerProfile
    && timerProfile.agentType === composerProfile.agentType;
  const options = sameAgentType && Object.keys(composerOptions).length > 0 ? composerOptions : null;
  const lastSessionProfile = useMemo(
    () => profiles.find((p) => p.id === lastSessionProfileId),
    [profiles, lastSessionProfileId],
  );
  // Cross-agent switch only: a same-agent model change keeps native resume.
  const showHandoff = !isRemoteAgents && !!lastSessionProfile && !!timerProfile
    && timerProfile.agentType !== lastSessionProfile.agentType;
  const inMinutes = totalFromDrafts(drafts.hours, drafts.minutes);
  const fireAtMs = mode === 'in' ? now + inMinutes * 60_000 : datetimeLocalToEpoch(at);
  const livePrompt = editPrompt;
  const skipTimeWindow = isEdit && !timeTouched;

  const invalid =
    !livePrompt.trim() ? 'Prompt cannot be empty'
    : livePrompt.length > TIMER_MAX_PROMPT_CHARS ? 'Prompt is too long'
    : !timerProfileId ? 'Pick a model'
    : !timerProfile && !profilesLoaded ? 'Loading models…'
    : skipTimeWindow ? null
    : fireAtMs === null ? 'Pick a valid date and time'
    : fireAtMs - now < TIMER_MIN_MINUTES * 60_000 ? 'Must be at least 1 minute from now'
    : fireAtMs - now > TIMER_MAX_MINUTES * 60_000 ? 'Must be within 7 days'
    : null;

  const attachmentLabels: string[] = isEdit && initialTimer
    ? initialTimer.attachmentNames
    : attachments.map((a, i) => a.name ?? `attachment ${i + 1}`);

  const commitDrafts = () => {
    const total = totalFromDrafts(drafts.hours, drafts.minutes);
    setMinutes(total);
    setDrafts(draftsFromTotal(total));
  };
  const setTotal = (total: number) => {
    setTimeTouched(true);
    const t = clampTimerMinutes(total);
    setMinutes(t);
    setDrafts(draftsFromTotal(t));
  };
  const switchTab = (next: 'in' | 'at') => {
    setTimeTouched(true);
    setMode(next);
  };
  const handleTimerProfileChange = (id: string) => {
    setTimerProfileId(id);
    if (!isEdit || id === timerProfileId) return;
    if (id === initialTimer?.profileId) {
      setEffort(initialTimer.effort);
      return;
    }
    const next = profiles.find((p) => p.id === id);
    setEffort(resolveEffortForModel(next?.agentType, next?.model, DEFAULT_EFFORT) ?? null);
  };

  const openPromptEditor = () => {
    setDraftPrompt(editPrompt);
    setPromptEditorOpen(true);
  };
  const commitPromptEditor = () => {
    setEditPrompt(draftPrompt);
    setPromptEditorOpen(false);
  };
  const cancelPromptEditor = () => setPromptEditorOpen(false);

  // Top stacked modal must eat Escape so the timer modal underneath stays open.
  useEffect(() => {
    if (!promptEditorOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (e.isComposing) return;
      setPromptEditorOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [promptEditorOpen]);

  // Restore focus to the preview on every editor exit (Done / Cancel / Escape /
  // overlay). Skip the initial mount so the timer modal does not steal focus.
  useEffect(() => {
    if (promptEditorOpen) {
      wasPromptEditorOpen.current = true;
      return;
    }
    if (!wasPromptEditorOpen.current) return;
    wasPromptEditorOpen.current = false;
    previewRef.current?.focus();
  }, [promptEditorOpen]);

  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true); setError(null);
    try {
      const committed = mode === 'in' ? totalFromDrafts(drafts.hours, drafts.minutes) : minutes;
      await onSchedule({
        prompt: livePrompt,
        ...((!isEdit || timeTouched)
          ? { when: mode === 'in' ? { fireInMs: committed * 60_000 } : { fireAtMs: fireAtMs! } }
          : {}),
        profileId: timerProfileId,
        effort: effortChoices.includes(effort as EffortLevel) ? effort : null,
        options,
        attachments,
        handoffOverride: showHandoff ? handoff : null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const fromLabel = profiles.find((p) => p.id === lastSessionProfileId)?.label ?? lastSessionProfileId;
  const optionChips = optionChipLabels(timerProfile?.agentType, options);
  const chips = (attachmentLabels.length > 0 || optionChips.length > 0) ? (
    <div className="prompt-timer-chips">
      {attachmentLabels.map((name, i) => (
        <span key={`att-${i}`} className="prompt-timer-chip">📎 {name}</span>
      ))}
      {optionChips.map((label) => (
        <span key={label} className="prompt-timer-chip">{label}</span>
      ))}
    </div>
  ) : null;

  return (
    <>
    <Modal title={isEdit ? 'Edit timer' : 'Prompt timer'} onClose={onClose} className="prompt-timer-modal" overlayClassName={overlayClassName}>
      <div className="prompt-timer-hint">
        Sends this prompt into <strong>{conversationTitle || 'this conversation'}</strong> as if
        typed. It is not a scheduled job.
      </div>
      {isEdit && initialTimer?.origin && initialTimer.origin !== 'operator' ? (() => {
        const badge = timerOriginBadge(initialTimer.origin);
        return badge ? (
          <div className="prompt-timer-hint">
            <span className="timer-chip-origin" title={badge.title}>{badge.label}</span>{' '}
            {badge.title} — not composer-scheduled.
          </div>
        ) : null;
      })() : null}

      <div className="prompt-timer-prompt-block">
        <button
          ref={previewRef}
          type="button"
          className="prompt-timer-prompt-preview"
          onClick={openPromptEditor}
          title="Edit prompt"
          aria-label={`Edit prompt: ${livePrompt.trim() || 'empty'}`}
        >
          {livePrompt.trim() || '(empty)'}
        </button>
        {chips}
        <div className="prompt-timer-hint">Tap to edit the prompt.</div>
      </div>

      <div className="prompt-timer-tabs">
        <button
          type="button"
          className={`modal-btn${mode === 'in' ? ' primary' : ''}`}
          onClick={() => switchTab('in')}
        >
          In…
        </button>
        <button
          type="button"
          className={`modal-btn${mode === 'at' ? ' primary' : ''}`}
          onClick={() => switchTab('at')}
        >
          At…
        </button>
      </div>

      {mode === 'in' ? (
        <>
          <div className="prompt-timer-presets">
            {TIMER_PRESET_MINUTES.map((m) => (
              <button
                key={m}
                type="button"
                className={`prompt-timer-preset${m === inMinutes ? ' on' : ''}`}
                onClick={() => setTotal(m)}
              >
                {presetShort(m)}
              </button>
            ))}
          </div>
          <div className="prompt-timer-clock">
            <input
              inputMode="numeric"
              value={drafts.hours}
              aria-label="Hours"
              onChange={(e) => {
                setTimeTouched(true);
                setDrafts({ ...drafts, hours: e.target.value });
              }}
              onBlur={commitDrafts}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitDrafts();
                  void submit();
                }
              }}
            />
            <span className="prompt-timer-colon">:</span>
            <input
              inputMode="numeric"
              value={drafts.minutes}
              aria-label="Minutes"
              onChange={(e) => {
                setTimeTouched(true);
                setDrafts({ ...drafts, minutes: e.target.value });
              }}
              onBlur={commitDrafts}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitDrafts();
                  void submit();
                }
              }}
            />
          </div>
          <div className="prompt-timer-nudges">
            {TIMER_NUDGE_MINUTES.map((n) => (
              <button
                key={`minus-${n}`}
                type="button"
                className="prompt-timer-nudge"
                onClick={() => setTotal(inMinutes - n)}
              >
                −{durationLabel(n)}
              </button>
            ))}
            {TIMER_NUDGE_MINUTES.map((n) => (
              <button
                key={`plus-${n}`}
                type="button"
                className="prompt-timer-nudge"
                onClick={() => setTotal(inMinutes + n)}
              >
                +{durationLabel(n)}
              </button>
            ))}
          </div>
        </>
      ) : (
        // ponytail: native datetime-local — browser-local zone, no picker dependency.
        <input
          type="datetime-local"
          className="modal-input"
          value={at}
          onChange={(e) => {
            setTimeTouched(true);
            setAt(e.target.value);
          }}
        />
      )}

      <div className="prompt-timer-preview">
        {invalid ?? (isEdit && !timeTouched && initialTimer
          ? `Fires ${fireAtLabel(initialTimer.fireAtMs)} (unchanged)`
          : fireAtMs !== null
            ? `${mode === 'in' ? `In ${durationLabel(inMinutes)}` : 'At a specific time'} · Fires ${fireAtLabel(fireAtMs)}`
            : '')}
      </div>

      <div className="prompt-timer-route">
        <div className="prompt-timer-label">Send as</div>
        <ModelSelector
          profiles={profiles}
          profilesLoaded={profilesLoaded}
          selectedProfileId={timerProfileId}
          onChange={handleTimerProfileChange}
          placement="top"
          disabled={isRemoteAgents}
        />
        {effortChoices.length > 0 && (
          <>
            <button
              type="button"
              className={`prompt-timer-pill${effort === null ? ' on' : ''}`}
              onClick={() => setEffort(null)}
            >
              Off
            </button>
            {effortChoices.map((level) => (
              <button
                key={level}
                type="button"
                className={`prompt-timer-pill${effort === level ? ' on' : ''}`}
                onClick={() => setEffort(level)}
              >
                {level}
              </button>
            ))}
          </>
        )}
      </div>

      {showHandoff && (
        <div className="prompt-timer-handoff">
          <div className="prompt-timer-label">
            This conversation last ran as {fromLabel}; hand off with:
          </div>
          <button
            type="button"
            className={`prompt-timer-hcard${handoff === 'summary' ? ' on' : ''}`}
            onClick={() => setHandoff('summary')}
          >
            Summarize
          </button>
          <button
            type="button"
            className={`prompt-timer-hcard${handoff === 'transcript' ? ' on' : ''}`}
            onClick={() => setHandoff('transcript')}
          >
            Full transcript
          </button>
        </div>
      )}

      {error && <div className="prompt-timer-error">{error}</div>}

      <div className="modal-footer">
        {!isEdit && (
          <button
            type="button"
            className="modal-btn"
            style={{ marginRight: 'auto' }}
            onClick={onClose}
          >
            Back to composer
          </button>
        )}
        <button type="button" className="modal-btn" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="modal-btn primary"
          disabled={!!invalid || busy}
          onClick={() => void submit()}
        >
          {busy ? (isEdit ? 'Saving…' : 'Setting…') : (isEdit ? 'Save changes' : 'Set timer')}
        </button>
      </div>
    </Modal>
    {promptEditorOpen && (
      <Modal
        title="Edit prompt"
        onClose={cancelPromptEditor}
        overlayClassName={overlayClassName === 'modal-overlay--stack-2' ? 'modal-overlay--stack-3' : 'modal-overlay--stack-2'}
      >
        <textarea
          className="modal-input prompt-timer-textarea"
          value={draftPrompt}
          maxLength={TIMER_MAX_PROMPT_CHARS}
          autoFocus
          onChange={(e) => setDraftPrompt(e.target.value)}
        />
        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={cancelPromptEditor}>Cancel</button>
          <button type="button" className="modal-btn primary" onClick={commitPromptEditor}>Done</button>
        </div>
      </Modal>
    )}
    </>
  );
}
