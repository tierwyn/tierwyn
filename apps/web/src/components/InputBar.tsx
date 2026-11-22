import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import type { AgentProfile, CommandRecord, ConversationTimer, DraftProcessing, DraftUpdatedFrame, EffortLevel, EffortPreference, EnhanceMode, HandoffOverride, InteractionMode, PromptAttachment, PutDraftRequest, QueuedMessage, PromptOptionDescriptor, PromptOptions, SandboxSetting } from '@tierwyn/shared';
import { agentSupportsSlashCommands, isImageExtension, profileAcceptsImages, steerClass, REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { resolveConversationProfile } from '../remoteAgentsProfile.js';
import type { SandboxControlState } from '../sandboxControl.js';
import { ModelSelector } from './ModelSelector.js';
import { EffortPill, type EffortSessionState } from './EffortPill.js';
import { PermissionModePill } from './PermissionModePill.js';
import { SandboxPill } from './SandboxPill.js';
import { PromptOptionsBadge } from './PromptOptionsBadge.js';
import { PromptOptionsModal } from './PromptOptionsModal.js';
import { PermissionModeModal } from './PermissionModeModal.js';
import { McpStatusChip } from './McpStatusChip.js';
import { CommandPicker, type CommandPickerHandle } from './CommandPicker.js';
import { ShellCommandPicker, type ShellPickerHandle, type ShellRule } from './ShellCommandPicker.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SteerChoiceModal } from './SteerChoiceModal.js';
import { api, apiBase, fileUrl } from '../api.js';
import { useSpeechInput } from '../useSpeechInput.js';
import { useWhisperInput } from '../useWhisperInput.js';
import { getSttEngine, getWaveStyle, getVoiceDetectionVisual, getVoiceProcessingVisual, getSlowEnhanceChoice, setDictationMode, setSlowEnhanceChoice, type DictationMode, type VoiceDetectionVisual, type VoiceProcessingVisual, type WaveStyle } from '../voiceSettings.js';
import { slowEnhanceToggleOpts, type SlowEnhanceChoice } from '../dictationEnhance.js';
import { DictationModeStrip } from './DictationModeStrip.js';
import { DictationEnhanceModal } from './DictationEnhanceModal.js';
import { EnhanceModePopup } from './EnhanceModePopup.js';
import { ImageAnnotator } from './ImageAnnotator.js';
import { PromptCollectionModal } from './PromptCollectionModal.js';
import { SavePromptModal } from './SavePromptModal.js';
import { PromptTimerModal, type PromptTimerSchedulePayload } from './PromptTimerModal.js';
import { countdownLabel, timerOriginBadge } from '../promptTimer.js';
import { composeInsert } from '../promptInsert.js';
import { TextPathStrip } from './TextPathStrip.js';
import { VoiceFeedbackVisual } from './VoiceFeedbackVisual.js';
import { shouldDropDraftFrame, isClearedDraftFrame, remainingProcessingMs, shouldForwardProfile, shouldProtectLocalDraftFromClear, shouldIgnoreStaleDraftText, shouldApplyRemoteDraftText, focusedComposerIsIdle } from '../draftLock.js';
import { voiceStripState } from '../voiceStripState.js';
import { sniffAttachmentMediaType } from '../sniffAttachmentMediaType.js';
import { lsGet, lsSet, lsRemove } from '../prefixedStorage.js';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};

const draftKey = (cid: string) => `tierwyn.draft.${cid}`;
/** Debounce for draft persistence (localStorage mirror + server PUT). The
 *  mirror is written when the timer fires, not per keystroke — setItem is
 *  synchronous main-thread I/O and a long typing burst stuttered the composer.
 *  1.2s keeps peer-device draft sync snappy; blur, conversation-switch and
 *  pagehide flushes keep the mirror fresh. */
const DRAFT_SAVE_DEBOUNCE_MS = 1200;
function readLocalDraft(cid: string): string {
  try { return lsGet(draftKey(cid)) ?? ''; } catch { return ''; }
}
function writeLocalDraft(cid: string, text: string): void {
  try { text ? lsSet(draftKey(cid), text) : lsRemove(draftKey(cid)); } catch { /* private mode / quota */ }
}

/** Only base64-backed attachments persist cross-device; localPath-only stays in-memory. */
function attachmentsForPersist(atts: DraftAttachment[]): PromptAttachment[] {
  return atts
    .filter((a) => a.base64)
    .map(({ base64, mediaType, name }) => ({ base64, mediaType, name }));
}

function restoredAttachments(atts: PromptAttachment[]): DraftAttachment[] {
  return atts.map((a) => ({ base64: a.base64, mediaType: a.mediaType, name: a.name ?? 'attachment' }));
}

type DraftAttachment = {
  base64: string;
  mediaType: string;
  name: string;
  /** Pasted local path — preview via /files; base64 resolved at send time. */
  localPath?: string;
};

function normalizePastedPath(raw: string): string {
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (!p.startsWith('file://')) return p;
  try { p = decodeURIComponent(p); } catch { /* keep */ }
  p = p.slice('file://'.length);
  if (p.startsWith('localhost/')) p = p.slice('localhost'.length);
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

/** Prefer full paths over bare filenames; Linux copies vary by source app. */
function pathCandidateRank(candidate: string): number {
  const t = candidate.trim();
  if (t.startsWith('file://') || t.startsWith('/') || t.startsWith('~/')) return 0;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return 1;
  return 2;
}

/**
 * Checks whether a trimmed string looks like an explicit image file path.
 * Must start with an explicit path prefix (file://, /, ~/, ./, ../, or Windows drive letter)
 * and have a recognized image extension.
 * Rejects bare filenames (e.g. "start_frame.jpg") and prose text to prevent hijacking
 * regular text pastes that mention image files.
 */
export function isExplicitImagePath(raw: string): boolean {
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (!p) return false;

  // Reject strings with newlines
  if (/[\r\n]/.test(p)) return false;

  // Must have an explicit path prefix: file://, /, ~/, ./, ../, or Windows drive letter
  const isExplicitPath = (
    p.startsWith('file://') ||
    p.startsWith('/') ||
    p.startsWith('~/') ||
    p.startsWith('./') ||
    p.startsWith('../') ||
    /^[a-zA-Z]:[\\/]/.test(p)
  );
  if (!isExplicitPath) return false;

  // Reject code comments or flags (e.g. "// comment")
  if (p.startsWith('//') && !p.startsWith('///')) return false;

  // Extract clean path (strip query params / hash / file:// scheme for extension checking)
  let clean = p;
  if (clean.startsWith('file://')) {
    clean = clean.slice('file://'.length);
    if (clean.startsWith('localhost/')) clean = clean.slice('localhost'.length);
  }
  clean = clean.split(/[?#]/)[0] ?? '';

  const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const filename = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
  if (!filename || !filename.includes('.')) return false;

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return isImageExtension(ext);
}

export function imagePathCandidatesFromClipboard(cd: DataTransfer): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const addCandidate = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const path = normalizePastedPath(trimmed);
    if (seen.has(path)) return;
    seen.add(path);
    out.push(trimmed);
  };

  // 1. Structured sources from desktop file managers (GNOME Files, KDE Dolphin, etc.)
  const structuredMimes = [
    'text/uri-list',
    'x-special/gnome-copied-files',
    'text/x-kde-copied-files',
    'application/x-kde-copied-files',
  ];

  let hasStructuredData = false;
  for (const mime of structuredMimes) {
    const data = cd.getData(mime);
    if (!data) continue;
    hasStructuredData = true;
    for (const line of data.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t === 'copy') continue;
      const path = normalizePastedPath(t);
      const name = (path.split(/[\\/]/).pop() ?? '').split(/[?#]/)[0] ?? '';
      const ext = name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '';
      if (isImageExtension(ext)) {
        addCandidate(t);
      }
    }
  }

  // If structured file-manager data was present, do not inspect text/plain as fallback candidates.
  if (hasStructuredData) {
    return out.sort((a, b) => pathCandidateRank(a) - pathCandidateRank(b));
  }

  // 2. Plain text: only treat as image path candidates if the plain text strictly represents
  // image path(s) (e.g. copied "Copy Path" in terminal or file dialog).
  // NEVER extract image filenames out of arbitrary prose or code snippets!
  const plain = cd.getData('text/plain');
  if (!plain) return out;

  const lines = plain.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return out;

  // Every non-empty line must be an explicit image path. If any line is prose/code/non-image,
  // the paste is treated as normal text and must NOT be intercepted.
  const allAreImagePaths = lines.every(line => isExplicitImagePath(line));
  if (!allAreImagePaths) {
    return out;
  }

  for (const line of lines) {
    addCandidate(line);
  }

  return out.sort((a, b) => pathCandidateRank(a) - pathCandidateRank(b));
}

function imageMediaTypeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME[ext] ?? 'image/png';
}

function attachmentPreviewSrc(a: DraftAttachment, conversationId?: string): string {
  if (a.localPath) return fileUrl(a.localPath, conversationId);
  return `data:${a.mediaType};base64,${a.base64}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

async function resolveAttachmentsForSend(
  attachments: DraftAttachment[],
  conversationId?: string,
): Promise<{ base64: string; mediaType: string; name: string }[]> {
  return Promise.all(attachments.map(async (a) => {
    if (!a.localPath) {
      return { base64: a.base64, mediaType: a.mediaType, name: a.name };
    }
    const r = await fetch(fileUrl(a.localPath, conversationId), { credentials: 'include' });
    if (!r.ok) throw new Error(`Could not load ${a.name}`);
    const blob = await r.blob();
    const base64 = await blobToBase64(blob);
    if (!base64) throw new Error(`Could not read ${a.name}`);
    return { base64, mediaType: blob.type || a.mediaType, name: a.name };
  }));
}

interface Props {
  profiles: AgentProfile[];
  profilesLoaded?: boolean;
  unavailable?: Record<string, string>;
  selectedProfileId: string;
  onProfileChange: (profileId: string, opts?: { persist?: boolean }) => void;
  onSend: (
    text: string,
    profileId: string,
    agent: string,
    model: string,
    attachments: { base64: string; mediaType: string; name?: string }[],
    handoffOverride?: HandoffOverride,
  ) => boolean | void;
  disabled?: boolean;
  /** True while the conversation's agent is actively working. The input stays
   *  enabled; Enter/Send routes to onSteer instead of onSend. */
  isRunning?: boolean;
  /** Called instead of onSend while isRunning — sends an additional message into
   *  the live turn (inject or queue, decided server-side). `intent` selects
   *  auto / queue / force (Interrupt & Send). Optional commandName/args mark a
   *  structured slash so drain uses handleCommand. */
  onSteer?: (
    text: string,
    attachments: { base64: string; mediaType: string; name?: string }[],
    intent?: 'auto' | 'queue' | 'force',
    command?: { name: string; args?: string },
    handoffOverride?: HandoffOverride,
  ) => boolean | void;
  /** Number of messages already queued behind the running turn (for the button label). */
  steerQueueLength?: number;
  steerQueue?: QueuedMessage[];
  onCancelSteer?: (messageId: string) => void;
  /** Replace a queued message in place (same position / id). */
  onEditSteer?: (
    messageId: string,
    text: string,
    attachments: { base64: string; mediaType: string; name?: string }[],
    command?: { name: string; args?: string },
  ) => void;
  onStop?: () => void;
  stopDisabled?: boolean;
  showStop?: boolean;
  /** Teardown window: live map cleared but transcript still streams and the
   *  session is addressable — renders a dimmed force-stop. */
  wrappingUp?: boolean;
  /** Conversation ID — used to resolve local file paths into annotatable URLs. */
  conversationId?: string;
  /** Project ID — drives the !-shell allow-list fetch for ShellCommandPicker. */
  projectId?: string;
  /** Skip draft load/save/beacon for Schedules tree roots (kind === 'schedule_home'). */
  isScheduleHome?: boolean;
  /** Open the btw side-question drawer (via the + menu item). */
  onBtw?: () => void;
  /** When set, the Side Question menu item stays visible but is disabled. */
  btwDisabledReason?: string;
  /** Dispatch a /btw side question directly. Required so `/btw …` typed while a
   *  turn is running is intercepted as a side question, NOT routed through
   *  onSteer (which would steer the live agent). */
  onBtwQuestion?: (question: string) => void;
  /** Open a file preview modal for a path detected in the draft text. */
  onOpenFile?: (path: string) => void;
  /** Stored effort preference (global) — a level or 'off' (omit flag). Effective level is derived client-side. */
  effort?: EffortPreference;
  /** Effective (clamped) effort for the active adapter; undefined when 'off' is stored. */
  effectiveEffort?: EffortLevel;
  /** Allowed levels for the active adapter; empty → pill not rendered (D8). */
  effortLevels?: readonly EffortLevel[];
  /** B3: active vs next-session vs immediate (spawn-per-turn / no live session). */
  effortSessionState?: EffortSessionState;
  onEffortChange?: (level: EffortPreference) => void;
  /** Sticky per-conversation permission mode (WP-2.1). */
  permissionMode?: InteractionMode | null;
  /** Global default mode from compaction settings (default 'bypass'). */
  permissionDefaultMode?: InteractionMode;
  /** Whether the selected agent supports interactive permissions. */
  permissionCapable?: boolean;
  /** Change callback for the permission mode pill. */
  onPermissionModeChange?: (mode: InteractionMode | null) => void;
  /** Sticky per-conversation sandbox override (raw; null = inherit). */
  sandbox?: SandboxSetting | null;
  /** Resolved sandbox control state from sandboxControlState(); null hides the pill. */
  sandboxState?: SandboxControlState | null;
  onSandboxChange?: (v: SandboxSetting | null) => void;
  /** Spawn-template role names for prompt-collection roster pickers. */
  roles?: string[];
  /** Title of the current conversation, used to derive bot name for remote agent badge. */
  conversationTitle?: string;
  /** Whether the sidebar drawer is open (mobile or collapsed peek) — clicking the prompt closes it */
  isSidebarOpen?: boolean;
  onCloseSidebar?: () => void;
  /** Descriptors for the selected adapter. Empty ⇒ render no trigger at all. */
  promptOptionDescriptors?: readonly PromptOptionDescriptor[];
  /** Currently staged values (already sanitised). */
  promptOptions?: PromptOptions;
  /** Number of staged options — the badge renders iff > 0. */
  promptOptionCount?: number;
  promptOptionsError?: string | null;
  /** Whether the staged bag is sticky for this conversation/agent. */
  promptOptionsSticky?: boolean;
  onPromptOptionsApply?: (options: PromptOptions, sticky: boolean) => void;
  onPromptOptionsClear?: () => void;
  /** Profile the conversation last actually ran as — drives the handoff cards. */
  lastSessionProfileId?: string;
  /** Operator-staged `+` menu action, applied (and cleared by the parent) on the next send. */
  pendingSessionAction?: 'fresh' | 'summary' | null;
  onSessionActionChange?: (a: 'fresh' | 'summary' | null) => void;
  /** No prior turn / Remote Agents / bare-prompt adapter: there is nothing to reset or hand over. */
  sessionActionsDisabled?: boolean;
  grokBotBanner?: { text: string; severity: 'info' | 'warn' | 'error' | 'muted'; action: 'start' | 'retry' | null; spinner: boolean } | null;
  onGrokBotAction?: () => void;
  grokBotInputDisabled?: boolean;
  liveAgentType?: string;
  hasLiveSession?: boolean;
  onMcpServersChange?: (mcpServers: string[] | null) => void;
  /** Open operator rules modal for the active conversation/project. */
  onOpenRules?: () => void;
}

/** Imperative handle so the parent can push text into the draft (e.g. "repeat
 *  question", shell "Send to agent") without owning the draft state — keeping
 *  every keystroke local to InputBar so typing never re-renders the conversation.
 *  setText always goes through commitText: local state + localStorage mirror +
 *  debounced server draft (so another browser sees it like a typed prompt). */
export interface InputBarHandle {
  /** Push text into the draft. Pass `attachments` (including `[]`) to replace
   *  the composer thumbs — used by Repeat/Re-run so images and other files
   *  come back with the question. Omit `attachments` to leave whatever is
   *  already attached. */
  setText: (text: string, attachments?: PromptAttachment[]) => void;
  /** Clear composer + server draft after a send that was stashed (handoff modal confirm). */
  clearAfterSend: () => void;
  addAttachment: (att: { base64: string; mediaType: string; name?: string; localPath?: string }) => void;
  /** Apply a draft_updated frame. Processing/canUndo always apply; text is
   *  skipped while the local textarea is focused unless this is a busy→idle settle. */
  applyRemoteDraft: (frame: DraftUpdatedFrame) => void;
}

export const InputBar = forwardRef<InputBarHandle, Props>(function InputBar({ profiles, profilesLoaded = false, unavailable, selectedProfileId, onProfileChange, onSend, disabled, isRunning, onSteer, onEditSteer, steerQueueLength = 0, steerQueue = [], onCancelSteer, onStop, stopDisabled, showStop, wrappingUp = false, conversationId, projectId, isScheduleHome = false, onBtw, btwDisabledReason, onBtwQuestion, onOpenFile, effort, effectiveEffort, effortLevels = [], effortSessionState = 'immediate', onEffortChange, permissionMode, permissionDefaultMode = 'bypass', permissionCapable = true, onPermissionModeChange, sandbox, sandboxState, onSandboxChange, roles, conversationTitle, isSidebarOpen = false, onCloseSidebar, promptOptionDescriptors = [], promptOptions = {}, promptOptionCount = 0, promptOptionsError = null, promptOptionsSticky = false, onPromptOptionsApply, onPromptOptionsClear, lastSessionProfileId, pendingSessionAction = null, onSessionActionChange, sessionActionsDisabled = false, grokBotBanner, onGrokBotAction, grokBotInputDisabled = false, liveAgentType, hasLiveSession, onMcpServersChange, onOpenRules }, ref) {
  const isRemoteAgents = projectId === REMOTE_AGENTS_PROJECT_ID;
  const isRemoteAgentsRef = useRef(isRemoteAgents);
  isRemoteAgentsRef.current = isRemoteAgents;
  const [text, setText] = useState('');
  const [steerChoiceOpen, setSteerChoiceOpen] = useState(false);
  const [promptOptionsModalOpen, setPromptOptionsModalOpen] = useState(false);
  const [permissionModeModalOpen, setPermissionModeModalOpen] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const preEditRef = useRef<{ text: string; attachments: DraftAttachment[] } | null>(null);
  const [pendingSteer, setPendingSteer] = useState<{
    text: string;
    attachments: { base64: string; mediaType: string; name?: string }[];
    command?: { name: string; args?: string };
  } | null>(null);
  const addAttachment = useCallback((att: { base64: string; mediaType: string; name?: string; localPath?: string }) => {
    setAttachments(prev => {
      // Dedupe by localPath (paste path) or base64 (native paste / file picker)
      // so a double-fire of handlePaste can't badge the same file twice.
      const name = att.name ?? 'image.png';
      if (prev.some(a => (att.localPath ? a.localPath === att.localPath : a.base64 === att.base64))) {
        return prev;
      }
      return [...prev, { base64: att.base64, mediaType: att.mediaType, name, localPath: att.localPath }];
    });
  }, []);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [draftSaveWarning, setDraftSaveWarning] = useState<string | null>(null);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const [enhanceConfigured, setEnhanceConfigured] = useState(false);
  const [enhanceProject, setEnhanceProject] = useState<{ configured: boolean; reason?: string }>({ configured: false });
  const [enhancePopupOpen, setEnhancePopupOpen] = useState(false);
  const [remoteProcessing, setRemoteProcessing] = useState<DraftProcessing>('idle');
  // Epoch ms the current server job started; null when idle. Only used to bound
  // how long this device will believe a 'transcribing' lock (see the TTL effect).
  const [remoteStartedAt, setRemoteStartedAt] = useState<number | null>(null);
  /** True while the server has a pre-enhance snapshot (undo available on any device). */
  const [canUndoEnhance, setCanUndoEnhance] = useState(false);
  // ponytail: index of attachment currently being annotated; null = modal closed
  const [annotateIdx, setAnnotateIdx] = useState<number | null>(null);
  // ponytail: URL modal open state; replaces window.prompt for attach-via-URL
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [promptCollectionOpen, setPromptCollectionOpen] = useState(false);
  const [savePromptModalOpen, setSavePromptModalOpen] = useState(false);
  const [timerModalOpen, setTimerModalOpen] = useState(false);
  const [editingTimer, setEditingTimer] = useState<ConversationTimer | null>(null);
  const [deletingTimer, setDeletingTimer] = useState<ConversationTimer | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [pendingTimers, setPendingTimers] = useState<ConversationTimer[]>([]);
  /** Local clock for chip countdown text. Ticked once a second while chips
   *  are visible — there is no timer WS frame (vite.config.ts / ws.ts frozen). */
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [alertModal, setAlertModal] = useState<string | null>(null);
  const [commands, setCommands] = useState<CommandRecord[]>([]);
  const [shellAllow, setShellAllow] = useState<ShellRule[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dictationPopupOpen, setDictationPopupOpen] = useState(false);
  const [enhanceChoiceOpen, setEnhanceChoiceOpen] = useState(false);
  const [composerExtra, setComposerExtra] = useState(0);
  const [resizeDragging, setResizeDragging] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const resizeDragRef = useRef<{ y: number; extra: number } | null>(null);
  const mobileOverlayRef = useRef<HTMLDivElement>(null);
  const mobileSheetRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // ponytail: second input for "any file" (no accept filter); images go through fileInputRef
  const anyFileInputRef = useRef<HTMLInputElement>(null);
  const commandPickerRef = useRef<CommandPickerHandle>(null);
  const shellPickerRef = useRef<ShellPickerHandle>(null);
  const desktopTextareaRef = useRef<HTMLTextAreaElement>(null);
  const mobileTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Alias: existing focus/autosize code uses textareaRef for the desktop field.
  const textareaRef = desktopTextareaRef;
  const desktopMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const [mobileMenuMaxHeight, setMobileMenuMaxHeight] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef(0);
  // Queued save carrying its own snapshot. cid+text+epoch are captured at
  // schedule/flush time, so a conversation switch between queue and drain can
  // never PUT the NEW conversation's text into the OLD conversation's row.
  const persistQueuedRef = useRef<{ cid: string; text: string; attachments: PromptAttachment[]; epoch: number } | null>(null);
  // cid the pending debounce timer is bound to — the switch-flush reads it.
  const pendingSaveCidRef = useRef<string | null>(null);
  // Bumped on intentional clear so in-flight putDraft finally-handlers and
  // late draft_updated echoes cannot resurrect the sent prompt.
  const saveEpochRef = useRef(0);
  const discardRemoteTextRef = useRef(false);
  const lastLocalEditAtRef = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const remoteProcessingRef = useRef<DraftProcessing>(remoteProcessing);
  remoteProcessingRef.current = remoteProcessing;
  const canUndoRef = useRef(canUndoEnhance);
  canUndoRef.current = canUndoEnhance;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  // Fire-time source of truth for the selected profile. The debounced draft
  // save and the remote-apply guards read this ref AT USE, never a captured
  // closure value — a picker change between save-schedule and save-fire (or
  // between request and echo) must never write back the superseded profile.
  const selectedProfileIdRef = useRef(selectedProfileId);
  selectedProfileIdRef.current = selectedProfileId;
  const onProfileChangeRef = useRef(onProfileChange);
  onProfileChangeRef.current = onProfileChange;
  // Blocks a second ✨ click during the PUT+POST RTT before remoteProcessing updates.
  const enhanceInFlightRef = useRef(false);
  const restoringRef = useRef(false);
  const draftLoadRef = useRef(false);
  // Last profileId this device pushed up from a server draft, paired with the
  // selection in force when it did. Loop breaker — see shouldForwardProfile in
  // ../draftLock.ts. Reset per conversation.
  const lastForwardedProfileRef = useRef<{ id: string; selection: string } | null>(null);
  const attachmentRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // IME composition in progress: never "idle", whatever the keystroke clock says.
  const composingRef = useRef(false);

  const isTextareaFocused = useCallback(() =>
    document.activeElement === desktopTextareaRef.current
    || document.activeElement === mobileTextareaRef.current,
  []);

  const clearComposerDraft = useCallback((cid: string | undefined, opts?: { discardRemote?: boolean }) => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    // Invalidate in-flight PUTs from blur-flush / debounce so their finally
    // hooks don't keep pendingSave true, and so their echoes are ignored.
    saveEpochRef.current += 1;
    saveInFlight.current = 0;
    persistQueuedRef.current = null;
    lastLocalEditAtRef.current = 0;
    // Sync before setState: blur-flush / applyRemoteDraft may read this ref
    // before the next render.
    textRef.current = '';
    if (opts?.discardRemote) discardRemoteTextRef.current = true;
    setText('');
    setAttachments([]);
    setCanUndoEnhance(false);
    canUndoRef.current = false;
    setArmed(false);
    if (cid) writeLocalDraft(cid, '');
  }, []);

  const clearAfterDispatch = useCallback(() => {
    setComposerExtra(0);
    setMobileOpen(false);
    clearComposerDraft(conversationId, { discardRemote: true });
    if (conversationId) api.deleteDraft(conversationId).catch(() => {});
  }, [conversationId, clearComposerDraft]);

  const persistDraft = useCallback((cid: string, capturedText?: string) => {
    // One PUT at a time. Each job carries a full snapshot (cid+text captured at
    // schedule/flush time, attachments at job creation) and jobs drain in
    // schedule order, so the last-scheduled snapshot always wins — a typing
    // save can no longer finish after the image-paste save and empty the
    // thumbnail, nor can a post-switch drain sample the new conversation's
    // text for the old cid.
    const job = {
      cid,
      text: capturedText ?? textRef.current,
      attachments: attachmentsForPersist(attachmentsRef.current),
      epoch: saveEpochRef.current,
    };
    persistQueuedRef.current = job;
    if (saveInFlight.current > 0) return;
    const drain = (queued: typeof job) => {
      persistQueuedRef.current = null;
      saveInFlight.current += 1;
      api.putDraft(queued.cid, queued.text, queued.attachments, selectedProfileIdRef.current)
        .then(() => {
          // Blur-flush / debounce PUT can finish after send clear + deleteDraft and
          // re-upsert the sent prompt. Undo that write so the server stays empty.
          if (queued.epoch !== saveEpochRef.current) {
            return api.deleteDraft(queued.cid);
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : '';
          if (msg.includes('409')) return;   // draft frozen server-side; the settle frame wins
          if (msg.includes('413')) {
            setDraftSaveWarning('Attachment too large to save across devices — it\'ll still send this session');
          }
        })
        .finally(() => {
          saveInFlight.current = Math.max(0, saveInFlight.current - 1);
          // Drain the next queued job only when it was queued under the current
          // epoch — one scheduled before a send-clear is dead weight.
          const next = persistQueuedRef.current;
          if (next && next.epoch === saveEpochRef.current) {
            drain(next);
          } else {
            persistQueuedRef.current = null;
          }
        });
    };
    drain(job);
  }, []);

  const isDraftSavePending = useCallback(
    () => Boolean(saveTimer.current) || saveInFlight.current > 0 || persistQueuedRef.current !== null,
    [],
  );

  const scheduleSave = useCallback((cid: string, value: string) => {
    if (!cid || isScheduleHome) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const capturedCid = cid;                                  // D6: bind now, not at fire time
    const capturedText = value;                               // …and the text with it (see persistDraft)
    lastLocalEditAtRef.current = Date.now();
    pendingSaveCidRef.current = capturedCid;
    saveTimer.current = setTimeout(() => {
      // Null on fire: `saveTimer.current` is read as "a keystroke is still
      // unsaved" by the don't-clear-the-typist guards below. Leaving the spent
      // handle truthy made those guards permanent for the rest of the
      // conversation, so a peer device's send/clear could never empty a focused
      // composer — stale text stranded until reload.
      saveTimer.current = null;
      pendingSaveCidRef.current = null;
      // Mirror at fire time, not per keystroke — see DRAFT_SAVE_DEBOUNCE_MS.
      writeLocalDraft(capturedCid, capturedText);
      persistDraft(capturedCid, capturedText);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }, [isScheduleHome, persistDraft]);

  const flushPendingSave = useCallback(() => {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const cid = pendingSaveCidRef.current;
    pendingSaveCidRef.current = null;
    if (!cid || isScheduleHome) return;
    writeLocalDraft(cid, textRef.current);
    persistDraft(cid);
  }, [isScheduleHome, persistDraft]);

  // ponytail: every programmatic draft mutation (clear button, speech chunk,
  // paste/command/btw insert, imperative setText from parent) goes through
  // commitText so it persists the same way a keystroke does — otherwise these
  // edits are lost on conversation switch / other devices (the textarea
  // onChange path was the only one that called scheduleSave).
  const commitText = useCallback((next: string) => {
    // Operator is editing again — stop ignoring peer/echo frames from the
    // post-send discard window (also covers deleteDraft failure).
    if (next !== '') discardRemoteTextRef.current = false;
    setText(next);
    if (conversationId && !isScheduleHome) scheduleSave(conversationId, next);
  }, [conversationId, isScheduleHome, scheduleSave]);

  const focusPrompt = useCallback(() => {
    setTimeout(() => {
      const el =
        desktopTextareaRef.current
        ?? mobileTextareaRef.current
        ?? (document.querySelector('.prompt-field') as HTMLTextAreaElement | null);
      el?.focus();
      if (el) {
        el.selectionStart = el.value.length;
        el.selectionEnd = el.value.length;
      }
    }, 0);
  }, []);

  const insertPrompt = useCallback((body: string) => {
    commitText(composeInsert(textRef.current, body));
    focusPrompt();
  }, [commitText, focusPrompt]);

  const cancelQueueEdit = useCallback(() => {
    const prev = preEditRef.current;
    preEditRef.current = null;
    setEditingQueueId(null);
    commitText(prev?.text ?? '');
    restoringRef.current = true;
    setAttachments(prev?.attachments ?? []);
  }, [commitText]);

  const beginQueueEdit = useCallback((q: QueuedMessage) => {
    if (editingQueueId === q.id) {
      focusPrompt();
      return;
    }
    if (!editingQueueId) {
      preEditRef.current = { text: textRef.current, attachments: attachmentsRef.current };
    }
    setEditingQueueId(q.id);
    commitText(q.text);
    restoringRef.current = true;
    setAttachments((q.attachments ?? []).map((a) => ({
      base64: a.base64,
      mediaType: a.mediaType,
      name: a.name ?? 'attachment',
    })));
    focusPrompt();
  }, [editingQueueId, commitText, focusPrompt]);

  useEffect(() => {
    setEditingQueueId(null);
    preEditRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    if (editingQueueId && !steerQueue.some((q) => q.id === editingQueueId)) {
      setEditingQueueId(null);
      preEditRef.current = null;
    }
  }, [steerQueue, editingQueueId]);

  useImperativeHandle(ref, () => ({
    // Persist + focus: "Send to agent" / repeat-question injects are drafts,
    // never auto-submit. Cross-device visibility requires scheduleSave.
    setText: (t: string, atts?: PromptAttachment[]) => {
      commitText(t);
      if (atts !== undefined) {
        const restored = restoredAttachments(atts);
        // Sync before render so a pending persistDraft drain cannot snapshot
        // the pre-repeat thumbs (or []). Repeat must PUT the restored set.
        attachmentsRef.current = restored;
        setAttachments(restored);
      }
      focusPrompt();
    },
    clearAfterSend: clearAfterDispatch,
    focus: focusPrompt,
    blur: () => {
      desktopTextareaRef.current?.blur();
      mobileTextareaRef.current?.blur();
    },
    addAttachment,
    applyRemoteDraft: (frame: DraftUpdatedFrame) => {
      // Echo guard: this frame is our own write-through bouncing back (or a
      // peer device agreeing with us) when it matches the live selection.
      // Only a DIFFERENT profile from a peer device moves the picker.
      if (!isRemoteAgentsRef.current && shouldForwardProfile(frame.profileId, selectedProfileIdRef.current, lastForwardedProfileRef.current)) {
        lastForwardedProfileRef.current = { id: frame.profileId!, selection: selectedProfileIdRef.current };
        // Server already holds this profile (peer PUT or our own picker write).
        // Persisting again broadcasts an empty-text echo on a fresh draft and
        // wipes in-progress typing.
        onProfileChangeRef.current(frame.profileId!, { persist: false });
      }
      const wasBusy = remoteProcessingRef.current !== 'idle';
      // Only the pre-enhance putDraft echo is dropped. A whisper transcribe
      // settle has the same flags (idle, no error, no canUndo) and MUST apply —
      // dropping it wedged remoteProcessing at 'transcribing', which killed the
      // ✨ button and stranded the dictated text. See apps/web/src/draftLock.ts.
      if (shouldDropDraftFrame(
        {
          enhanceInFlight: enhanceInFlightRef.current,
          remoteProcessing: remoteProcessingRef.current,
        },
        frame,
      )) {
        return;
      }
      // Lock + undo state are ALWAYS applied — a typist on this device must freeze too.
      setRemoteProcessing(frame.processing);
      remoteProcessingRef.current = frame.processing;
      setRemoteStartedAt(frame.processing === 'idle' ? null : frame.processingStartedAt);
      if (frame.error) setEnhanceError(frame.error);

      // Text: apply unconditionally on a busy→idle transition (this device very
      // likely started the job and still has focus); otherwise keep the
      // don't-fight-the-typist guard. (R3)
      // Also force-apply when undo clears (idle→idle, canUndo true→false) so a
      // focused peer still repaints the restored draft (adversary F2).
      const undoCleared = canUndoRef.current && !frame.canUndo;
      // Undo only after a successful enhance — never while processing or on failure.
      const nextCanUndo = frame.processing === 'idle' && frame.canUndo;
      setCanUndoEnhance(nextCanUndo);
      canUndoRef.current = nextCanUndo;
      // A focused composer nobody has touched for a few seconds is not "a typist"
      // — let peer text, clears and attachments land (desktop stays focused).
      // Re-evaluated live (refetch below runs later). An idle focused composer
      // is treated exactly like an unfocused one: every stale/echo guard applies.
      const typing = () => isTextareaFocused() && (composingRef.current || !focusedComposerIsIdle({
        pendingSave: isDraftSavePending(),
        lastLocalEditAt: lastLocalEditAtRef.current,
        now: Date.now(),
      }));
      if (isClearedDraftFrame(frame)) {
        // Keep discardRemoteTextRef armed: a blur-flush putDraft can complete
        // AFTER this empty settle and would otherwise resurrect the sent prompt.
        // Discard clears on keystroke / conversation switch only.
        if (shouldProtectLocalDraftFromClear({
          focused: typing(),
          localText: textRef.current,
          pendingSave: isDraftSavePending(),
          lastLocalEditAt: lastLocalEditAtRef.current,
          frameUpdatedAt: frame.updatedAt,
          localHasAttachments: attachmentsRef.current.length > 0,
        })) return;
        clearComposerDraft(conversationId);
        return;
      }
      // Late putDraft echo after send/handoff-confirm clear — do not resurrect.
      // A dictation settle (busy→idle) is never such an echo: the transcript
      // is fresh text appended under the lock. Dictating right after a send —
      // no keystroke in between to clear the discard window — must land, and
      // the settle itself closes the window (the server draft is canonical
      // new text, not the sent prompt).
      const dictationSettle = wasBusy && frame.processing === 'idle';
      if (dictationSettle) discardRemoteTextRef.current = false;
      if (shouldIgnoreStaleDraftText({
        discardingRemoteText: discardRemoteTextRef.current,
        text: frame.text,
        dictationSettle,
      })) return;
      const forceApply = (wasBusy && frame.processing === 'idle') || undoCleared;
      if (!forceApply && typing()) return;
      if (frame.text !== textRef.current && shouldApplyRemoteDraftText({
        forceApply,
        focused: typing(),
        localText: textRef.current,
        remoteText: frame.text,
        hasRemoteAttachments: frame.hasAttachments,
        pendingSave: isDraftSavePending(),
        lastLocalEditAt: lastLocalEditAtRef.current,
        frameUpdatedAt: frame.updatedAt,
        localHasAttachments: attachmentsRef.current.length > 0,
      })) {
        setText(frame.text);
        if (conversationId) writeLocalDraft(conversationId, frame.text);
      }

      const localHas = attachmentsRef.current.length > 0;
      const refetchAttachments = () => {
        if (!conversationId || conversationIdRef.current !== conversationId) return;
        if (!forceApply && typing()) return;
        api.getDraft(conversationId).then((r) => {
          if (conversationIdRef.current !== conversationId) return;
          if (!forceApply && typing()) return;
          const next = r.attachments ?? [];
          // Stale GET after an image paste must not replace a local thumbnail
          // with []. True clears go through clearComposerDraft above.
          if (next.length === 0 && attachmentsRef.current.length > 0) return;
          restoringRef.current = true;
          setAttachments(restoredAttachments(next));
        }).catch(() => {/* keep local */});
      };

      if (frame.hasAttachments !== localHas) {
        if (attachmentRefetchTimer.current) clearTimeout(attachmentRefetchTimer.current);
        refetchAttachments();
      } else if (frame.hasAttachments) {
        if (attachmentRefetchTimer.current) clearTimeout(attachmentRefetchTimer.current);
        attachmentRefetchTimer.current = setTimeout(refetchAttachments, 300);
      }
    },
  }), [addAttachment, commitText, conversationId, isTextareaFocused, focusPrompt, clearComposerDraft, clearAfterDispatch]);

  // (a) Load on conversation change — localStorage paints first, then server reconciles.
  // Reset processing synchronously so switching conversations never carries a stale freeze.
  useEffect(() => {
    // Flush a pending debounce bound to the PREVIOUS conversation before
    // anything else. Its snapshot still points at the old cid, so this
    // persists the old conversation's last keystrokes (mirror + PUT); without
    // it, a timer firing after the switch would sample the NEW conversation's
    // text for the old cid. Deliberately NO epoch bump here: a switch is not a
    // send — an in-flight PUT for the old cid must land, not deleteDraft.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const pendingCid = pendingSaveCidRef.current;
      pendingSaveCidRef.current = null;
      if (pendingCid) persistDraft(pendingCid);
    }
    setRemoteProcessing('idle');
    remoteProcessingRef.current = 'idle';
    setEnhanceChoiceOpen(false);
    setRemoteStartedAt(null);
    setCanUndoEnhance(false);
    lastForwardedProfileRef.current = null;
    lastLocalEditAtRef.current = 0;
    discardRemoteTextRef.current = false;
    if (!conversationId || isScheduleHome) { setText(''); setAttachments([]); return; }
    const localMirror = readLocalDraft(conversationId);
    setText(localMirror);                            // instant paint from mirror
    draftLoadRef.current = true;
    setAttachments([]);                              // attachments load after GET (no localStorage mirror)
    let cancelled = false;
    api.getDraft(conversationId).then((r) => {        // reconcile with server (authoritative)
      if (cancelled) return;
      draftLoadRef.current = false;
      // Seed the picker from the persisted draft only when it differs from
      // the live selection. Ref read at response time: this effect must NOT
      // re-run on picker change (that re-GET reverting fresh picks was the
      // revert-loop bug) — it runs on conversation change only.
      if (!isRemoteAgentsRef.current && shouldForwardProfile(r.profileId, selectedProfileIdRef.current, lastForwardedProfileRef.current)) {
        lastForwardedProfileRef.current = { id: r.profileId!, selection: selectedProfileIdRef.current };
        // Seed the picker only — the row already has this profile. A persist
        // PUT here is the empty-echo that still wiped schedule-run composers.
        onProfileChangeRef.current(r.profileId!, { persist: false });
      }
      // Processing/canUndo MUST apply before the focus/mirror early-returns so a
      // reopened or re-selected conversation still learns it is frozen (D12).
      setRemoteProcessing(r.processing);
      remoteProcessingRef.current = r.processing;
      setRemoteStartedAt(r.processing === 'idle' ? null : r.processingStartedAt);
      setCanUndoEnhance(r.processing === 'idle' && r.canUndo);
      canUndoRef.current = r.processing === 'idle' && r.canUndo;
      setArmed(Boolean(r.autoSend));
      // In-flight Slow-Yes must not paint a raw stash as an editable prompt.
      // The idle settle carries the rewrite (or the raw on enhance failure).
      if (r.processing !== 'idle') return;
      // Auto-send / delete: empty idle server is truth. The old "keep a non-empty
      // local mirror" guard re-showed the sent prompt after a background send.
      if (r.text === '') {
        if (shouldProtectLocalDraftFromClear({
          focused: isTextareaFocused(),
          localText: textRef.current,
          pendingSave: isDraftSavePending(),
          lastLocalEditAt: lastLocalEditAtRef.current,
          frameUpdatedAt: r.updatedAt ?? 0,
          localHasAttachments: attachmentsRef.current.length > 0,
        })) return;
        if ((r.attachments ?? []).length === 0) {
          clearComposerDraft(conversationId);
          restoringRef.current = true;
          setAttachments([]);
          return;
        }
        // Image-only server draft: restore attachments without a full composer
        // wipe (clearComposerDraft would drop the thumbnail then re-set it, and
        // also reset lastLocalEditAt). Text is empty on the server so apply it.
        restoringRef.current = true;
        setText('');
        writeLocalDraft(conversationId, '');
        setAttachments(restoredAttachments(r.attachments ?? []));
        return;
      }
      // Skip text if the local textarea is being typed into (don't fight the active typist).
      if (isTextareaFocused()) return;
      setText(r.text);
      writeLocalDraft(conversationId, r.text);
      restoringRef.current = true;
      setAttachments(restoredAttachments(r.attachments ?? []));
    }).catch(() => { draftLoadRef.current = false; /* offline: keep the mirror value */ });
    return () => { cancelled = true; draftLoadRef.current = false; };
    // isTextareaFocused is a stable callback — do NOT list it as a dep or
    // blurring the textarea (clicking ✨) would reset processing to idle.
    // selectedProfileId deliberately NOT a dep: re-running on picker change
    // re-fetched the draft and re-applied the server's (now stale) profile,
    // reverting the pick. Ref-read at response time handles seeding.
    // onProfileChange also a ref: identity churn must not re-GET mid-typing.
  }, [conversationId, isScheduleHome, clearComposerDraft]);

  // A missed settle frame (WS subscribe raced the broadcast) would otherwise
  // animate the processing visual forever, because nothing else re-reads the
  // lock until the conversation is re-selected. Expire at exactly the server's
  // own stale-lock TTL so client and server never disagree. One timer, no poll.
  // ponytail: no equivalent bound for 'enhancing' — that state greys the
  // composer, which the operator notices immediately. Add one only if it bites.
  useEffect(() => {
    if (remoteProcessing !== 'transcribing') return;
    const clear = () => {
      setRemoteProcessing('idle');
      remoteProcessingRef.current = 'idle';
      setRemoteStartedAt(null);
    };
    const ms = remainingProcessingMs(remoteStartedAt, Date.now());
    if (ms <= 0) { clear(); return; }
    const t = setTimeout(clear, ms);
    return () => clearTimeout(t);
  }, [remoteProcessing, remoteStartedAt]);

  // Persist attachment add/remove/annotate (not just keystrokes).
  useEffect(() => {
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    if (draftLoadRef.current) return;
    if (!conversationId || isScheduleHome) return;
    scheduleSave(conversationId, textRef.current);
  }, [attachments, conversationId, isScheduleHome, scheduleSave]);

  useEffect(() => {
    if (!draftSaveWarning) return;
    const t = setTimeout(() => setDraftSaveWarning(null), 8000);
    return () => clearTimeout(t);
  }, [draftSaveWarning]);

  // ponytail: no auto-dismiss. An enhance failure looks exactly like "nothing
  // happened" (box unfreezes, text unchanged), so the reason has to stay on
  // screen until the operator clears it or starts another enhance.

  // Config-gated ✨ visibility — fetch on mount + whenever Settings saves enhance config.
  useEffect(() => {
    const refresh = () => {
      api.getEnhanceConfig()
        .then((r) => {
          setEnhanceConfigured(r.configured);
          setEnhanceProject({ configured: r.projectConfigured, reason: r.projectUnavailableReason });
        })
        .catch(() => {
          setEnhanceConfigured(false);
          setEnhanceProject({ configured: false });
        });
    };
    refresh();
    window.addEventListener('enhance-settings-changed', refresh);
    return () => window.removeEventListener('enhance-settings-changed', refresh);
  }, []);

  // (c) sendBeacon flush on unload / background.
  useEffect(() => {
    const flush = () => {
      const cid = conversationId;
      if (!cid || isScheduleHome) return;
      // sendBeacon only does POST; PUT the current text (even '') — see Task 4 caveat.
      // Attachments ride the beacon only when small — sendBeacon silently drops multi-MB payloads;
      // the debounced PUT (primary path) will already have persisted larger images.
      // When oversize, omit attachments entirely — server preserves existing (not [] which clears).
      const atts = attachmentsForPersist(attachmentsRef.current);
      const fullPayload = { text: textRef.current, attachments: atts };
      const payload: PutDraftRequest = JSON.stringify(fullPayload).length < 60_000
        ? fullPayload
        : { text: textRef.current };
      try {
        navigator.sendBeacon(
          `${apiBase}/conversations/${cid}/draft`,
          new Blob([JSON.stringify(payload)], { type: 'application/json' }),
        );
      } catch { /* ignore */ }
    };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('beforeunload', flush); document.removeEventListener('visibilitychange', onVis); };
  }, [conversationId, isScheduleHome]);

  // Close the add-menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !desktopMenuRef.current?.contains(target) &&
        !mobileMenuRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Autosense available vertical viewport height for mobile popover menu
  // so it never gets truncated by the top of the screen in landscape or constrained viewports.
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMobileMenuMaxHeight(null);
      return;
    }
    const updateMenuHeight = () => {
      const wrap = mobileMenuRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      // Menu bottom is anchored above trigger with an 8px gap.
      // Expand as long as there is screen real estate above, leaving at least 16px clearance from the top.
      const spaceAbove = rect.top - 16;
      setMobileMenuMaxHeight(Math.max(120, Math.floor(spaceAbove)));
    };
    updateMenuHeight();
    window.addEventListener('resize', updateMenuHeight);
    window.addEventListener('orientationchange', updateMenuHeight);
    window.visualViewport?.addEventListener('resize', updateMenuHeight);
    return () => {
      window.removeEventListener('resize', updateMenuHeight);
      window.removeEventListener('orientationchange', updateMenuHeight);
      window.visualViewport?.removeEventListener('resize', updateMenuHeight);
    };
  }, [menuOpen]);

  // Pending timers for the chip row. REST only — refetch on conversation
  // switch and after create/cancel. A fired timer will linger at "0s" until
  // the next refetch; that is accepted (no WS frame).
  useEffect(() => {
    if (!conversationId) {
      setPendingTimers([]);
      return;
    }
    let cancelled = false;
    const fetchTimers = () => {
      api.listConversationTimers(conversationId)
        .then((timers) => { if (!cancelled) setPendingTimers(timers); })
        .catch(() => { if (!cancelled) setPendingTimers([]); });
    };
    fetchTimers();

    const onTimersChanged = (e: Event) => {
      if (e instanceof CustomEvent && e.detail?.conversationId && e.detail.conversationId !== conversationId) {
        return;
      }
      if (e instanceof CustomEvent && e.detail?.timerId && e.detail?.action === 'cancelled') {
        setPendingTimers((prev) => prev.filter((t) => t.id !== e.detail.timerId));
      }
      fetchTimers();
    };

    window.addEventListener('conversation-timers-changed', onTimersChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('conversation-timers-changed', onTimersChanged);
    };
  }, [conversationId]);

  useEffect(() => {
    if (pendingTimers.length === 0) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [pendingTimers.length]);

  const handleSpeechChunk = useCallback((
    chunk: string,
    pinnedCid: string | null,
    autoSent: boolean,
    serverPersisted: boolean,
  ) => {
    const trimmed = chunk.trim();
    if (autoSent) {
      // Server already sent the draft + cleared it (D3/D9). Clear even when the
      // HTTP body still carries the sent text (Slow-Yes returns the rewrite).
      if (pinnedCid && pinnedCid === conversationId && !isScheduleHome) {
        clearComposerDraft(conversationId, { discardRemote: true });
      }
      return;
    }
    if (!trimmed) return;
    if (serverPersisted) {
      // ponytail: whisper text now arrives via the draft_updated broadcast instead
      // of a local append — one extra WS hop (same host, sub-ms) buys us a single
      // writer and kills the double-append race.
      return;
    }
    // Browser Web Speech path: local append + debounced PUT. Nothing survives a
    // close, so no server lock. Users who want close-the-laptop dictation must
    // use the whisper engine (Settings → STT engine).
    if (pinnedCid && pinnedCid === conversationId && !isScheduleHome) {
      setText(current => {
        const next = current ? current + ' ' + trimmed : trimmed;
        scheduleSave(conversationId, next);
        return next;
      });
    }
  }, [conversationId, isScheduleHome, scheduleSave, clearComposerDraft]);

  const getConversationId = useCallback(() => conversationId ?? null, [conversationId]);

  const handleScheduleTimer = useCallback(async (payload: PromptTimerSchedulePayload) => {
    if (!conversationId) throw new Error('No conversation selected');
    await api.createConversationTimer(conversationId, {
      prompt: payload.prompt.trim(),
      profileId: payload.profileId,
      ...payload.when,
      ...(payload.effort ? { effort: payload.effort } : {}),
      ...(payload.options ? { options: payload.options } : {}),
      ...(payload.attachments.length > 0 ? { attachments: payload.attachments } : {}),
      ...(payload.handoffOverride ? { handoffOverride: payload.handoffOverride } : {}),
    });
    // The composer has been handed off to the timer: wipe text, attachments and
    // option pills, and persist the cleared draft so a reload doesn't resurrect it.
    clearAfterDispatch();
    onPromptOptionsClear?.();
    const timers = await api.listConversationTimers(conversationId);
    setPendingTimers(timers);
  }, [conversationId, clearAfterDispatch, onPromptOptionsClear]);

  const cancelPendingTimer = useCallback(async (timerId: string) => {
    const cid = conversationId;
    setPendingTimers((prev) => prev.filter((t) => t.id !== timerId));
    if (!cid) return;
    try {
      await api.cancelConversationTimer(cid, timerId);
    } catch {
      try {
        setPendingTimers(await api.listConversationTimers(cid));
      } catch {
        /* list failed too — chips already dropped; next conversation switch recovers */
      }
    }
  }, [conversationId]);

  const handleUpdateTimer = useCallback(async (payload: PromptTimerSchedulePayload) => {
    if (!conversationId || !editingTimer) throw new Error('No timer selected');
    await api.updateConversationTimer(conversationId, editingTimer.id, {
      prompt: payload.prompt.trim(),
      profileId: payload.profileId,
      ...(payload.when ?? {}),
      effort: payload.effort,                 // null clears — send explicitly
      options: payload.options,               // null clears — send explicitly
      handoffOverride: payload.handoffOverride,
      // attachments deliberately omitted: unchanged
    });
    setPendingTimers(await api.listConversationTimers(conversationId));
  }, [conversationId, editingTimer]);

  const confirmDeleteTimer = useCallback(async () => {
    if (!deletingTimer) return;
    setConfirmBusy(true);
    try { await cancelPendingTimer(deletingTimer.id); }
    finally { setConfirmBusy(false); setDeletingTimer(null); }
  }, [deletingTimer, cancelPendingTimer]);

  // Both hooks instantiated; gate on the per-device sttEngine setting. The
  // browser path remains available as a fallback when whisper-cli isn't
  // installed or the user prefers the streaming Web Speech API.
  // ponytail: browser Web Speech is capture+recognition in the tab — nothing
  // survives a close, so no server lock. Users who want close-the-laptop
  // dictation must use the whisper engine (Settings → STT engine).
  // Browser STT never auto-sends (D11) — adapt the 2-arg callback at the boundary.
  const browserMic = useSpeechInput((c, cid) => handleSpeechChunk(c, cid, false, false), getConversationId);
  const whisperMic = useWhisperInput((c, cid, autoSent) => handleSpeechChunk(c, cid, autoSent, true), getConversationId);
  const [sttEngine, setSttEngineState] = useState<ReturnType<typeof getSttEngine>>(getSttEngine);
  const [waveStyle, setWaveStyleState] = useState<WaveStyle>(getWaveStyle);
  const [detectionVisual, setDetectionVisualState] = useState<VoiceDetectionVisual>(getVoiceDetectionVisual);
  const [processingVisual, setProcessingVisualState] = useState<VoiceProcessingVisual>(getVoiceProcessingVisual);
  useEffect(() => {
    const onChange = () => {
      setSttEngineState(getSttEngine());
      setWaveStyleState(getWaveStyle());
      setDetectionVisualState(getVoiceDetectionVisual());
      setProcessingVisualState(getVoiceProcessingVisual());
    };
    window.addEventListener('voice-settings-changed', onChange);
    return () => window.removeEventListener('voice-settings-changed', onChange);
  }, []);
  const activeMic = sttEngine === 'whisper' ? whisperMic : browserMic;
  const { supported: micSupported, listening, transcribing: rawTranscribing,
          transcribingConversationId, error: micError, getMicLevel } = activeMic;
  const transcribing = rawTranscribing && transcribingConversationId === conversationId;

  // Mic tap: while listening, second tap stops. Whisper engine opens the Fast/Slow
  // popup; browser engine has no server cleanup path, so it starts immediately.
  // Busy guard: see commitDictation — the server assumes one draft job at a time.
  const handleMicClick = useCallback(() => {
    if (listening) { activeMic.toggle(); return; }
    if (remoteProcessingRef.current !== 'idle') return;
    if (sttEngine === 'whisper') { setDictationPopupOpen(true); return; }
    browserMic.toggle();
  }, [listening, sttEngine, activeMic, browserMic]);

  // Swipe-up on the attach (+) button → trigger the microphone directly,
  // skipping the add-menu. Tap or horizontal movement still opens the menu.
  const attachTouchRef = useRef<{ startX: number; startY: number; swiping: boolean } | null>(null);
  const suppressAttachClickRef = useRef(false);
  const [attachSwiping, setAttachSwiping] = useState(false);

  const onAttachTouchStart = useCallback((e: React.TouchEvent) => {
    if (!micSupported) return;
    const t = e.touches[0];
    if (!t) return;
    attachTouchRef.current = { startX: t.clientX, startY: t.clientY, swiping: false };
  }, [micSupported]);

  const onAttachTouchMove = useCallback((e: React.TouchEvent) => {
    const s = attachTouchRef.current;
    if (!s) return;
    const t = e.touches[0];
    if (!t) return;
    if (t.clientY - s.startY < -10 && !s.swiping) {
      s.swiping = true;
      setAttachSwiping(true);
    }
  }, []);

  const onAttachTouchEnd = useCallback((e: React.TouchEvent) => {
    const s = attachTouchRef.current;
    attachTouchRef.current = null;
    setAttachSwiping(false);
    if (!s || !micSupported) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dy = t.clientY - s.startY;
    const dx = t.clientX - s.startX;
    // Completed vertical-dominant upward swipe → trigger mic.
    if (dy < -24 && Math.abs(dx) < Math.abs(dy)) {
      suppressAttachClickRef.current = true;
      setMenuOpen(false);
      handleMicClick();
      return;
    }
    // Any upward swiping attempt suppresses the follow-up click so the menu
    // doesn't accidentally open when the user was trying to swipe.
    if (s.swiping) suppressAttachClickRef.current = true;
  }, [handleMicClick, micSupported]);

  const onAttachClick = useCallback(() => {
    if (suppressAttachClickRef.current) {
      suppressAttachClickRef.current = false;
      return;
    }
    setMenuOpen(o => !o);
  }, []);

  const selectedProfile = useMemo(
    () => resolveConversationProfile(profiles, selectedProfileId, projectId, undefined, conversationTitle),
    [profiles, selectedProfileId, projectId, conversationTitle],
  );
  const botName = (selectedProfile?.agentType === 'grok-bot' && selectedProfile?.label && selectedProfile?.label !== 'Active chat'
    ? selectedProfile.label.replace(/^Grok Bot ·\s*/, '')
    : null)
    || conversationTitle
    || 'Bot';
  const isGrokBot = isRemoteAgents || selectedProfile?.agentType === 'grok-bot';

  // Per-transcription arm state — resets when transcription ends (starts disarmed).
  const [armed, setArmed] = useState(false);
  const transcribingRef = useRef(transcribing);
  transcribingRef.current = transcribing;
  useEffect(() => {
    if (!transcribing && remoteProcessing !== 'transcribing') setArmed(false);
  }, [transcribing, remoteProcessing]);
  const armable = sttEngine === 'whisper'
    && (transcribing || remoteProcessing === 'transcribing')
    && attachments.length === 0;
  const toggleArm = useCallback(() => {
    if (!conversationId || !selectedProfile) return;
    const next = !armed;
    setArmed(next); // optimistic
    void api.armTranscribe(
      conversationId,
      {
        profileId: selectedProfile.id,
        agent: selectedProfile.agentType,
        agentModel: selectedProfile.model,
      },
      next,
    ).catch(() => {
      // Late arm / network error — revert only while still transcribing.
      // Once the slot is gone a 404 must not re-arm the UI for the next clip.
      if (transcribingRef.current) setArmed(!next);
      else setArmed(false);
    });
  }, [armed, conversationId, selectedProfile]);

  // Slider snapped to a side. Fast starts the mic immediately. Slow closes the
  // strip and opens the enhance-with-context modal; the mic starts from that
  // callback so Cancel can abandon without recording.
  const commitDictation = useCallback((m: DictationMode) => {
    // One job per conversation (server lock). Starting a recording while a
    // transcription or enhance holds the composer would settle "without
    // freeze" server-side and its idle settle frame can be dropped by the
    // enhance gate — stranded text. The processing strip is the busy affordance.
    if (remoteProcessingRef.current !== 'idle') {
      setDictationPopupOpen(false);
      return;
    }
    setDictationMode(m);
    if (m === 'fast') {
      whisperMic.toggle({ skipCleanup: true });
      return;
    }
    setDictationPopupOpen(false);
    setEnhanceChoiceOpen(true);
  }, [whisperMic]);

  const startSlowDictation = useCallback((choice: SlowEnhanceChoice) => {
    if (remoteProcessingRef.current !== 'idle') return;
    setSlowEnhanceChoice(choice);
    setEnhanceChoiceOpen(false);
    whisperMic.toggle(slowEnhanceToggleOpts(choice));
  }, [whisperMic]);

  const cancelEnhanceChoice = useCallback(() => {
    setEnhanceChoiceOpen(false);
  }, []);

  const stopDictation = useCallback(() => {
    // Recording: stop the mic (whisper then uploads). Processing: cancel the
    // server job AND drop the local wait. Visual stays until the settle frame.
    if (listening) {
      if (sttEngine === 'whisper') whisperMic.cancel();
      else browserMic.cancel();
      return;
    }
    if (conversationId && (transcribing || remoteProcessing === 'transcribing')) {
      void api.cancelTranscribe(conversationId).catch(() => { /* 404/offline */ });
    }
    if (sttEngine === 'whisper') whisperMic.cancel();
    else browserMic.cancel();
  }, [sttEngine, whisperMic, browserMic, listening, conversationId, transcribing, remoteProcessing]);
  // Voice lane state. The processing visual is server-driven (remoteProcessing),
  // so it shows on a peer device, survives an aborted upload, and stays up until
  // the settle frame lands. Detection stays local — only this device has a mic.
  const strip = voiceStripState({
    listening,
    localTranscribing: transcribing,
    remoteProcessing,
  });
  const voiceVisible = strip.visible;
  // Tap-to-stop: mic while recording; POST /transcribe/cancel while processing.
  // The processing visual is interactive on every subscribed device (same operator).
  const voiceInteractive = strip.interactive;

  const showResizeHandle = !voiceVisible && !dictationPopupOpen && !enhanceChoiceOpen;
  const canResizeComposer = showResizeHandle;

  // Extra is capped so the sheet (header + field + send) stays inside the
  // visual viewport — innerHeight does not shrink with the soft keyboard.
  const maxExtraRef = useRef(0);
  maxExtraRef.current = (() => {
    const viewH = Math.round(window.visualViewport?.height ?? window.innerHeight);
    if (window.matchMedia('(max-width: 600px), (max-height: 500px) and (orientation: landscape)').matches) {
      const sheet = mobileSheetRef.current;
      const ta = mobileTextareaRef.current;
      const chrome = sheet && ta ? sheet.offsetHeight - ta.offsetHeight : 220;
      return Math.max(0, viewH - Math.max(chrome, 160) - 80);
    }
    return Math.round(viewH * 0.4);
  })();
  const composerCap = 80 + maxExtraRef.current;

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!canResizeComposer) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeDragRef.current = { y: e.clientY, extra: composerExtra };
    setResizeDragging(true);
  }, [canResizeComposer, composerExtra]);

  // Track on window so the handle can move with the sheet without losing the
  // gesture (element-local pointermove dies as soon as the finger leaves the
  // thin grip, which felt like a one-way "flip up").
  useEffect(() => {
    if (!resizeDragging) return;
    const applyY = (clientY: number) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      const max = maxExtraRef.current;
      const next = Math.max(0, Math.min(max, drag.extra + (drag.y - clientY)));
      setComposerExtra(next);
    };
    const onMove = (e: PointerEvent) => {
      if (e.cancelable) e.preventDefault();
      applyY(e.clientY);
    };
    // iOS often skips pointermove during touch pan; touchmove is the 1:1 signal.
    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      const t = e.touches[0];
      if (t) applyY(t.clientY);
    };
    const onUp = () => {
      resizeDragRef.current = null;
      setResizeDragging(false);
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizeDragging]);

  useEffect(() => { setComposerExtra(0); }, [conversationId]);
  // Mobile: collapse only when the sheet stashes (tap away / send / close).
  // Do not collapse just because the prompt was cleared. Desktop never stashes.
  const wasMobileOpen = useRef(false);
  useEffect(() => {
    if (wasMobileOpen.current && !mobileOpen) setComposerExtra(0);
    wasMobileOpen.current = mobileOpen;
  }, [mobileOpen]);
  useEffect(() => {
    const clamp = () => setComposerExtra((e) => Math.min(e, maxExtraRef.current));
    const vv = window.visualViewport;
    vv?.addEventListener('resize', clamp);
    window.addEventListener('resize', clamp);
    return () => {
      vv?.removeEventListener('resize', clamp);
      window.removeEventListener('resize', clamp);
    };
  }, []);

  // Close the picker once recording actually starts (morph handoff to the
  // wave), or if the mic errors out and no wave is coming.
  useEffect(() => {
    if (voiceVisible || micError) setDictationPopupOpen(false);
    if (micError) setEnhanceChoiceOpen(false);
  }, [voiceVisible, micError]);

  // Tap/click anywhere outside the picker strip dismisses without starting.
  useEffect(() => {
    if (!dictationPopupOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.('.voice-feedback-strip, .voice-feedback-mobile')) {
        setDictationPopupOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [dictationPopupOpen]);

  // Outside-click dismisses enhance mode popup.
  useEffect(() => {
    if (!enhancePopupOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.('.enhance-btn-wrap')) {
        setEnhancePopupOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [enhancePopupOpen]);

  const clearEnhanceStash = useCallback(() => {
    setCanUndoEnhance(false);
  }, []);

  const handleEnhancePick = useCallback(async (
    mode: EnhanceMode,
    opts?: { text?: string; instruction?: string },
  ) => {
    setEnhancePopupOpen(false);
    if (!conversationId || isScheduleHome) return;
    if (enhanceInFlightRef.current || remoteProcessingRef.current !== 'idle') return;
    const cid = conversationId;
    const draft = opts?.text ?? textRef.current;
    const capturedAttachments = attachmentsForPersist(attachmentsRef.current);
    if (!draft.trim()) return;
    enhanceInFlightRef.current = true;
    // Flush any pending debounce first: the server enhances the request-body
    // text but stashes pre_text from the server row. Flushing keeps undo in sync.
    // Capture draft+attachments at click (D12/F1): a conversation switch during
    // this await must not enhance the newly visible box into `cid`.
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    try {
      await api.putDraft(cid, draft, capturedAttachments);
    } catch { /* server may already hold newer text; enhance uses the request copy */ }

    // Optimistic freeze; no-op on the now-visible conversation if we browsed away (D12).
    // Undo stays hidden until a successful settle (canUndo:true).
    if (conversationIdRef.current === cid) {
      setRemoteProcessing('enhancing');
      remoteProcessingRef.current = 'enhancing';
      setCanUndoEnhance(false);
      canUndoRef.current = false;
      setEnhanceError(null);
    }
    try {
      await api.enhance({
        conversationId: cid,
        text: draft,
        mode,
        instruction: opts?.instruction,
      });
      // 202 — nothing else to do. The draft_updated frame delivers the result.
    } catch (e) {
      if (conversationIdRef.current !== cid) return;
      const status = (e as { status?: number }).status;
      const processing = (e as { processing?: string }).processing;
      // 409 = a job already holds the lock (double-click or a peer). Not a failed
      // enhance — stay frozen if that job is an enhance; do not toast "draft busy".
      if (status === 409 || /draft busy/i.test(e instanceof Error ? e.message : '')) {
        if (processing === 'transcribing') {
          setRemoteProcessing('idle');
          remoteProcessingRef.current = 'idle';
        } else {
          setRemoteProcessing('enhancing');
          remoteProcessingRef.current = 'enhancing';
        }
        setEnhanceError(null);
        return;
      }
      setRemoteProcessing('idle');
      remoteProcessingRef.current = 'idle';
      setCanUndoEnhance(false);
      canUndoRef.current = false;
      setEnhanceError(e instanceof Error ? e.message : String(e));
    } finally {
      enhanceInFlightRef.current = false;
    }
  }, [conversationId, isScheduleHome]);

  // ponytail: undo restores raw template after insert, not pre-insert draft
  const insertAndEnhance = useCallback(async (body: string, mode: EnhanceMode, instruction?: string) => {
    const composed = composeInsert(textRef.current, body);
    commitText(composed);
    textRef.current = composed;            // setText is async; handleEnhancePick must not race it
    setPromptCollectionOpen(false);
    await handleEnhancePick(mode, { text: composed, instruction });
  }, [commitText, handleEnhancePick]);

  const handleClearOrUndo = useCallback(async () => {
    if (canUndoEnhance && conversationId) {
      try {
        const restored = await api.undoEnhance(conversationId);
        setText(restored.text);
        writeLocalDraft(conversationId, restored.text);
        setCanUndoEnhance(false);
      } catch (e) {
        setEnhanceError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    commitText('');
  }, [canUndoEnhance, conversationId, commitText]);

  // Auto-grow the prompt textarea up to ~3 lines, then scroll internally.
  // composerExtra raises that cap so a swipe-resized bar can show a long prompt.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    const mobile = mobileTextareaRef.current;
    if (mobile) {
      mobile.style.height = 'auto';
      mobile.style.height = `${mobile.scrollHeight}px`;
    }
  }, [text, composerExtra]);

  const [hostSkillsOff, setHostSkillsOff] = useState(false);
  const canAttach = profileAcceptsImages(selectedProfile);

  useEffect(() => {
    if (!selectedProfile?.agentType) {
      setCommands([]);
      return;
    }
    let stale = false;
    setCommands([]);
    setHostSkillsOff(false);
    void api.listCommandsWithStatus(selectedProfile.agentType, projectId)
      .then((r) => { if (!stale) { setCommands(r.commands); setHostSkillsOff(r.hostOffline); } })
      .catch(() => { if (!stale) setCommands([]); });
    return () => { stale = true; };
  }, [selectedProfile?.agentType, projectId]);

  useEffect(() => {
    if (!projectId || projectId === REMOTE_AGENTS_PROJECT_ID || selectedProfile?.agentType === 'grok-bot') {
      setShellAllow([]);
      return;
    }
    void api.getShellAllow(projectId)
      .then(({ base, project }) => {
        const rules: ShellRule[] = [
          ...base.map((r) => ({ label: r.join(' '), source: 'base' as const })),
          ...project.map((p) => ({ label: p.rule.join(' '), source: 'project' as const })),
        ];
        setShellAllow(rules);
      })
      .catch(() => setShellAllow([]));
  }, [projectId, selectedProfile?.agentType]);

  const handleSend = useCallback(() => {
    const t = text.trim();
    if (!t || !selectedProfile) return;
    const replacingQueue = Boolean(editingQueueId && onEditSteer && steerQueue.some((q) => q.id === editingQueueId));
    // ponytail: /btw is a client-side side channel — never dispatched to the
    // agent and never steered into a running turn. Intercept before the
    // isRunning/onSteer branch below, which would otherwise route `/btw …` into
    // the live agent as a steer. Same prefix test as parseSlashCommand in App.tsx,
    // kept inline here so InputBar doesn't need to import the parser; full slash
    // handling for every other command stays in App.tsx's handleSend.
    // Skip while replacing a queued item — that send must stay in queue order.
    if (!replacingQueue && onBtwQuestion && (t === '/btw' || t.startsWith('/btw '))) {
      const question = t.slice('/btw'.length).trim();
      if (question) {
        onBtwQuestion(question);
        clearAfterDispatch();
      }
      return;
    }
    // ponytail: '!' is the operator-shell side channel — like /btw, intercept BEFORE the
    // isRunning/onSteer branch so it never steers the live agent. Fire-and-forget: the
    // result card arrives via the WS EventFrame the server broadcasts (recordShellTurn),
    // so no local rendering/callback is needed. Refusals also come back as cards over WS.
    if (!replacingQueue && conversationId && t !== '!' && t.startsWith('!')) {
      const command = t.replace(/^!\s*/, '');
      if (command) {
        void api.runShell(conversationId, command).catch(() => {});
        clearAfterDispatch();
      }
      return;
    }
    void (async () => {
      let atts;
      try {
        atts = await resolveAttachmentsForSend(attachments, conversationId);
      } catch (e) {
        setAlertModal(`Attachment error: ${e instanceof Error ? e.message : e}`);
        return;
      }
      const slash = t.startsWith('/') ? (() => {
        const body = t.slice(1).trim();
        if (!body) return undefined;
        const [name, ...rest] = body.split(/\s+/);
        if (!name) return undefined;
        const args = rest.join(' ').trim();
        return args ? { name, args } : { name };
      })() : undefined;
      if (replacingQueue && editingQueueId && onEditSteer) {
        onEditSteer(editingQueueId, t, atts, slash);
        setEditingQueueId(null);
        preEditRef.current = null;
      } else if (isRunning && onSteer) {
        if (pendingSessionAction === 'fresh') {
          // New-session intent: always queue as its own turn — never inject, never modal.
          if (onSteer(t, atts, 'queue', slash, 'fresh') === false) return;
          clearAfterDispatch();
          return;
        }
        // Mid-turn slash → structured command fields so drain uses handleCommand
        // (not plain handlePrompt). /btw already intercepted above.
        const cls = steerClass(selectedProfile.agentType, !!selectedProfile.steer);
        if (cls === 'force') {
          // Keep text in the box until the modal resolves; clear only on confirm.
          setPendingSteer({ text: t, attachments: atts, command: slash });
          setSteerChoiceOpen(true);
          return;
        }
        if (onSteer(t, atts, cls === 'live' ? 'auto' : 'queue', slash) === false) return;
      } else {
        // false = App stashed a handoff modal (or refused). Keep the composer
        // so Cancel can leave the prompt in the box — same as force-steer.
        if (onSend(t, selectedProfile.id, selectedProfile.agentType, selectedProfile.model, atts) === false) return;
      }
      clearAfterDispatch();
    })();
  }, [text, selectedProfile, attachments, onSend, onSteer, onEditSteer, isRunning, onBtwQuestion, conversationId, editingQueueId, steerQueue, clearAfterDispatch, pendingSessionAction]);

  const clearAfterSteerConfirm = useCallback(() => {
    setPendingSteer(null);
    setSteerChoiceOpen(false);
    clearAfterDispatch();
  }, [clearAfterDispatch]);

  const handleSteerChoiceQueue = useCallback(() => {
    if (!pendingSteer || !onSteer) return;
    if (onSteer(pendingSteer.text, pendingSteer.attachments, 'queue', pendingSteer.command) === false) {
      setSteerChoiceOpen(false);
      setPendingSteer(null);
      return;
    }
    clearAfterSteerConfirm();
  }, [pendingSteer, onSteer, clearAfterSteerConfirm]);

  const handleSteerChoiceForce = useCallback(() => {
    if (!pendingSteer || !onSteer) return;
    if (onSteer(pendingSteer.text, pendingSteer.attachments, 'force', pendingSteer.command) === false) {
      setSteerChoiceOpen(false);
      setPendingSteer(null);
      return;
    }
    clearAfterSteerConfirm();
  }, [pendingSteer, onSteer, clearAfterSteerConfirm]);

  const handleSteerChoiceCancel = useCallback(() => {
    setSteerChoiceOpen(false);
    setPendingSteer(null);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (commandPickerRef.current?.handleKeyDown(e)) return;
    if (shellPickerRef.current?.handleKeyDown(e)) return;   // only one picker is ever open (prefix is / xor !)
    if (e.key === 'Escape' && editingQueueId) {
      e.preventDefault();
      cancelQueueEdit();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, editingQueueId, cancelQueueEdit]);

  const handleAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1] ?? '';
        setAttachments(prev => [...prev, { base64, mediaType: file.type, name: file.name }]);
      };
      reader.readAsDataURL(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  // ponytail: any-file variant — same logic, separate input node so the accept
  // filter doesn't constrain what the OS picker shows.
  const handleAnyAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1] ?? '';
        // ponytail: empty MIME from OS → best-effort sniff from extension
        const mediaType = sniffAttachmentMediaType(file.type, file.name);
        setAttachments(prev => [...prev, { base64, mediaType, name: file.name }]);
      };
      reader.readAsDataURL(file);
    }
    if (anyFileInputRef.current) anyFileInputRef.current.value = '';
  }, []);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const handleAnnotatorSave = useCallback((att: { base64: string; mediaType: string; name?: string }, imgIdx: number) => {
    setAttachments(prev => {
      // imgIdx is the position within image-only attachments; map back to full array index.
      const imageOriginalIndices = prev.reduce<number[]>((acc, a, i) => {
        if (a.mediaType.startsWith('image/')) acc.push(i);
        return acc;
      }, []);
      const originalIdx = imageOriginalIndices[imgIdx] ?? annotateIdx;
      return prev.map((a, i) => i === originalIdx
        ? { base64: att.base64, mediaType: att.mediaType, name: att.name ?? a.name, localPath: undefined }
        : a);
    });
    setAnnotateIdx(null);
  }, [annotateIdx]);

  // ponytail: lifted MIME restriction — attach-via-URL now works for any file
  // the server can fetch; adapter-side handling of non-image base64 is still
  // per-adapter (see adapter_image_path_reference.md).
  const fetchToAttachment = useCallback(async (url: string, fallbackName: string) => {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`fetch -> ${r.status}`);
    const blob = await r.blob();
    const mediaType = blob.type || 'application/octet-stream';
    const base64 = await blobToBase64(blob);
    if (!base64) throw new Error('empty file');
    addAttachment({ base64, mediaType, name: fallbackName });
  }, [addAttachment]);

  // Path paste — fetch immediately so the thumbnail uses base64, not a second
  // /files request that can fail silently on the <img> tag.
  const attachImagePathFromPaste = useCallback(async (candidate: string): Promise<boolean> => {
    const trimmed = candidate.trim();
    if (!trimmed || /\n/.test(trimmed)) {
      return false;
    }

    const path = normalizePastedPath(trimmed);
    const fallbackName = (path.split(/[\\/]/).pop() ?? 'file').split(/[?#]/)[0] ?? 'file';
    const ext = fallbackName.includes('.') ? (fallbackName.split('.').pop()?.toLowerCase() ?? '') : '';
    if (!isImageExtension(ext)) {
      return false;
    }

    const url = fileUrl(path, conversationId);
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) {
        return false;
      }
      const blob = await r.blob();
      const base64 = await blobToBase64(blob);
      if (!base64) {
        return false;
      }
      const mediaType = blob.type.startsWith('image/')
        ? blob.type
        : imageMediaTypeFromName(fallbackName);
      addAttachment({ base64, mediaType, name: fallbackName });
      return true;
    } catch {
      return false;
    }
  }, [conversationId, addAttachment]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const imagePaths = imagePathCandidatesFromClipboard(e.clipboardData);
    if (imagePaths.length > 0) {
      e.preventDefault();
      for (const candidate of imagePaths) {
        void attachImagePathFromPaste(candidate).then((ok) => {
          if (!ok) setText((cur) => {
            const next = cur ? `${cur}\n${candidate}` : candidate;
            if (conversationId && !isScheduleHome) scheduleSave(conversationId, next);
            return next;
          });
        });
      }
      return;
    }

    // File-manager copies (Copy in Nautilus/Files) expose the bytes only via
    // DataTransferItem.getAsFile(); getData('text/…') returns "" for them.
    // They also commonly report an empty or octet-stream MIME, so match by
    // filename extension as well. Runs unconditionally — same reasoning as the
    // path branch (image attachment is a user action, not a profile feature).
    for (const item of e.clipboardData.items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      const ext = (file.name.split('.').pop() ?? '').toLowerCase();
      const isImage = file.type.startsWith('image/') || isImageExtension(ext);
      if (!isImage) continue;
      // Skip tiny file-manager icon blobs; the real screenshot is hundreds of KB.
      if (file.size < 512) continue;
      e.preventDefault();
      void blobToBase64(file).then((base64) => {
        if (!base64) {
          return;
        }
        addAttachment({
          base64,
          mediaType: file.type || imageMediaTypeFromName(file.name),
          name: file.name || 'pasted-image.png',
        });
      });
      return;
    }
  }, [canAttach, addAttachment, attachImagePathFromPaste]);

  const [urlInput, setUrlInput] = useState('');
  const submitUrl = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;
    setUrlModalOpen(false);
    setUrlInput('');
    // ponytail: route through server-side /proxy to avoid browser CORS; direct fetch to remote URL fails (NetworkError).
    try { await fetchToAttachment(`/proxy?url=${encodeURIComponent(url)}`, url.split('/').pop() || 'file'); }
    catch (e) { setAlertModal(`Could not load file: ${e instanceof Error ? e.message : e}`); }
  }, [urlInput, fetchToAttachment]);

  const closeMobileSheet = () => setMobileOpen(false);

  // Keep the mobile overlay inside the visual viewport so the send row sits
  // above the soft keyboard instead of under it.
  useEffect(() => {
    if (!mobileOpen) return;
    const el = mobileOverlayRef.current;
    const vv = window.visualViewport;
    if (!el || !vv) return;
    const sync = () => {
      el.style.top = `${vv.offsetTop}px`;
      el.style.height = `${vv.height}px`;
      el.style.bottom = 'auto';
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      el.style.top = '';
      el.style.height = '';
      el.style.bottom = '';
    };
  }, [mobileOpen]);

  const handleCommandSelect = useCallback((cmd: CommandRecord) => {
    const next = (selectedProfile?.agentType === 'pi' && cmd.sourceDetail === 'skill')
      ? `/skill:${cmd.name} `
      : `/${cmd.name} `;
    commitText(next);
  }, [selectedProfile?.agentType, commitText]);

  const handleShellSelect = useCallback((r: ShellRule) => {
    commitText(`!${r.label} `);
  }, [commitText]);

  const attachTitle = canAttach
    ? 'Attach image'
    : `${selectedProfile?.label ?? 'This agent'} does not support image attachments`;

  const slashSupported = agentSupportsSlashCommands(selectedProfile?.agentType);
  const promptPlaceholder = slashSupported ? 'Message or /command… or !shell-command' : 'Message…';

  // While running, the model dropdown is locked (you can't switch mid-turn) but
  // the textarea/send stay live for steering. `inputLocked` covers the genuine
  // disable reasons (no conversation, handoff modal) passed in via `disabled`,
  // plus grok-bot-disabled composer lock. The picker stays independent of that
  // grok lock so a grok-last-session chat can be switched to another agent.
  // Freeze while the server holds the composer (transcribe or enhance) so a
  // reload cannot type into a Slow-Yes raw stash before the rewrite lands.
  const processingLocked = remoteProcessing === 'enhancing' || remoteProcessing === 'transcribing';
  const inputLocked = disabled || grokBotInputDisabled || processingLocked;
  const pickerLocked = disabled || processingLocked;
  const processingLabel = remoteProcessing === 'enhancing'
    ? 'Enhancing on the server…'
    : remoteProcessing === 'transcribing'
      ? 'Transcribing on the server…'
      : undefined;
  const enhancing = remoteProcessing === 'enhancing';
  // Same banner in the desktop bar and the mobile sheet — a failure on a phone
  // was previously invisible. Click to dismiss.
  const enhanceErrorBanner = enhanceError ? (
    <div
      role="alert"
      onClick={() => setEnhanceError(null)}
      title="Dismiss"
      style={{
        color: 'var(--amber, #f59e0b)', fontSize: '0.85rem',
        padding: '0.25rem 0.5rem', cursor: 'pointer',
      }}
    >
      Enhance failed: {enhanceError} ✕
    </div>
  ) : null;
  const timerChips = pendingTimers.length > 0 ? (
    <div className="timer-chips">
      {pendingTimers.map((t) => {
        const badge = timerOriginBadge(t.origin);
        return (
        <div key={t.id} className="timer-chip">
          {badge ? (
            <span className="timer-chip-origin" title={badge.title}>{badge.label}</span>
          ) : null}
          <button
            type="button"
            className="timer-chip-text"
            title={[t.prompt, ...t.attachmentNames, '', 'Click to edit · × to delete'].join('\n')}
            onClick={() => setEditingTimer(t)}
          >
            {countdownLabel(t.fireAtMs - nowMs)}
            {' · '}
            {profiles.find((p) => p.id === t.profileId)?.label ?? t.profileId}
            {t.attachmentNames.length > 0 ? ` · 📎${t.attachmentNames.length}` : ''}
            {' · '}
            {t.prompt.trim()}
          </button>
          <button
            type="button"
            className="timer-chip-cancel"
            title="Delete timer"
            onClick={() => setDeletingTimer(t)}
          >
            ×
          </button>
        </div>
        );
      })}
    </div>
  ) : null;
  const sessionActionLabel = pendingSessionAction === 'fresh'
    ? (isRunning ? '⟲ New session — queued after this turn' : '⟲ New session on next send')
    : pendingSessionAction === 'summary' ? '⇄ Handover (summary) on next send' : null;
  const sessionActionChip = sessionActionLabel && onSessionActionChange ? (
    <div className="timer-chips">
      <div className="timer-chip">
        <span className="timer-chip-text" style={{ cursor: 'default' }}>{sessionActionLabel}</span>
        <button
          type="button"
          className="timer-chip-cancel"
          aria-label="Clear pending session action"
          title="Clear pending session action"
          onClick={() => onSessionActionChange(null)}
        >
          ×
        </button>
      </div>
    </div>
  ) : null;
  const sendClass = selectedProfile
    ? steerClass(selectedProfile.agentType, !!selectedProfile.steer)
    : 'queue';
  const sendLabel = editingQueueId
    ? 'Update'
    : isRunning
    ? (pendingSessionAction === 'fresh' || sendClass === 'queue'
      ? (steerQueueLength > 0 ? `Queue (${steerQueueLength})` : 'Queue')
      : sendClass === 'live' ? 'Steer' : 'Steer…')
    : 'Send';
  const sendBtnLabel = armable ? (armed ? 'Auto-send ✓' : 'Auto-send') : sendLabel;
  const sendBtnTitle = armable
    ? (armed
      ? 'Auto-send armed — tap to cancel; transcript will send when ready'
      : 'Tap to auto-send this transcription when it finishes')
    : undefined;

  // Shared: the attach menu dropdown (used in both desktop and mobile sheet).
  const renderAttachMenu = (mobile: boolean) => menuOpen && (
    <div
      className="attach-menu"
      style={mobile && mobileMenuMaxHeight != null ? { maxHeight: `${mobileMenuMaxHeight}px` } : undefined}
    >
      <button
        className="attach-menu-item"
        title="Insert a saved prompt into the input"
        onClick={() => { setMenuOpen(false); setPromptCollectionOpen(true); }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <path d="M14 2v6h6"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <line x1="10" y1="9" x2="8" y2="9"/>
        </svg>
        Prompt Collection
      </button>
      <button
        className="attach-menu-item"
        title={text.trim() ? 'Save the current input text to the prompt collection' : 'Enter prompt text first to save to collection'}
        disabled={!text.trim()}
        onClick={() => { setMenuOpen(false); setSavePromptModalOpen(true); }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
          <polyline points="17 21 17 13 7 13 7 21"/>
          <polyline points="7 3 7 8 15 8"/>
        </svg>
        Save to Collection
      </button>

      {onBtw && (
        <span title={btwDisabledReason ?? 'Ask an ephemeral context-aware side question'} style={{ display: 'block' }}>
          <button
            className="attach-menu-item"
            disabled={!!btwDisabledReason}
            aria-disabled={!!btwDisabledReason}
            onClick={() => {
              if (btwDisabledReason) return;
              setMenuOpen(false);
              commitText('/btw ');
              setTimeout(() => (document.querySelector('.prompt-field') as HTMLTextAreaElement)?.focus(), 20);
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            Side Question (/btw)
          </button>
        </span>
      )}
      {promptOptionDescriptors.length > 0 && onPromptOptionsApply && (
        <PromptOptionsBadge
          descriptors={promptOptionDescriptors}
          options={promptOptions}
          count={promptOptionCount}
          error={promptOptionsError}
          sticky={promptOptionsSticky}
          asMenuItem
          disabled={inputLocked || isRunning}
          disabledReason={isRunning ? 'Options apply to a new turn — this message will be steered into the running one' : undefined}
          onOpenModal={() => { setMenuOpen(false); setPromptOptionsModalOpen(true); }}
          onClear={() => onPromptOptionsClear?.()}
        />
      )}
      {!isGrokBot && onPermissionModeChange && (
        <button
          type="button"
          className="attach-menu-item"
          title={`Permission mode: ${permissionMode ?? 'default'}`}
          onClick={() => {
            setMenuOpen(false);
            setPermissionModeModalOpen(true);
          }}
          disabled={inputLocked}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span>Permission Mode ({permissionMode ?? 'default'})</span>
        </button>
      )}
      {onOpenRules && (
        <button
          className="attach-menu-item"
          title="Configure operator rules and presets"
          onClick={() => { setMenuOpen(false); onOpenRules(); }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
          Rules…
        </button>
      )}
      {onSessionActionChange && (['fresh', 'summary'] as const).map((action) => {
        const blockedMidTurn = isRunning && action !== 'fresh';
        return (
          <button
            key={action}
            className="attach-menu-item"
            aria-pressed={pendingSessionAction === action}
            title={blockedMidTurn ? 'Available once the current turn finishes' : (action === 'fresh'
              ? (isRunning ? 'Queue the next message as a clean session after this turn'
                           : 'Next message starts a clean session (earlier turns stay in the transcript)')
              : 'Next message carries a summary of the conversation into a new session')}
            disabled={disabled || blockedMidTurn || sessionActionsDisabled}
            onClick={() => { setMenuOpen(false); onSessionActionChange(pendingSessionAction === action ? null : action); }}
            style={pendingSessionAction === action ? { fontWeight: 600 } : undefined}
          >
            {action === 'fresh' ? '⟲ New session' : '⇄ Handover (summary)'}
          </button>
        );
      })}
      <button
        className="attach-menu-item"
        title={attachTitle}
        disabled={!canAttach}
        onClick={() => { setMenuOpen(false); fileInputRef.current?.click(); }}
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M13 7.5L7.5 13A4.5 4.5 0 0 1 1 6.5l5.5-5.5a3 3 0 0 1 4.24 4.24L5.5 10.5a1.5 1.5 0 0 1-2.12-2.12L8 3.75"/>
        </svg>
        Attach image
      </button>
      <button
        className="attach-menu-item"
        title="Attach any file"
        onClick={() => { setMenuOpen(false); anyFileInputRef.current?.click(); }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <path d="M14 2v6h6"/>
        </svg>
        Attach file
      </button>
      <button
        className="attach-menu-item"
        onClick={() => { setMenuOpen(false); setUrlModalOpen(true); }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
        Add URL
      </button>
      {micSupported && (
        <button
          className="attach-menu-item"
          disabled={remoteProcessing !== 'idle'}
          title={remoteProcessing !== 'idle' ? 'Composer is busy (transcribing/enhancing) — tap the voice strip to cancel' : undefined}
          onClick={() => { setMenuOpen(false); handleMicClick(); }}
          style={listening ? { color: 'var(--red, #ef4444)' } : undefined}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="11" rx="3"/>
            <path d="M5 10a7 7 0 0 0 14 0M12 17v4"/>
          </svg>
          {listening ? 'Stop dictation' : 'Microphone'}
        </button>
      )}
      {micError && (
        <div className="attach-menu-item" style={{ color: 'var(--amber, #f59e0b)', cursor: 'default' }}>
          {micError}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div
        className={`input-bar${resizeDragging ? ' is-resizing' : ''}`}
        style={{
          ['--composer-extra' as string]: `${composerExtra}px`,
          ['--queue-extra' as string]: `${Math.round(composerExtra * 0.3)}px`,
          ['--composer-cap' as string]: `${composerCap}px`,
        }}
        onClickCapture={(e) => {
          if (isSidebarOpen && onCloseSidebar) {
            e.stopPropagation();
            onCloseSidebar();
          }
        }}
      >
        {draftSaveWarning && (
          <div role="status" style={{ color: 'var(--amber, #f59e0b)', fontSize: '0.85rem', padding: '0.25rem 0.5rem' }}>
            {draftSaveWarning}
          </div>
        )}
        {grokBotBanner && (
          <div
            className={`composer-banner ${grokBotBanner.severity === 'error' ? 'warning' : ''}`}
            role="status"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              color: grokBotBanner.severity === 'error' ? 'var(--red, #ef4444)'
                : grokBotBanner.severity === 'warn' ? 'var(--amber, #f59e0b)'
                : grokBotBanner.severity === 'muted' ? 'var(--text-muted, #888)'
                : 'inherit',
            }}
          >
            <span>
              {grokBotBanner.spinner ? '⏳ ' : ''}
              {grokBotBanner.text}
            </span>
            {grokBotBanner.action && onGrokBotAction && (
              <button type="button" className="ghost-btn" style={{ padding: '2px 6px', fontSize: 12, textDecoration: 'underline', background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit' }} onClick={onGrokBotAction}>
                {grokBotBanner.action === 'retry' ? 'Retry' : 'Start'}
              </button>
            )}
          </div>
        )}
        {enhanceErrorBanner}
        {sessionActionChip}
        {timerChips}
        {steerQueue.length > 0 && (
          <div className="steer-queue-container">
            <div className="steer-queue-header">
              <span>Pending Messages ({steerQueue.length})</span>
              {editingQueueId && <span className="steer-queue-editing-hint">Editing — send to update</span>}
            </div>
            <div className="steer-queue-list">
              {steerQueue.map((q) => (
                <div
                  key={q.id}
                  className={`steer-queue-item${editingQueueId === q.id ? ' is-editing' : ''}`}
                  role="button"
                  tabIndex={0}
                  title="Edit queued message"
                  onClick={() => beginQueueEdit(q)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); beginQueueEdit(q); }
                  }}
                >
                  <span className={`steer-queue-badge ${q.source === 'force' ? 'force' : q.type}`}>
                    {q.source === 'force' ? 'Interrupt & Send' : q.type === 'steer' ? 'Steer' : 'Queue'}
                  </span>
                  {q.handoffOverride === 'fresh' && <span className="steer-queue-badge queue">⟲ New session</span>}
                  {q.attachments && q.attachments.length > 0 && (
                    <div className="steer-queue-attachments">
                      {q.attachments.map((a, idx) => {
                        const isImage = a.mediaType.startsWith('image/');
                        if (isImage && a.base64) {
                          const src = a.base64.startsWith('data:')
                            ? a.base64
                            : `data:${a.mediaType};base64,${a.base64}`;
                          return (
                            <img
                              key={idx}
                              src={src}
                              alt={a.name ?? 'attachment'}
                              title={a.name ?? 'attachment'}
                              className="steer-queue-thumb"
                            />
                          );
                        }
                        return (
                          <span key={idx} className="steer-queue-file-chip" title={a.name ?? 'attachment'}>
                            📎 {a.name ?? 'file'}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <span className="steer-queue-text" title={q.text}>
                    {q.text || (q.attachments?.length ? '(attachment)' : '')}
                  </span>
                  <button
                    className="steer-queue-cancel-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (editingQueueId === q.id) {
                        setEditingQueueId(null);
                        preEditRef.current = null;
                      }
                      onCancelSteer?.(q.id);
                    }}
                    title="Cancel/Remove message"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {showResizeHandle && (
          <div
            className={`input-resize-handle input-resize-handle-desktop is-enabled${resizeDragging ? ' is-dragging' : ''}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize input"
            title="Drag up to expand, down to shrink"
            onPointerDown={onResizePointerDown}
          >
            <span className="input-resize-grip" />
          </div>
        )}
        {(voiceVisible || dictationPopupOpen) && (
          <div
            className={`voice-feedback-strip${voiceVisible ? ' is-live' : ' has-picker'}${voiceInteractive ? ' is-interactive' : ''}`}
            // Live dictation is tap-to-stop/cancel. role="status" remains for a
            // non-interactive visible strip (none today; keep for the picker→live handoff).
            role={voiceInteractive ? 'button' : (voiceVisible ? 'status' : undefined)}
            tabIndex={voiceInteractive ? 0 : undefined}
            title={voiceInteractive
              ? (strip.mode === 'processing' ? 'Tap to cancel dictation' : 'Tap to stop dictation')
              : (voiceVisible ? 'Transcribing on the server…' : undefined)}
            aria-label={voiceInteractive
              ? (strip.mode === 'processing' ? 'Cancel dictation' : 'Stop dictation')
              : (voiceVisible ? 'Transcribing on the server' : undefined)}
            onClick={voiceInteractive ? stopDictation : undefined}
            onKeyDown={voiceInteractive ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stopDictation(); }
            } : undefined}
          >
            {voiceVisible
              ? (
                <VoiceFeedbackVisual
                  visual={strip.mode === 'processing' ? processingVisual : detectionVisual}
                  waveStyle={waveStyle}
                  reactive={strip.reactive}
                  getMicLevel={getMicLevel}
                />
              )
              : (
                <div className="dictation-picker">
                  <DictationModeStrip onCommit={commitDictation} />
                </div>
              )}
          </div>
        )}
        {/* Desktop input controls — hidden on mobile */}
        <div className="input-controls input-controls-desktop">
          {isRemoteAgents ? (
            <div className="remote-agent-badge" title={`Grok Bot · ${botName}`}>
              <span className="remote-agent-badge-label">Grok Bot · {botName}</span>
            </div>
          ) : (
            <ModelSelector
              profiles={profiles}
              profilesLoaded={profilesLoaded}
              selectedProfileId={selectedProfile?.id ?? ''}
              onChange={onProfileChange}
              disabled={pickerLocked || isRunning}
              persistQuery
              unavailable={unavailable}
            />
          )}
          {effortLevels.length > 0 && onEffortChange && (effectiveEffort || effort === 'off') && (
            <EffortPill
              levels={effortLevels}
              value={effectiveEffort ?? 'off'}
              sessionState={effortSessionState}
              disabled={inputLocked || isRunning}
              onChange={onEffortChange}
            />
          )}
          {!isGrokBot && onSandboxChange && (
            <SandboxPill
              state={sandboxState ?? null}
              value={sandbox ?? null}
              disabled={inputLocked}
              onChange={onSandboxChange}
            />
          )}
          <McpStatusChip
            conversationId={conversationId}
            agentType={(hasLiveSession ? liveAgentType : undefined) ?? selectedProfile?.agentType ?? liveAgentType}
            profileId={selectedProfile?.id}
            projectId={projectId}
            hasLiveSession={hasLiveSession ?? (isRunning || Boolean(effortSessionState === 'active'))}
            disabled={inputLocked}
            onMcpServersChange={onMcpServersChange}
          />
        </div>
        {attachments.length > 0 && (
          <div className="attach-strip attach-strip-desktop">
            {attachments.map((a, i) => {
              const isImage = a.mediaType.startsWith('image/');
              return (
                <div key={i} className={`attach-thumb-wrap${isImage ? '' : ' is-file'}`} title={a.name}>
                  {isImage ? (
                    <img
                      className="attach-thumb"
                      src={attachmentPreviewSrc(a, conversationId)}
                      alt={a.name ?? 'attachment'}
                      onClick={() => setAnnotateIdx(i)}
                      style={{ cursor: 'pointer' }}
                    />
                  ) : (
                    <div className="attach-file-chip" onClick={() => {/* no preview yet */}}>
                      <span className="attach-file-icon">📄</span>
                      <span className="attach-file-name">{a.name}</span>
                    </div>
                  )}
                  {isImage && (
                    <button
                      className="attach-thumb-remove"
                      type="button"
                      aria-label={`Annotate ${a.name ?? 'attachment'}`}
                      title="Annotate"
                      onClick={() => setAnnotateIdx(i)}
                    >
                      ✎
                    </button>
                  )}
                  <button
                    className="attach-thumb-remove"
                    type="button"
                    aria-label={`Remove ${a.name ?? 'attachment'}`}
                    onClick={() => removeAttachment(i)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {onOpenFile && (
          <TextPathStrip
            text={text}
            onOpen={onOpenFile}
            conversationId={conversationId}
            className="text-path-strip-desktop"
          />
        )}
        <div className="input-row input-row-desktop">
          <div className="prompt-field-wrap">
            <CommandPicker
              ref={commandPickerRef}
              agentType={selectedProfile?.agentType ?? ''}
              text={text}
              commands={commands}
              notice={hostSkillsOff ? 'Remote host unreachable - skills unavailable' : undefined}
              onSelect={handleCommandSelect}
            />
            <ShellCommandPicker
              ref={shellPickerRef}
              text={text}
              rules={shellAllow}
              onSelect={handleShellSelect}
            />
            <textarea
              ref={textareaRef}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; lastLocalEditAtRef.current = Date.now(); }}
              className={`prompt-field${inputLocked ? ' prompt-field--locked' : ''}`}
              placeholder={promptPlaceholder}
              value={text}
              title={processingLabel}
              aria-label={processingLabel ?? promptPlaceholder}
              onChange={(e) => {
                discardRemoteTextRef.current = false;
                clearEnhanceStash();
                setText(e.target.value);
                scheduleSave(conversationId!, e.target.value);
              }}
              onBlur={flushPendingSave}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              readOnly={inputLocked}
              rows={1}
            />
          </div>
          {/* Outside the field — never overlays typed text (desktop only; mobile uses Option C footer tray). */}
          {(enhanceConfigured || enhanceProject.configured || Boolean(conversationId) || Boolean(text)) && (
            <div className="prompt-side-actions">
              {(enhanceConfigured || enhanceProject.configured) && (
                <div className="enhance-btn-wrap">
                  <button
                    type="button"
                    className={`enhance-btn${enhancing ? ' is-enhancing' : ''}`}
                    aria-label="Enhance prompt"
                    title="Enhance prompt"
                    disabled={inputLocked || !text.trim()}
                    onClick={() => setEnhancePopupOpen((o) => !o)}
                  >
                    {enhancing ? '…' : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>
                      </svg>
                    )}
                  </button>
                  {enhancePopupOpen && (
                    <EnhanceModePopup
                      quickAvailable={enhanceConfigured}
                      contextAvailable={Boolean(conversationId)}
                      projectAvailable={enhanceProject.configured && Boolean(conversationId)}
                      onPick={(mode) => { void handleEnhancePick(mode); }}
                    />
                  )}
                </div>
              )}
              {Boolean(conversationId) && (
                <button
                  type="button"
                  className="prompt-timer-btn"
                  aria-label="Prompt timer"
                  title={
                    !conversationId ? 'Open a conversation first'
                    : !selectedProfileId ? 'Select an agent profile first'
                    : !text.trim() ? 'Type the prompt in the composer first'
                    : 'Send this prompt into this conversation later'
                  }
                  disabled={!text.trim() || !conversationId || !selectedProfileId}
                  onClick={() => setTimerModalOpen(true)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                </button>
              )}
              {text && (
                <button
                  className={`prompt-clear-btn${canUndoEnhance ? ' is-undo' : ''}`}
                  type="button"
                  aria-label={canUndoEnhance ? 'Undo enhance' : 'Clear prompt'}
                  title={canUndoEnhance ? 'Undo enhance' : 'Clear prompt'}
                  onClick={() => { void handleClearOrUndo(); }}
                >
                  {canUndoEnhance ? (
                    <svg className="prompt-undo-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 10h10a5 5 0 0 1 0 10H9" />
                      <path d="M3 10l4-4" />
                      <path d="M3 10l4 4" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  )}
                </button>
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleAttach}
          />
          <input
            ref={anyFileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleAnyAttach}
          />
          <div className="attach-menu-wrap" ref={desktopMenuRef}>
            <button
              className={`attach-btn${attachSwiping ? ' swiping' : ''}`}
              title={micSupported ? 'Tap to add, swipe up for mic' : 'Add'}
              onClick={onAttachClick}
              onTouchStart={onAttachTouchStart}
              onTouchMove={onAttachTouchMove}
              onTouchEnd={onAttachTouchEnd}
              disabled={disabled}
              style={listening ? { color: 'var(--red, #ef4444)' } : undefined}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </button>
            {renderAttachMenu(false)}
          </div>
          <button
            className={`send-btn${armable && armed ? ' auto-send-armed' : ''}`}
            onClick={armable ? toggleArm : handleSend}
            disabled={armable ? false : (inputLocked || !text.trim())}
            title={sendBtnTitle}
          >
            {sendBtnLabel}
          </button>
          {(showStop || wrappingUp) && (
            <button
              className={`stop-btn${showStop ? '' : ' wrapping-up'}`}
              onClick={onStop}
              disabled={stopDisabled}
              title={showStop ? 'Stop generation' : 'Wrapping up — click to force stop'}
            >
              Stop
            </button>
          )}
        </div>

        {/* Mobile compact trigger — hidden on desktop */}
        <button
          className="mobile-input-trigger"
          onClick={() => {
            if (isSidebarOpen && onCloseSidebar) {
              onCloseSidebar();
              return;
            }
            setMobileOpen(true);
          }}
          disabled={disabled}
        >
          <span className="mobile-trigger-agent">{selectedProfile?.label ?? 'Loading'}</span>
          {promptOptionCount > 0 && (
            <span className="mobile-trigger-options-tag" title="Prompt options staged">
              ⚡ {promptOptionCount}
            </span>
          )}
          <span className="mobile-trigger-hint">{text || promptPlaceholder}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 2L11 13M22 2 15 22 11 13 2 9l20-7z"/>
          </svg>
        </button>
      </div>

      {/* Mobile bottom sheet — portalled via fixed positioning */}
      {mobileOpen && (
        <div className="mobile-input-overlay" ref={mobileOverlayRef} onClick={closeMobileSheet}>
          <div
            className={`mobile-input-sheet${resizeDragging ? ' is-resizing' : ''}`}
            ref={mobileSheetRef}
            style={{
              ['--composer-extra' as string]: `${composerExtra}px`,
              ['--queue-extra' as string]: `${Math.round(composerExtra * 0.3)}px`,
              ['--composer-cap' as string]: `${composerCap}px`,
            }}
            onClick={e => e.stopPropagation()}
          >
            {showResizeHandle && (
              <div
                className={`input-resize-handle input-resize-handle-mobile is-enabled${resizeDragging ? ' is-dragging' : ''}`}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize input"
                title="Drag up to expand, down to shrink"
                onPointerDown={onResizePointerDown}
              >
                <span className="input-resize-grip" />
              </div>
            )}
            {(voiceVisible || dictationPopupOpen) && (
              <div
                className={`voice-feedback-mobile${voiceVisible ? ' is-live' : ' has-picker'}${voiceInteractive ? ' is-interactive' : ''}`}
                role={voiceInteractive ? 'button' : (voiceVisible ? 'status' : undefined)}
                tabIndex={voiceInteractive ? 0 : undefined}
                title={voiceInteractive
                  ? (strip.mode === 'processing' ? 'Tap to cancel dictation' : 'Tap to stop dictation')
                  : (voiceVisible ? 'Transcribing on the server…' : undefined)}
                aria-label={voiceInteractive
                  ? (strip.mode === 'processing' ? 'Cancel dictation' : 'Stop dictation')
                  : (voiceVisible ? 'Transcribing on the server' : undefined)}
                onClick={voiceInteractive ? stopDictation : undefined}
                onKeyDown={voiceInteractive ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stopDictation(); }
                } : undefined}
              >
                {voiceVisible
                  ? (
                    <VoiceFeedbackVisual
                      visual={strip.mode === 'processing' ? processingVisual : detectionVisual}
                      waveStyle={waveStyle}
                      height={24}
                      reactive={strip.reactive}
                      getMicLevel={getMicLevel}
                    />
                  )
                  : (
                    <div className="dictation-picker">
                      <DictationModeStrip onCommit={commitDictation} />
                    </div>
                  )}
              </div>
            )}

            <div className="mobile-sheet-header optC-top-bar">
              <div className="mobile-sheet-header-main">
                {isRemoteAgents ? (
                  <div className="remote-agent-badge" title={`Grok Bot · ${botName}`}>
                    <span className="remote-agent-badge-label">Grok Bot · {botName}</span>
                  </div>
                ) : (
                  <ModelSelector
                    profiles={profiles}
                    profilesLoaded={profilesLoaded}
                    selectedProfileId={selectedProfile?.id ?? ''}
                    onChange={onProfileChange}
                    disabled={pickerLocked || isRunning}
                    persistQuery
                    unavailable={unavailable}
                  />
                )}
                {effortLevels.length > 0 && onEffortChange && (effectiveEffort || effort === 'off') && (
                  <EffortPill
                    levels={effortLevels}
                    value={effectiveEffort ?? 'off'}
                    sessionState={effortSessionState}
                    disabled={inputLocked || isRunning}
                    onChange={onEffortChange}
                  />
                )}
                {!isGrokBot && onSandboxChange && (
                  <SandboxPill
                    state={sandboxState ?? null}
                    value={sandbox ?? null}
                    disabled={inputLocked}
                    onChange={onSandboxChange}
                  />
                )}
              </div>
              <div className="optC-top-right">
                <button
                  type="button"
                  className="optC-pill-btn optC-close-btn"
                  onClick={closeMobileSheet}
                  aria-label="Close sheet"
                  title="Close sheet"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>

            {attachments.length > 0 && (
              <div className="attach-strip">
                {attachments.map((a, i) => {
                  const isImage = a.mediaType.startsWith('image/');
                  return (
                    <div key={i} className={`attach-thumb-wrap${isImage ? '' : ' is-file'}`} title={a.name}>
                      {isImage ? (
                        <img
                          className="attach-thumb"
                          src={attachmentPreviewSrc(a, conversationId)}
                          alt={a.name ?? 'attachment'}
                          onClick={() => setAnnotateIdx(i)}
                          style={{ cursor: 'pointer' }}
                        />
                      ) : (
                        <div className="attach-file-chip">
                          <span className="attach-file-icon">📄</span>
                          <span className="attach-file-name">{a.name}</span>
                        </div>
                      )}
                      {isImage && (
                        <button
                          className="attach-thumb-remove"
                          type="button"
                          aria-label={`Annotate ${a.name ?? 'attachment'}`}
                          title="Annotate"
                          onClick={() => setAnnotateIdx(i)}
                        >
                          ✎
                        </button>
                      )}
                      <button
                        className="attach-thumb-remove"
                        type="button"
                        aria-label={`Remove ${a.name ?? 'attachment'}`}
                        onClick={() => removeAttachment(i)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {onOpenFile && (
              <TextPathStrip
                text={text}
                onOpen={onOpenFile}
                conversationId={conversationId}
              />
            )}

            {enhanceErrorBanner}
            {sessionActionChip}
            {timerChips}
            <div className="mobile-sheet-field optC-textarea-card">
              <CommandPicker
                ref={commandPickerRef}
                agentType={selectedProfile?.agentType ?? ''}
                text={text}
                commands={commands}
                notice={hostSkillsOff ? 'Remote host unreachable - skills unavailable' : undefined}
                onSelect={handleCommandSelect}
              />
              <ShellCommandPicker
                ref={shellPickerRef}
                text={text}
                rules={shellAllow}
                onSelect={handleShellSelect}
              />
              {text && (
                <button
                  type="button"
                  className={`optC-inline-clear${canUndoEnhance ? ' is-undo' : ''}`}
                  onClick={() => { void handleClearOrUndo(); }}
                  aria-label={canUndoEnhance ? 'Undo enhance' : 'Clear prompt'}
                  title={canUndoEnhance ? 'Undo enhance' : 'Clear prompt'}
                >
                  {canUndoEnhance ? (
                    <svg className="prompt-undo-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 10h10a5 5 0 0 1 0 10H9" />
                      <path d="M3 10l4-4" />
                      <path d="M3 10l4 4" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  )}
                </button>
              )}
              <textarea
                ref={mobileTextareaRef}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; lastLocalEditAtRef.current = Date.now(); }}
                className={`prompt-field mobile-sheet-textarea optC-textarea${text ? ' prompt-field--has-text' : ''}${inputLocked ? ' prompt-field--locked' : ''}`}
                placeholder={promptPlaceholder}
                value={text}
                title={processingLabel}
                aria-label={processingLabel ?? promptPlaceholder}
                onChange={(e) => {
                  discardRemoteTextRef.current = false;
                  clearEnhanceStash();
                  setText(e.target.value);
                  scheduleSave(conversationId!, e.target.value);
                }}
                onBlur={flushPendingSave}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                readOnly={inputLocked}
                rows={3}
              />
            </div>

            <div className="mobile-sheet-actions optC-footer">
              <div className="optC-quick-actions">
                <McpStatusChip
                  conversationId={conversationId}
                  agentType={(hasLiveSession ? liveAgentType : undefined) ?? selectedProfile?.agentType ?? liveAgentType}
                  profileId={selectedProfile?.id}
                  projectId={projectId}
                  hasLiveSession={hasLiveSession ?? (isRunning || Boolean(effortSessionState === 'active'))}
                  disabled={inputLocked}
                  compact
                  onMcpServersChange={onMcpServersChange}
                />

                {/* 2. Direct Enhance Button */}
                {(enhanceConfigured || enhanceProject.configured) && (
                  <div className="enhance-btn-wrap">
                    <button
                      type="button"
                      className={`optC-action-btn${enhancing ? ' is-enhancing' : ''}`}
                      title="Enhance prompt with sidecar"
                      disabled={inputLocked || !text.trim()}
                      onClick={() => setEnhancePopupOpen((o) => !o)}
                    >
                      {enhancing ? '…' : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>
                        </svg>
                      )}
                      <span>Enhance</span>
                    </button>
                    {enhancePopupOpen && (
                      <EnhanceModePopup
                        quickAvailable={enhanceConfigured}
                        contextAvailable={Boolean(conversationId)}
                        projectAvailable={enhanceProject.configured && Boolean(conversationId)}
                        onPick={(mode) => { void handleEnhancePick(mode); }}
                      />
                    )}
                  </div>
                )}

                {/* 3. Direct Timer Button */}
                <button
                  type="button"
                  className="optC-action-btn"
                  title={
                    !conversationId ? 'Open a conversation first'
                    : !selectedProfileId ? 'Select an agent profile first'
                    : !text.trim() ? 'Type the prompt in the composer first'
                    : 'Schedule prompt timer'
                  }
                  disabled={!text.trim() || !conversationId || !selectedProfileId}
                  onClick={() => setTimerModalOpen(true)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  <span>Timer</span>
                </button>

                {/* 4. More / Attach Menu Wrap (on left of send) */}
                <div className="optC-menu-wrap" ref={mobileMenuRef}>
                  <button
                    type="button"
                    className={`optC-action-btn${menuOpen ? ' active' : ''}${attachSwiping ? ' swiping' : ''}`}
                    title={micSupported ? 'Tap for menu, swipe up for mic' : 'More actions'}
                    onClick={onAttachClick}
                    onTouchStart={onAttachTouchStart}
                    onTouchMove={onAttachTouchMove}
                    onTouchEnd={onAttachTouchEnd}
                    disabled={disabled}
                    style={listening ? { color: 'var(--red, #ef4444)' } : undefined}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    <span>More</span>
                  </button>
                  {renderAttachMenu(true)}
                </div>
              </div>

              {/* Right cluster: Stop + Circular Send */}
              <div className="optC-footer-right">
                {(showStop || wrappingUp) && (
                  <button
                    type="button"
                    className={`stop-btn optC-stop-btn${showStop ? '' : ' wrapping-up'}`}
                    onClick={onStop}
                    disabled={stopDisabled}
                    title={showStop ? 'Stop generation' : 'Wrapping up — click to force stop'}
                  >
                    Stop
                  </button>
                )}
                <button
                  type="button"
                  className={`optC-send-circle${armable && armed ? ' auto-send-armed' : ''}`}
                  onClick={armable ? toggleArm : handleSend}
                  disabled={armable ? false : (inputLocked || !text.trim())}
                  title={sendBtnTitle}
                  aria-label="Send message"
                >
                  {armable && armed ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="22" y1="2" x2="11" y2="13"/>
                      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {annotateIdx !== null && attachments[annotateIdx] && (() => {
        // Build image-only list for prev/next navigation; find starting position.
        const imgAtts = attachments.map((a, i) => ({ ...a, origIdx: i })).filter(a => a.mediaType.startsWith('image/'));
        const initialPos = Math.max(0, imgAtts.findIndex(a => a.origIdx === annotateIdx));
        const imageList = imgAtts.map(a => ({
          src: attachmentPreviewSrc(a, conversationId),
          mediaType: a.mediaType,
          name: a.name,
        }));
        return (
          <ImageAnnotator
            src={imageList[initialPos]?.src ?? ''}
            mediaType={imgAtts[initialPos]?.mediaType ?? ''}
            name={imgAtts[initialPos]?.name}
            images={imageList}
            initialIndex={initialPos}
            onSave={handleAnnotatorSave}
            onClose={() => setAnnotateIdx(null)}
          />
        );
      })()}

      {urlModalOpen && (
        <div className="modal-overlay" onClick={() => setUrlModalOpen(false)}>
          <div className="modal-content url-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">Add URL</div>
            <div className="modal-body">
              <input
                type="url"
                className="url-modal-input"
                placeholder="https://example.com/file.png"
                value={urlInput}
                autoFocus
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submitUrl(); } }}
              />
            </div>
            <div className="modal-footer">
              <button className="modal-btn" onClick={() => { setUrlModalOpen(false); setUrlInput(''); }}>Cancel</button>
              <button className="modal-btn primary" onClick={() => void submitUrl()} disabled={!urlInput.trim()}>Add</button>
            </div>
          </div>
        </div>
      )}

      {promptCollectionOpen && (
        <PromptCollectionModal
          onInsert={insertPrompt}
          onEnhance={insertAndEnhance}
          enhanceAvailable={enhanceConfigured && !!conversationId && !isScheduleHome}
          contextAvailable={!!conversationId && !isScheduleHome}
          projectAvailable={enhanceProject.configured && !!conversationId && !isScheduleHome}
          onClose={() => setPromptCollectionOpen(false)}
          roles={roles}
          onOpenFile={onOpenFile}
        />
      )}

      {savePromptModalOpen && (
        <SavePromptModal
          initialBody={textRef.current}
          onClose={() => setSavePromptModalOpen(false)}
        />
      )}

      {timerModalOpen && (
        <PromptTimerModal
          conversationTitle={conversationTitle ?? ''}
          prompt={text}
          profiles={profiles}
          profilesLoaded={profilesLoaded}
          composerProfileId={selectedProfileId}
          composerEffort={effort && effort !== 'off' ? effort : null}
          composerOptions={promptOptions}
          attachments={attachmentsForPersist(attachments)}
          lastSessionProfileId={lastSessionProfileId}
          isRemoteAgents={isRemoteAgents}
          onClose={() => setTimerModalOpen(false)}
          onSchedule={handleScheduleTimer}
        />
      )}

      {editingTimer && (
        <PromptTimerModal
          key={editingTimer.id}
          mode="edit"
          initialTimer={editingTimer}
          conversationTitle={conversationTitle ?? ''}
          prompt={editingTimer.prompt}
          profiles={profiles}
          profilesLoaded={profilesLoaded}
          composerProfileId={editingTimer.profileId}
          composerEffort={editingTimer.effort}
          composerOptions={editingTimer.options ?? {}}
          attachments={[]}
          lastSessionProfileId={lastSessionProfileId}
          isRemoteAgents={isRemoteAgents}
          onClose={() => setEditingTimer(null)}
          onSchedule={handleUpdateTimer}
        />
      )}

      {deletingTimer && (
        <ConfirmDialog
          title="Delete timer?"
          danger
          busy={confirmBusy}
          confirmLabel="Delete timer"
          cancelLabel="Keep timer"
          body={(() => {
            const snippet = deletingTimer.prompt.trim();
            const shown = snippet.length > 140 ? `${snippet.slice(0, 140)}…` : snippet;
            const model = profiles.find((p) => p.id === deletingTimer.profileId)?.label
              ?? deletingTimer.profileId;
            return (
              <>
                <div>This timer has not fired yet. Deleting it cancels the send.</div>
                <div style={{ marginTop: 8 }}>
                  Fires in {countdownLabel(deletingTimer.fireAtMs - nowMs)} · {model}
                </div>
                <div style={{ marginTop: 8 }}>&ldquo;{shown}&rdquo;</div>
              </>
            );
          })()}
          onConfirm={() => void confirmDeleteTimer()}
          onCancel={() => setDeletingTimer(null)}
        />
      )}

      {promptOptionsModalOpen && promptOptionDescriptors.length > 0 && onPromptOptionsApply && (
        <PromptOptionsModal
          agentLabel={selectedProfile?.label ?? 'Agent'}
          agentType={selectedProfile?.agentType}
          descriptors={promptOptionDescriptors}
          stagedOptions={promptOptions}
          stagedSticky={promptOptionsSticky}
          composerText={text}
          onClose={() => setPromptOptionsModalOpen(false)}
          onApply={(opts, sticky) => onPromptOptionsApply(opts, sticky)}
        />
      )}

      {permissionModeModalOpen && !isGrokBot && onPermissionModeChange && (
        <PermissionModeModal
          value={permissionMode ?? null}
          defaultMode={permissionDefaultMode}
          permissionCapable={permissionCapable}
          onClose={() => setPermissionModeModalOpen(false)}
          onChange={onPermissionModeChange}
        />
      )}

      <SteerChoiceModal
        open={steerChoiceOpen}
        onQueue={handleSteerChoiceQueue}
        onForce={handleSteerChoiceForce}
        onCancel={handleSteerChoiceCancel}
      />
      {enhanceChoiceOpen && (
        <DictationEnhanceModal
          contextAvailable={enhanceConfigured}
          projectAvailable={enhanceProject.configured}
          projectUnavailableReason={enhanceProject.reason}
          defaultChoice={getSlowEnhanceChoice()}
          onChoose={startSlowDictation}
          onClose={cancelEnhanceChoice}
        />
      )}
      {alertModal && (
        <ConfirmDialog
          title="Error"
          body={alertModal}
          confirmLabel="OK"
          onConfirm={() => setAlertModal(null)}
        />
      )}
    </>
  );
});
