import { copyText } from '../clipboard';
import { randomUUID } from '../uuid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import hljs from 'highlight.js/lib/common';
import {
  isImageExtension,
  isAudioExtension,
  isVideoExtension,
  isCodeExtension,
  isHtmlExtension,
  isMarkdownExtension,
  isTextExtension,
  type TtsProvider,
  type VoiceTtsSettings,
} from '@tierwyn/shared';
import { mediaErrorMessage } from '../mediaErrorMessage.js';
import { fetchFileForEdit, fetchFileGitDiff, fileDownloadUrl, fileUrl, restoreFileGit, saveFileText } from '../api.js';
import { CAPTURE_MSG, buildMockSrcDoc } from '../htmlMock.js';
import { FileImage } from './FileImage.js';
import {
  codeSpeakNotice,
  countLines,
  explainDiffAvailable,
  playWithMode,
  ttsSupported,
  type SpeakMode,
} from '../speak.js';
import { getTtsParkState, subscribeTtsPark } from '../ttsParkPlayer.js';
import { MarkdownBody } from './MarkdownBody.js';
import { SpeakChoiceModal } from './SpeakChoiceModal.js';
import { TtsSpeakIcon } from './TtsSpeakIcon.js';
import { EditConfirmModal } from './EditConfirmModal.js';
import { DiscardConfirmModal } from './DiscardConfirmModal.js';
import { FileEditor } from './FileEditor.js';
import { gitDiffReturnTo, type GitDiffReturnTo } from '../gitWorkingTree.js';
import { DiffViewer } from './ToolInputDisplay.js';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/**
 * Copy the rendered file to the clipboard. Markdown → raw text via
 * navigator.clipboard.writeText. Images → fetch bytes and write a Blob via
 * ClipboardItem; falls back to copying the path as text when the ClipboardItem
 * API is unavailable (older browsers, non-secure context, or SVG which
 * browsers refuse to put on the clipboard as an image).
 */
async function copyFile(
  kind: 'image' | 'md',
  path: string,
  text: string | undefined,
  fileCtx: { conversationId?: string; projectId?: string } | undefined,
): Promise<'copied' | 'copied-path' | 'failed'> {
  try {
    if (kind === 'md' && text !== undefined) {
      await copyText(text);
      return 'copied';
    }
    if (kind === 'image') {
      const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
      const mime = IMAGE_MIME[ext] ?? 'image/png';
      // SVG can't be placed on the clipboard as an image bitmap by most
      // browsers; the ClipboardItem path will throw — fall through to text.
      if (mime !== 'image/svg+xml' && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const r = await fetch(fileUrl(path, fileCtx), { credentials: 'include' });
        if (!r.ok) throw new Error(`fetch -> ${r.status}`);
        const blob = await r.blob();
        if (blob.size > 0 && blob.type.startsWith('image/')) {
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          return 'copied';
        }
        throw new Error('empty/non-image blob');
      }
      await copyText(path);
      return 'copied-path';
    }
    return 'failed';
  } catch (err) {
    // Last-ditch fallback: copy the path so the user gets *something*.
    try {
      await copyText(path);
      return 'copied-path';
    } catch {
      console.warn('FileModal copy failed', err);
      return 'failed';
    }
  }
}

interface FileModalProps {
  /** Absolute path (or ~/expanded) to the file. */
  path: string;
  onClose: () => void;
  /** When the rendered markdown contains another openable path, recurse into the same modal. */
  onOpenFile?: (path: string, gallery?: string[]) => void;
  /** Turn-scoped detected image paths for gallery navigation. */
  galleryPaths?: string[];
  /**
   * Active conversation id. Forwarded to the server so non-absolute paths
   * can be resolved against this conversation's workdir / project root.
   */
  conversationId?: string;
  /**
   * Project id for relative-path resolution when there is no conversation
   * (e.g. schedule prompt template). Ignored if conversationId is set.
   */
  projectId?: string;
  /** When set and the file is an image, an "Annotate" button is shown. */
  onAnnotate?: (path: string) => void;
  /** HTML mock: receives a captured PNG data URL. Shows "Capture screenshot & annotate". */
  onAnnotateImage?: (img: { src: string; name: string }) => void;
  /** Voice TTS settings from App — speaker shown when enabled for md/code. */
  tts?: VoiceTtsSettings | null;
  ttsSummarizeAvailable?: boolean;
  /** Warn in the edit-confirm copy when an agent is live in this conversation. */
  agentRunning?: boolean;
  /** Settings → General → Enable file edits. Default off. */
  fileEditsEnabled?: boolean;
  /** When true, open git-diff view once after md/code load. */
  initialGitDiff?: boolean;
  /**
   * Extra class(es) for the overlay. Pass "modal-overlay--top" when opening
   * above another Modal: Modal portals at z-index 1200 while this overlay
   * sits at 1000 and would stack behind it invisibly.
   */
  overlayClassName?: string;
  /** Download filename; defaults to the path basename. */
  displayName?: string;
  /** Set when the file lives on a remote host: shows a chip and hides write-side actions. */
  remoteHostName?: string;
}

/**
 * Overlay class for the file modal portal. Always includes modal-overlay--top
 * so FileModal stacks above any host Modal (z-index 1200). Exported for a
 * stacking regression test. `extra` remains an escape hatch for callers.
 */
export function fileModalOverlayClass(extra?: string): string {
  return ['modal-overlay', 'file-modal-overlay', 'modal-overlay--top', extra].filter(Boolean).join(' ');
}

type EditMode =
  | { mode: 'view' }
  | { mode: 'confirm' }
  | { mode: 'edit'; draft: string }
  | { mode: 'preview'; draft: string }
  | { mode: 'saving'; draft: string }
  | { mode: 'git-diff'; returnTo: GitDiffReturnTo; diff: string; draft?: string; isTracked?: boolean };

type GitDiffLine =
  | { kind: 'insert' | 'delete' | 'unchanged' | 'hunk' | 'meta'; text: string };

function classifyGitDiffLine(raw: string): GitDiffLine {
  if (raw.startsWith('@@')) return { kind: 'hunk', text: raw };
  if (raw.startsWith('+++') || raw.startsWith('---')) return { kind: 'meta', text: raw };
  if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('Index:')) {
    return { kind: 'meta', text: raw };
  }
  if (raw.startsWith('+')) return { kind: 'insert', text: raw.slice(1) };
  if (raw.startsWith('-')) return { kind: 'delete', text: raw.slice(1) };
  return { kind: 'unchanged', text: raw.startsWith(' ') ? raw.slice(1) : raw };
}

const GIT_DIFF_INDICATOR: Record<GitDiffLine['kind'], string> = {
  insert: '+',
  delete: '−',
  unchanged: ' ',
  hunk: '@',
  meta: ' ',
};

type State =
  | { kind: 'loading' }
  | { kind: 'image' }
  | { kind: 'audio' }
  | { kind: 'video' }
  | { kind: 'md'; text: string }
  | { kind: 'code'; text: string; lang: string }
  | { kind: 'error'; status: number | null; message: string };

/**
 * Modal that branches on file extension. Images render directly via fileUrl;
 * markdown is fetched as text and rendered with the same plugin stack as
 * chat output (math, code, mermaid, abc, linkified paths).
 */
export function FileModal({
  path,
  onClose,
  onOpenFile,
  galleryPaths,
  conversationId,
  projectId,
  onAnnotate,
  onAnnotateImage,
  tts = null,
  ttsSummarizeAvailable = false,
  agentRunning = false,
  fileEditsEnabled = false,
  initialGitDiff = false,
  overlayClassName,
  displayName,
  remoteHostName,
}: FileModalProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [speaking, setSpeaking] = useState(false);
  const [speakChoiceOpen, setSpeakChoiceOpen] = useState(false);
  const [speakError, setSpeakError] = useState<string | null>(null);
  const [summarizeBusy, setSummarizeBusy] = useState(false);
  const [edit, setEdit] = useState<EditMode>({ mode: 'view' });
  const [version, setVersion] = useState<string | null>(null);
  const [writable, setWritable] = useState(false);
  const [original, setOriginal] = useState('');
  const [hadCrlf, setHadCrlf] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictVersion, setConflictVersion] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const preEditRef = useRef('');
  const fileCtx = useMemo(
    () => (conversationId || projectId ? { conversationId, projectId } : undefined),
    [conversationId, projectId],
  );
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const isImage = isImageExtension(ext);
  const isAudio = isAudioExtension(ext);
  const isVideo = isVideoExtension(ext);
  const isMd = isMarkdownExtension(ext);
  const isCode = isCodeExtension(ext) || isTextExtension(ext);
  const isHtml = isHtmlExtension(ext);
  // Security (F7): Default to 'source' view for HTML files so repo scripts don't auto-run.
  const [htmlView, setHtmlView] = useState<'preview' | 'source'>('source');
  const [htmlLib, setHtmlLib] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const captureCleanupRef = useRef<(() => void) | null>(null);
  const ttsProvider: TtsProvider = tts?.provider ?? 'browser';
  const canSpeakBase = !!tts?.enabled && (ttsSupported || ttsProvider === 'piper' || ttsProvider === 'kokoro');
  // Speaker only for loaded markdown / code — not images or error/loading.
  const canSpeak = canSpeakBase && (state.kind === 'md' || state.kind === 'code');
  const gitDiffEdit = edit.mode === 'git-diff' ? edit : null;
  const canExplainDiff = canSpeakBase && !!gitDiffEdit && explainDiffAvailable({
    diff: gitDiffEdit.diff,
    isTracked: gitDiffEdit.isTracked,
    summarizeConfigured: ttsSummarizeAvailable,
  });
  const [gitDiffLoading, setGitDiffLoading] = useState(false);
  const [gitStatusNotice, setGitStatusNotice] = useState<string | null>(null);
  const draft =
    edit.mode === 'view' || edit.mode === 'confirm'
      ? original
      : edit.mode === 'git-diff'
        ? (edit.draft ?? original)
        : edit.draft;
  const isDirty = (edit.mode === 'edit' || edit.mode === 'preview' || edit.mode === 'saving')
    && draft !== original;
  const canEdit = fileEditsEnabled && writable && !!version && (state.kind === 'md' || state.kind === 'code');
  const editing = edit.mode === 'edit' || edit.mode === 'preview' || edit.mode === 'saving' || edit.mode === 'git-diff';

  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const [discardIsTracked, setDiscardIsTracked] = useState(true);
  const [discardBusy, setDiscardBusy] = useState(false);
  const initialGitDiffDone = useRef(false);

  // Overlay click and the ✕ button behave exactly like Escape: leave
  // confirm/edit mode first, close only from view mode.
  const requestClose = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    }
    if (discardModalOpen) {
      if (!discardBusy) setDiscardModalOpen(false);
      return;
    }
    if (edit.mode === 'saving') return;
    if (edit.mode === 'confirm') {
      setEdit({ mode: 'view' });
      return;
    }
    if (edit.mode === 'git-diff') {
      if (edit.returnTo === 'close') onClose();
      else setEdit(edit.returnTo === 'edit' ? { mode: 'edit', draft } : { mode: 'view' });
      return;
    }
    if (isDirty) {
      if (discardPrompt) { onClose(); return; }
      setDiscardPrompt(true);
      return;
    }
    if (editing) {
      setEdit({ mode: 'view' });
      setSaveError(null);
      setConflictVersion(null);
      return;
    }
    onClose();
  };

  // Close on Escape — dirty drafts need a second press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (speakChoiceOpen) {
        setSpeakChoiceOpen(false);
        return;
      }
      if (discardModalOpen) {
        if (!discardBusy) setDiscardModalOpen(false);
        return;
      }
      if (edit.mode === 'saving') return;
      if (edit.mode === 'confirm') {
        setEdit({ mode: 'view' });
        return;
      }
      if (document.fullscreenElement) return;
      if (fullscreen) {
        setFullscreen(false);
        return;
      }
      if (edit.mode === 'git-diff') {
        if (edit.returnTo === 'close') onClose();
        else setEdit(edit.returnTo === 'edit' ? { mode: 'edit', draft } : { mode: 'view' });
        return;
      }
      if (isDirty) {
        if (discardPrompt) onClose();
        else setDiscardPrompt(true);
        return;
      }
      if (editing) {
        setEdit({ mode: 'view' });
        setSaveError(null);
        setConflictVersion(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, edit.mode, isDirty, discardPrompt, editing, draft, discardModalOpen, discardBusy, fullscreen, speakChoiceOpen]);

  // Fetch text for markdown + code paths. Images, audio and video don't need a
  // fetch — the <img>/<audio>/<video> tag pulls bytes via fileUrl() when it
  // mounts. Load failures surface through the element's onError handler.
  useEffect(() => {
    if (!isMd && !isCode) {
      if (isImage) {
        setState({ kind: 'image' });
      } else if (isAudio) {
        setState({ kind: 'audio' });
      } else if (isVideo) {
        setState({ kind: 'video' });
      } else {
        setState({ kind: 'error', status: null, message: 'Unsupported file type' });
      }
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchFileForEdit(path, fileCtx)
      .then((load) => {
        if (cancelled) return;
        // CRLF round-trip only for uniformly-CRLF files; a mixed-endings
        // file is normalised to LF on save rather than converted wholesale
        // to CRLF (which would produce a whole-file diff).
        const crlf = load.text.includes('\r\n') && !/(^|[^\r])\n/.test(load.text);
        const normalised = crlf ? load.text.replace(/\r\n/g, '\n') : load.text;
        setHadCrlf(crlf);
        setOriginal(normalised);
        setVersion(load.version);
        setWritable(load.writable);
        if (isMd) setState({ kind: 'md', text: normalised });
        else setState({ kind: 'code', text: normalised, lang: ext });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        const statusMatch = /-> (\d{3})/.exec(msg);
        const status = statusMatch ? Number(statusMatch[1]) : null;
        setState({ kind: 'error', status, message: msg });
      });
    return () => { cancelled = true; };
  }, [path, isImage, isMd, isCode, fileCtx, ext, loadNonce]);

  useEffect(() => {
    initialGitDiffDone.current = false;
  }, [path, loadNonce]);

  useEffect(() => {
    captureCleanupRef.current?.();
    setHtmlView('preview');
    setCaptureError(null);
    setCapturing(false);
  }, [path]);

  useEffect(() => {
    if (!isHtml) return;
    let cancelled = false;
    import('html-to-image/dist/html-to-image.js?raw').then((m) => {
      if (!cancelled) setHtmlLib(m.default);
    }).catch((err: unknown) => {
      if (!cancelled) setCaptureError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [isHtml]);

  useEffect(() => () => { captureCleanupRef.current?.(); }, []);

  const safeName = path.split('/').pop() ?? path;
  const showHtmlPreview = isHtml && state.kind === 'code' && htmlView === 'preview' && (edit.mode === 'view' || edit.mode === 'confirm');
  const codeText = state.kind === 'code' ? state.text : '';
  const srcDoc = useMemo(
    () => (htmlLib ? buildMockSrcDoc(codeText, htmlLib) : ''),
    [codeText, htmlLib],
  );

  useEffect(() => {
    if (!showHtmlPreview) {
      captureCleanupRef.current?.();
      setCaptureError(null);
      setCapturing(false);
    }
  }, [showHtmlPreview]);

  const captureHtml = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !onAnnotateImage) return;
    captureCleanupRef.current?.();
    const id = randomUUID();
    setCapturing(true);
    setCaptureError(null);
    let settled = false;
    const done = (err?: string) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMsg);
      clearTimeout(t);
      captureCleanupRef.current = null;
      setCapturing(false);
      if (err) setCaptureError(err);
    };
    const onMsg = (e: MessageEvent) => {
      if (e.source !== win || e.data?.type !== CAPTURE_MSG || e.data.id !== id) return;
      if (typeof e.data.dataUrl === 'string' && e.data.dataUrl.startsWith('data:image/png;base64,')) {
        done();
        if (document.fullscreenElement) {
          try {
            void document.exitFullscreen?.();
          } catch {
            /* ignore */
          }
        }
        setFullscreen(false);
        onAnnotateImage({ src: e.data.dataUrl, name: `${safeName.replace(/\.html?$/i, '')}-screenshot.png` });
      } else {
        done(String(e.data.error ?? 'Capture failed'));
      }
    };
    const t = setTimeout(() => done('Capture timed out'), 15000);
    window.addEventListener('message', onMsg);
    captureCleanupRef.current = () => done();
    win.postMessage({ type: CAPTURE_MSG, id, dpr: window.devicePixelRatio }, '*');
  }, [onAnnotateImage, safeName]);

  const uniqueGalleryPaths = useMemo(() => {
    if (!galleryPaths || galleryPaths.length === 0) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of galleryPaths) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }, [galleryPaths]);

  const currentIndex = useMemo(() => {
    if (!uniqueGalleryPaths || uniqueGalleryPaths.length === 0) return -1;
    // 1. Exact match first — avoids suffix collisions like "11.png".endsWith("1.png").
    const exact = uniqueGalleryPaths.indexOf(path);
    if (exact >= 0) return exact;
    // 2. Path-segment-boundary fallback for relative vs absolute path forms.
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/^\/+/, '');
    const target = norm(path);
    return uniqueGalleryPaths.findIndex((p) => {
      const cand = norm(p);
      return cand === target || cand.endsWith('/' + target) || target.endsWith('/' + cand);
    });
  }, [uniqueGalleryPaths, path]);

  const hasGallery = isImage && uniqueGalleryPaths != null && uniqueGalleryPaths.length > 1 && currentIndex >= 0;

  const [navDir, setNavDir] = useState<'next' | 'prev' | 'fade'>('fade');

  const goToIndex = useCallback((idx: number, dir?: 'next' | 'prev' | 'fade') => {
    if (!hasGallery || !uniqueGalleryPaths || !onOpenFile) return;
    const len = uniqueGalleryPaths.length;
    const clamped = ((idx % len) + len) % len;
    if (clamped === currentIndex) return;
    setNavDir(dir ?? (clamped > currentIndex ? 'next' : 'prev'));
    onOpenFile(uniqueGalleryPaths[clamped], uniqueGalleryPaths);
  }, [hasGallery, uniqueGalleryPaths, currentIndex, onOpenFile]);

  const step = useCallback((d: number) => {
    goToIndex(currentIndex + d, d >= 0 ? 'next' : 'prev');
  }, [goToIndex, currentIndex]);

  // Preload adjacent gallery images so next/prev transitions feel instant.
  useEffect(() => {
    if (!hasGallery || !uniqueGalleryPaths) return;
    const len = uniqueGalleryPaths.length;
    const targets = new Set<string>([
      uniqueGalleryPaths[(currentIndex + 1) % len],
      uniqueGalleryPaths[(currentIndex - 1 + len) % len],
    ]);
    const ac = new AbortController();
    const ctx = conversationId || projectId ? { conversationId, projectId } : undefined;
    for (const target of targets) {
      if (target === path) continue;
      void fetch(fileUrl(target, ctx), { credentials: 'include', signal: ac.signal }).catch(() => {});
    }
    return () => ac.abort();
  }, [hasGallery, uniqueGalleryPaths, currentIndex, path, conversationId, projectId]);

  // Keep the active filmstrip thumbnail scrolled into view.
  const filmstripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasGallery || !filmstripRef.current) return;
    const active = filmstripRef.current.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [hasGallery, currentIndex]);

  // Touch swipe navigation on the image stage.
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const onStageTouchStart = useCallback((e: React.TouchEvent) => {
    if (!hasGallery || e.touches.length !== 1) return;
    swipeStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, [hasGallery]);
  const onStageTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!hasGallery || !swipeStartRef.current || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - swipeStartRef.current.x;
    const dy = e.changedTouches[0].clientY - swipeStartRef.current.y;
    swipeStartRef.current = null;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      step(dx < 0 ? 1 : -1);
    }
  }, [hasGallery, step]);

  // Gallery keyboard navigation (ArrowLeft / ArrowRight / Home / End)
  useEffect(() => {
    if (!hasGallery || !uniqueGalleryPaths) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        goToIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        goToIndex(uniqueGalleryPaths.length - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasGallery, uniqueGalleryPaths, step, goToIndex]);

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'copied-path' | 'failed'>('idle');
  const [copyLinkState, setCopyLinkState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    const onFs = () => {
      setFullscreen(!!modalRef.current && document.fullscreenElement === modalRef.current);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = async () => {
    const el = modalRef.current;
    if (!el) return;
    if (document.fullscreenElement === el || (!document.fullscreenElement && fullscreen)) {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen?.();
        } catch {
          // ignore
        }
      }
      setFullscreen(false);
    } else {
      try {
        if (el.requestFullscreen) {
          await el.requestFullscreen();
        } else {
          setFullscreen(true);
        }
      } catch {
        // Fallback to CSS pseudo-fullscreen if native requestFullscreen fails
        setFullscreen(true);
      }
    }
  };

  const handleCopyLink = async () => {
    try {
      const url = new URL(fileUrl(path, fileCtx), window.location.origin).href;
      await copyText(url);
      setCopyLinkState('copied');
      window.setTimeout(() => setCopyLinkState('idle'), 2000);
    } catch {
      setCopyLinkState('failed');
      window.setTimeout(() => setCopyLinkState('idle'), 2000);
    }
  };

  // Reset the "Copied!" pill / speak UI / edit draft when switching files so
  // state doesn't bleed across loads.
  useEffect(() => {
    setCopyState('idle');
    setCopyLinkState('idle');
    setSpeakChoiceOpen(false);
    setSpeaking(false);
    setSpeakError(null);
    setSummarizeBusy(false);
    setEdit({ mode: 'view' });
    setVersion(null);
    setWritable(false);
    setOriginal('');
    setHadCrlf(false);
    setSaveError(null);
    setConflictVersion(null);
    setJustSaved(false);
    setDiscardPrompt(false);
    preEditRef.current = '';
    setGitDiffLoading(false);
    setGitStatusNotice(null);
    setDiscardModalOpen(false);
    setDiscardBusy(false);
  }, [path]);

  const canCopy = state.kind === 'image' || state.kind === 'md' || state.kind === 'code';

  const handleCopy = async () => {
    if (!canCopy) return;
    const kind: 'image' | 'md' = state.kind === 'image' ? 'image' : 'md';
    const text = state.kind === 'md' ? state.text : state.kind === 'code' ? state.text : undefined;
    const result = await copyFile(kind, path, text, fileCtx);
    setCopyState(result === 'failed' ? 'failed' : result);
    window.setTimeout(() => setCopyState('idle'), 2000);
  };

  const copyLabel =
    copyState === 'copied' ? 'Copied!'
    : copyState === 'copied-path' ? 'Path copied'
    : copyState === 'failed' ? 'Copy failed'
    : isImage ? 'Copy image'
    : isAudio || isVideo ? 'Copy link'
    : isCode ? 'Copy code'
    : 'Copy markdown';

  const runSpeakMode = (mode: SpeakMode, opts?: { guidance?: string; targetMinutes?: number }) => {
    setSpeakChoiceOpen(false);
    if (state.kind !== 'md' && state.kind !== 'code') return;
    setSpeakError(null);
    setSpeaking(true);
    const onEnd = () => { setSpeaking(false); setSummarizeBusy(false); };
    const speakMeta = conversationId || projectId
      ? { conversationId, projectId, source: 'file' as const, title: safeName }
      : undefined;

    const watchPark = () => subscribeTtsPark(() => {
      const s = getTtsParkState();
      if (s.status === 'error' && s.error) {
        setSpeakError(s.error);
        setSummarizeBusy(false);
        setSpeaking(false);
      } else if (s.status === 'playing' || s.status === 'ready' || s.status === 'idle') {
        setSummarizeBusy(false);
      }
    });

    // Explain-diff: send the unified diff (+ file context) through the tts sidecar.
    if (mode === 'explain-diff') {
      if (edit.mode !== 'git-diff' || !edit.diff.trim()) {
        setSpeaking(false);
        return;
      }
      setSummarizeBusy(true);
      const unsub = watchPark();
      const opts = {
        diff: edit.diff,
        filename: safeName,
        lang: state.kind === 'code' ? state.lang : undefined,
        fileContext: state.text,
        diffSource: 'working-tree' as const,
      };
      void playWithMode(
        edit.diff,
        'explain-diff',
        () => { unsub(); onEnd(); },
        ttsProvider,
        opts,
        { ...(speakMeta ?? {}), title: `Diff: ${safeName}` },
      );
      return;
    }

    // Summarize is server-owned via speak-record (park bar shows loading for the
    // whole LLM leg). Errors surface on the park snapshot — subscribe while speaking.
    if (mode === 'summarize') {
      setSummarizeBusy(true);
      const unsub = watchPark();
      const summarizeOpts = state.kind === 'code'
        ? { kind: 'code' as const, filename: safeName, lang: state.lang, ...opts }
        : { kind: 'prose' as const, ...opts };
      void playWithMode(
        state.text,
        'summarize',
        () => {
          unsub();
          onEnd();
        },
        ttsProvider,
        summarizeOpts,
        speakMeta,
      );
      return;
    }

    // As-is paths.
    void (async () => {
      if (state.kind === 'code') {
        const notice = codeSpeakNotice(state.lang, countLines(state.text));
        await playWithMode(notice, 'as-is', onEnd, ttsProvider, undefined, speakMeta);
        return;
      }
      await playWithMode(state.text, 'as-is', onEnd, ttsProvider, undefined, speakMeta);
    })();
  };

  const persist = async (content: string, ver: string, after: 'view' | 'preview') => {
    setEdit({ mode: 'saving', draft: content });
    setSaveError(null);
    const contentToWrite = hadCrlf ? content.replace(/\n/g, '\r\n') : content;
    try {
      const result = await saveFileText(path, fileCtx, contentToWrite, ver);
      if (result.ok) {
        setOriginal(content);
        setVersion(result.version);
        setJustSaved(true);
        setConflictVersion(null);
        setDiscardPrompt(false);
        if (state.kind === 'md') setState({ kind: 'md', text: content });
        else if (state.kind === 'code') setState({ kind: 'code', text: content, lang: state.lang });
        setEdit({ mode: 'view' });
        return;
      }
      if (result.status === 409) {
        setConflictVersion(result.currentVersion ?? null);
        setSaveError(result.error);
        setEdit({ mode: 'preview', draft: content });
        return;
      }
      setSaveError(result.error || `Save failed -> ${result.status}`);
      setEdit(after === 'view' ? { mode: 'view' } : { mode: 'preview', draft: content });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setEdit(after === 'view' ? { mode: 'view' } : { mode: 'preview', draft: content });
    }
  };

  const goPreview = () => {
    if (edit.mode !== 'edit') return;
    if (edit.draft === original) return;
    setDiscardPrompt(false);
    setEdit({ mode: 'preview', draft: edit.draft });
  };

  const handleRevert = () => {
    if (!version) return;
    const prev = preEditRef.current;
    void persist(prev, version, 'view');
  };

  const reloadFile = () => {
    setConflictVersion(null);
    setSaveError(null);
    setEdit({ mode: 'view' });
    setDiscardPrompt(false);
    setLoadNonce((n) => n + 1);
  };

  const handleCheckGitDiff = async (closeOnExit = false) => {
    if (gitDiffLoading) return;
    setGitDiffLoading(true);
    setGitStatusNotice(null);
    try {
      const res = await fetchFileGitDiff(path, fileCtx);
      const isTracked = res.isTracked ?? true;
      setDiscardIsTracked(isTracked);
      if (!res.modified || !res.diff.trim()) {
        setGitStatusNotice(isTracked ? 'No tracked git changes for this file.' : 'Untracked file (not in git).');
        window.setTimeout(() => {
          setGitStatusNotice((curr) =>
            curr === 'No tracked git changes for this file.' || curr === 'Untracked file (not in git).' ? null : curr,
          );
        }, 4000);
      } else {
        const returnTo = gitDiffReturnTo({
          closeOnExit,
          mode: edit.mode,
          prevReturnTo: edit.mode === 'git-diff' ? edit.returnTo : undefined,
        });
        setEdit({ mode: 'git-diff', returnTo, diff: res.diff, draft, isTracked });
      }
    } catch (err) {
      setGitStatusNotice(err instanceof Error ? err.message : 'Failed to check git diff');
      window.setTimeout(() => {
        setGitStatusNotice((curr) => (curr ? null : curr));
      }, 4000);
    } finally {
      setGitDiffLoading(false);
    }
  };

  useEffect(() => {
    if (!initialGitDiff || initialGitDiffDone.current) return;
    if (remoteHostName) return; // git-diff is hub-only until P2b-2
    if (state.kind !== 'md' && state.kind !== 'code') return;
    if (edit.mode !== 'view') return;
    initialGitDiffDone.current = true;
    void handleCheckGitDiff(true);
  }, [initialGitDiff, state.kind, edit.mode]); // handleCheckGitDiff is stable enough for one-shot entry

  const promptDiscard = async () => {
    try {
      const res = await fetchFileGitDiff(path, fileCtx);
      setDiscardIsTracked(res.isTracked ?? true);
      setDiscardModalOpen(true);
    } catch {
      setDiscardIsTracked(true);
      setDiscardModalOpen(true);
    }
  };

  const handleDiscardConfirm = async () => {
    if (discardBusy) return;
    setDiscardBusy(true);
    try {
      const res = await restoreFileGit(path, fileCtx);
      setDiscardModalOpen(false);
      if (res.action === 'deleted') {
        onClose();
      } else {
        setGitStatusNotice('Reverted file to last commit.');
        window.setTimeout(() => {
          setGitStatusNotice((curr) => (curr === 'Reverted file to last commit.' ? null : curr));
        }, 4000);
        reloadFile();
      }
    } catch (err) {
      setGitStatusNotice(err instanceof Error ? err.message : 'Failed to revert file');
      window.setTimeout(() => {
        setGitStatusNotice((curr) => (curr ? null : curr));
      }, 4000);
    } finally {
      setDiscardBusy(false);
    }
  };

  const gitDiffLines: GitDiffLine[] = useMemo(() => {
    if (edit.mode !== 'git-diff') return [];
    return edit.diff.split('\n').map(classifyGitDiffLine);
  }, [edit]);

  const { gitDiffAdd, gitDiffDel } = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const l of gitDiffLines) {
      if (l.kind === 'insert') add++;
      else if (l.kind === 'delete') del++;
    }
    return { gitDiffAdd: add, gitDiffDel: del };
  }, [gitDiffLines]);

// Portal to body so the overlay stacks above .topbar / session chrome.
// Nested under .main (schedule browser, output pane) the fixed overlay can
// sit under the shell topbar because of grid/overflow stacking contexts.
return createPortal(
    <div className={fileModalOverlayClass(overlayClassName)} onClick={requestClose}>
      <div
        ref={modalRef}
        className={
          (isImage
            ? `image-lightbox file-modal-image${hasGallery ? ' file-modal-image--album' : ''}`
            : `file-modal-md${editing ? ' file-modal-md-editing' : ''}`) +
          (fullscreen ? ' file-modal--fullscreen' : '')
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="file-modal-title-group">
            <span className="file-modal-path" title={path}>
              {displayName ?? safeName}
            </span>
            {hasGallery && uniqueGalleryPaths && (
              <span className="file-modal-gallery-count" aria-label={`Image ${currentIndex + 1} of ${uniqueGalleryPaths.length}`}>
                {`${currentIndex + 1} / ${uniqueGalleryPaths.length}`}
              </span>
            )}
            {remoteHostName && <span className="host-chip" title={`Read-only — file on ${remoteHostName}`}>{remoteHostName}</span>}
            <a
              className="action-icon-btn"
              href={fileDownloadUrl(path, displayName ?? safeName, fileCtx)}
              download
              title="Download"
              aria-label="Download"
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
            </a>
            <button
              type="button"
              className="action-icon-btn"
              onClick={handleCopy}
              disabled={!canCopy}
              title={copyLabel}
              aria-label={copyLabel}
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              {copyState === 'copied' || copyState === 'copied-path' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green, #10b981)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              )}
            </button>
            {isImage && (
              <button
                type="button"
                className="action-icon-btn"
                onClick={handleCopyLink}
                title={copyLinkState === 'copied' ? 'Link copied!' : copyLinkState === 'failed' ? 'Copy link failed' : 'Copy link'}
                aria-label={copyLinkState === 'copied' ? 'Link copied!' : 'Copy link'}
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                {copyLinkState === 'copied' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green, #10b981)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                )}
              </button>
            )}
            {canSpeak && (
              <button
                type="button"
                className="action-icon-btn"
                title={
                  summarizeBusy
                    ? 'Preparing speech…'
                    : speaking
                      ? 'Read aloud (replace current)'
                      : 'Read aloud'
                }
                aria-label={speaking ? 'Read aloud (replace current)' : 'Read aloud'}
                aria-busy={speaking || summarizeBusy || undefined}
                style={speaking || summarizeBusy ? { color: 'var(--accent)' } : undefined}
                onClick={() => setSpeakChoiceOpen(true)}
              >
                <TtsSpeakIcon
                  speaking={speaking || summarizeBusy}
                  preparing={summarizeBusy}
                  size={14}
                />
              </button>
            )}
            {isImage && onAnnotate && (
              <button
                type="button"
                className="action-icon-btn"
                onClick={() => {
                  if (document.fullscreenElement) {
                    try {
                      void document.exitFullscreen?.();
                    } catch {
                      /* ignore */
                    }
                  }
                  setFullscreen(false);
                  onAnnotate(path);
                }}
                title="Annotate"
                aria-label="Annotate"
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            )}
            {isHtml && state.kind === 'code' && edit.mode === 'view' && (
              <button
                type="button"
                className="action-icon-btn"
                onClick={() => setHtmlView((v) => (v === 'preview' ? 'source' : 'preview'))}
                title={htmlView === 'preview' ? 'Show source' : 'Show preview'}
                aria-label={htmlView === 'preview' ? 'Show source' : 'Show preview'}
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                {htmlView === 'preview' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            )}
            {showHtmlPreview && onAnnotateImage && (
              <button
                type="button"
                className="action-icon-btn"
                onClick={captureHtml}
                disabled={capturing || !htmlLib}
                title="Capture screenshot & annotate"
                aria-label="Capture screenshot & annotate"
                aria-busy={capturing}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  ...(capturing ? { color: 'var(--accent)' } : {}),
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                  <circle cx="12" cy="13" r="3" />
                </svg>
              </button>
            )}
            {canEdit && !editing && (
              <button
                type="button"
                className="action-icon-btn"
                onClick={() => setEdit({ mode: 'confirm' })}
                title="Edit file"
                aria-label="Edit file"
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            )}
            {(state.kind === 'md' || state.kind === 'code') && edit.mode === 'git-diff' && edit.returnTo === 'close' && (
              <button
                type="button"
                className="action-icon-btn"
                onClick={() => setEdit({ mode: 'view' })}
                title="Open in file editor"
                aria-label="Open in file editor"
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            )}
            {(state.kind === 'md' || state.kind === 'code') && !remoteHostName && edit.mode !== 'git-diff' && (
              <button
                type="button"
                className="action-icon-btn"
                onClick={() => void handleCheckGitDiff()}
                disabled={gitDiffLoading}
                title={gitDiffLoading ? 'Checking git diff…' : 'Check git diff'}
                aria-label={gitDiffLoading ? 'Checking git diff…' : 'Check git diff'}
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="18" r="3" />
                  <circle cx="6" cy="6" r="3" />
                  <path d="M13 6h3a2 2 0 0 1 2 2v7" />
                  <line x1="6" y1="9" x2="6" y2="21" />
                </svg>
              </button>
            )}
            {(state.kind === 'md' || state.kind === 'code') && !remoteHostName && edit.mode !== 'git-diff' && (
              <button
                type="button"
                className="action-icon-btn"
                onClick={promptDiscard}
                title="Discard changes / revert to last commit"
                aria-label="Discard changes / revert to last commit"
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            )}
            {justSaved && (
              <span className="file-modal-saved-pill">
                Saved
                {version && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="file-modal-revert-btn"
                      onClick={handleRevert}
                      disabled={edit.mode === 'saving' || original === preEditRef.current}
                    >
                      Revert
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
          <div className="file-modal-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              type="button"
              className="action-icon-btn file-modal-fullscreen-btn"
              onClick={toggleFullscreen}
              title={fullscreen ? 'Exit full screen' : 'Full screen'}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {fullscreen ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="10" y1="14" x2="3" y2="21" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
            <button className="image-lightbox-close" onClick={requestClose} aria-label="Close">✕</button>
          </div>
        </div>
        {captureError && (
          <div className="file-modal-html-error">
            {captureError}
            <button
              type="button"
              className="action-icon-btn"
              aria-label="Dismiss capture error"
              onClick={() => setCaptureError(null)}
            >
              ✕
            </button>
          </div>
        )}
        {edit.mode === 'confirm' && (
          <EditConfirmModal
            fileName={safeName}
            agentRunning={agentRunning}
            container={fullscreen ? modalRef.current : undefined}
            onCancel={() => setEdit({ mode: 'view' })}
            onConfirm={() => {
              preEditRef.current = original;
              setDiscardPrompt(false);
              setSaveError(null);
              setConflictVersion(null);
              setEdit({ mode: 'edit', draft: original });
            }}
          />
        )}
        {discardModalOpen && (
          <DiscardConfirmModal
            fileName={safeName}
            isTracked={discardIsTracked}
            busy={discardBusy}
            container={fullscreen ? modalRef.current : undefined}
            onConfirm={handleDiscardConfirm}
            onCancel={() => {
              if (!discardBusy) setDiscardModalOpen(false);
            }}
          />
        )}
        {speakChoiceOpen && (
          <SpeakChoiceModal
            summarizeAvailable={ttsSummarizeAvailable}
            asIsAvailable={state.kind !== 'code'}
            explainDiffAvailable={canExplainDiff}
            allowSummarizeGuidance={ttsSummarizeAvailable}
            container={fullscreen ? modalRef.current : undefined}
            summarizeHint={
              state.kind === 'code'
                ? (ttsSummarizeAvailable
                  ? 'LLM explanation of what this file does'
                  : 'Configure Voice → Transcript cleanup provider/model first')
                : undefined
            }
            explainDiffHint={
              ttsSummarizeAvailable
                ? 'What this diff changes, in plain English'
                : 'Configure the TTS summarize LLM first'
            }
            busy={summarizeBusy}
            onChoose={runSpeakMode}
            onClose={() => setSpeakChoiceOpen(false)}
          />
        )}
        {speakError && (
          <div
            className="voice-warning-chip"
            style={{ margin: '8px 16px 0', fontSize: 12 }}
            role="alert"
          >
            Speak failed: {speakError}
          </div>
        )}
        {summarizeBusy && (
          <div style={{ margin: '8px 16px 0', fontSize: 12, color: 'var(--text-3)' }}>
            Preparing speech…
          </div>
        )}
        {discardPrompt && isDirty && (
          <div className="voice-warning-chip" style={{ margin: '8px 16px 0', fontSize: 12 }} role="status">
            Unsaved changes — press Escape or click outside again to discard.
          </div>
        )}
        {conflictVersion && (
          <div className="voice-warning-chip" style={{ margin: '8px 16px 0', fontSize: 12 }} role="alert">
            This file changed on disk since you opened it.
            <span style={{ display: 'inline-flex', gap: 8, marginLeft: 8 }}>
              <button type="button" className="modal-btn" onClick={reloadFile}>Reload file</button>
              <button
                type="button"
                className="modal-btn primary"
                disabled={edit.mode === 'saving' || !conflictVersion}
                onClick={() => {
                  void persist(draft, conflictVersion, 'preview');
                }}
              >
                Overwrite anyway
              </button>
            </span>
          </div>
        )}
        {saveError && !conflictVersion && (
          <div className="voice-warning-chip" style={{ margin: '8px 16px 0', fontSize: 12 }} role="alert">
            {saveError}
          </div>
        )}
        {gitStatusNotice && (
          <div className="voice-warning-chip" style={{ margin: '8px 16px 0', fontSize: 12 }} role="status">
            {gitStatusNotice}
          </div>
        )}
        <div className="file-modal-body">
          {edit.mode === 'edit' && (
            <FileEditor
              value={edit.draft}
              fileName={safeName}
              onChange={(v) => {
                setDiscardPrompt(false);
                setEdit({ mode: 'edit', draft: v });
              }}
              onSaveShortcut={goPreview}
            />
          )}
          {(edit.mode === 'preview' || edit.mode === 'saving') && (
            <DiffViewer target={original} replacement={edit.draft} foldUnchanged />
          )}
          {edit.mode === 'git-diff' && (
            <div className="diff-container" style={{ minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
              <div className="diff-header-bar">
                <span>Tracked changes: {safeName}</span>
                <span className="diff-stats-badge">
                  <span className="diff-stat-added">+{gitDiffAdd}</span>
                  <span className="diff-stat-removed">−{gitDiffDel}</span>
                </span>
              </div>
              <pre className="diff-pre" style={{ flex: 1, overflow: 'auto', maxHeight: 'none' }}>
                <div className="diff-lines-container">
                  {gitDiffLines.map((l, i) => (
                    <div key={i} className={`diff-line diff-line-${l.kind}`}>
                      <span className="diff-indicator">{GIT_DIFF_INDICATOR[l.kind]}</span>
                      <span className="diff-text">{l.text || '\u00A0'}</span>
                    </div>
                  ))}
                </div>
              </pre>
            </div>
          )}
          {edit.mode === 'view' || edit.mode === 'confirm' ? (
            <>
              {state.kind === 'loading' && (
                <div className="file-modal-loading">Loading…</div>
              )}
              {state.kind === 'image' && (
                hasGallery && uniqueGalleryPaths ? (
                  <div className="album-viewer">
                    <div
                      className="md-img-stage file-modal-img-stage album-stage"
                      onTouchStart={onStageTouchStart}
                      onTouchEnd={onStageTouchEnd}
                    >
                      <button
                        type="button"
                        className="md-img-nav md-img-nav--prev album-nav"
                        aria-label="Previous image (Left Arrow)"
                        title="Previous (←)"
                        onClick={() => step(-1)}
                      >
                        ‹
                      </button>
                      <FileImage
                        className={`image-lightbox-img album-img--${navDir}`}
                        path={path}
                        conversationId={conversationId}
                        projectId={projectId}
                        alt={safeName}
                        keepPrevious
                      />
                      <button
                        type="button"
                        className="md-img-nav md-img-nav--next album-nav"
                        aria-label="Next image (Right Arrow)"
                        title="Next (→)"
                        onClick={() => step(1)}
                      >
                        ›
                      </button>
                    </div>
                    <div className="album-filmstrip" ref={filmstripRef} role="tablist" aria-label="Album images">
                      {uniqueGalleryPaths.map((gp, idx) => {
                        const gpName = gp.split('/').pop() ?? gp;
                        const active = idx === currentIndex;
                        return (
                          <button
                            key={gp}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            data-active={active ? 'true' : undefined}
                            className={`album-thumb${active ? ' album-thumb--active' : ''}`}
                            title={`${idx + 1} / ${uniqueGalleryPaths.length} · ${gpName}`}
                            onClick={() => goToIndex(idx)}
                          >
                            <FileImage
                              path={gp}
                              conversationId={conversationId}
                              projectId={projectId}
                              alt={gpName}
                              failQuiet
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <FileImage
                    className="image-lightbox-img"
                    path={path}
                    conversationId={conversationId}
                    projectId={projectId}
                    alt={safeName}
                  />
                )
              )}
              {state.kind === 'md' && (
                <MarkdownBody className="event-message" onOpenFile={onOpenFile}>{state.text}</MarkdownBody>
              )}
              {state.kind === 'code' && (showHtmlPreview
                ? (htmlLib == null
                    ? <div className="file-modal-loading">Loading…</div>
                    : <iframe ref={iframeRef} className="file-modal-html-iframe" title={safeName}
                        sandbox="allow-scripts" srcDoc={srcDoc} referrerPolicy="no-referrer" />)
                : <CodeView text={state.text} lang={state.lang} showLineNumbers={true} />)}
              {state.kind === 'audio' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', gap: '20px' }}>
                  <audio controls src={fileUrl(path, fileCtx)} autoPlay style={{ width: '100%', maxWidth: 480 }}
                    onError={(e) => setState({ kind: 'error', status: null, message: mediaErrorMessage(e.currentTarget.error) })} />
                </div>
              )}
              {state.kind === 'video' && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', height: '100%' }}>
                  <video controls src={fileUrl(path, fileCtx)} autoPlay
                    style={{ maxWidth: '100%', maxHeight: '100%' }}
                    onError={(e) => setState({ kind: 'error', status: null, message: mediaErrorMessage(e.currentTarget.error) })} />
                </div>
              )}
              {state.kind === 'error' && (
                <div className="file-modal-error">
                  <strong>Couldn't open {safeName}</strong>
                  <pre>{state.message}</pre>
                  {state.status === 403 && <p>This file isn't in an allowed location.</p>}
                  {state.status === 404 && <p>File doesn't exist (may have been deleted).</p>}
                </div>
              )}
            </>
          ) : null}
        </div>
        {edit.mode === 'edit' && (
          <div className="file-modal-footer">
            <button
              type="button"
              className="modal-btn"
              onClick={() => {
                setEdit({ mode: 'view' });
                setDiscardPrompt(false);
              }}
            >
              Cancel
            </button>
            {!remoteHostName && (
              <button
                type="button"
                className="modal-btn"
                disabled={gitDiffLoading}
                onClick={() => void handleCheckGitDiff()}
                title="Check if file has tracked changes using git diff"
              >
                {gitDiffLoading ? 'Checking git diff…' : 'Check git diff'}
              </button>
            )}
            <button
              type="button"
              className="modal-btn primary"
              disabled={edit.draft === original}
              onClick={goPreview}
            >
              {edit.draft === original ? 'No changes' : 'Preview changes'}
            </button>
          </div>
        )}
        {edit.mode === 'git-diff' && (
          <div className="file-modal-footer">
            <button
              type="button"
              className="modal-btn"
              style={{ color: 'var(--accent-danger, #ef4444)' }}
              onClick={() => {
                setDiscardIsTracked(edit.isTracked ?? true);
                setDiscardModalOpen(true);
              }}
            >
              {(edit.isTracked ?? true) ? 'Discard changes…' : 'Delete file…'}
            </button>
            {fileEditsEnabled && (edit.isTracked ?? true) && (
              <button type="button" className="modal-btn"
                onClick={() => setEdit({ mode: 'edit', draft: draft ?? original })}>
                Edit file
              </button>
            )}
            <button
              type="button"
              className="modal-btn primary"
              onClick={() => {
                if (edit.returnTo === 'close') onClose();
                else setEdit(edit.returnTo === 'edit' ? { mode: 'edit', draft } : { mode: 'view' });
              }}
            >
              {edit.returnTo === 'close' ? 'Close' : `Back to ${edit.returnTo === 'edit' ? 'editing' : 'file'}`}
            </button>
          </div>
        )}
        {(edit.mode === 'preview' || edit.mode === 'saving') && (
          <div className="file-modal-footer">
            <button
              type="button"
              className="modal-btn"
              disabled={edit.mode === 'saving'}
              onClick={() => setEdit({ mode: 'edit', draft: edit.draft })}
            >
              Back to editing
            </button>
            <button
              type="button"
              className="modal-btn primary"
              disabled={edit.mode === 'saving' || !version}
              onClick={() => { if (version) void persist(edit.draft, version, 'preview'); }}
            >
              {edit.mode === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Syntax-highlighted source view. Uses highlight.js directly (rather than
 * wrapping the source in a fenced block and routing through MarkdownBody)
 * so that triple-backticks or other markdown metacharacters inside the
 * source don't break highlighting. highlight.js escapes HTML in its output,
 * so dangerouslySetInnerHTML is safe here.
 *
 * `highlight.js/lib/common` is the same bundle lowlight already pulls in
 * via rehype-highlight, so this doesn't add weight on top of what's
 * already loaded for chat code blocks.
 */
export function CodeView({
  text,
  lang,
  showLineNumbers = true,
}: {
  text: string;
  lang: string;
  showLineNumbers?: boolean;
}) {
  const html = useMemo(() => {
    // Try the extension as a language name first; if highlight.js doesn't
    // know it (or it's a generic text extension like 'txt'/'log'), fall
    // back to auto-detection. Auto-detect is more expensive but still
    // fast enough for source files under ~100KB.
    const safeLang = lang.toLowerCase();
    try {
      if (safeLang && hljs.getLanguage(safeLang)) {
        return hljs.highlight(text, { language: safeLang, ignoreIllegals: true }).value;
      }
    } catch {
      // fall through to auto
    }
    try {
      return hljs.highlightAuto(text).value;
    } catch {
      // Last resort: escaped plaintext.
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }, [text, lang]);

  const lineCount = useMemo(() => {
    if (!text) return 0;
    return text.replace(/\n$/, '').split('\n').length;
  }, [text]);

  if (showLineNumbers && lineCount > 0) {
    return (
      <div className="git-file-code-container">
        <div className="git-file-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i} className="git-file-line-num">{i + 1}</span>
          ))}
        </div>
        <pre className="file-modal-code hljs git-file-code-body">
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    );
  }

  return (
    <pre className="file-modal-code hljs">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
