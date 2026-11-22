# Dictation (STT) modes

Whisper dictation is a Fast/Slow snap on the mic strip, not a Settings-only flag. Slow then asks whether to **enhance with the project**, **enhance with context**, or **cleanup only**.

**Code:** `apps/web/src/components/DictationModeStrip.tsx`, `DictationEnhanceModal.tsx`, `apps/web/src/useWhisperInput.ts`, `apps/server/src/routes/transcribe.ts`, `apps/server/src/routes/enhance.ts` (`continueEnhanceUnderLock`)

---

## Engine first

| STT engine (Settings → Voice) | What happens on mic tap |
|---|---|
| **Whisper** (default) | Opens the Fast/Slow strip. Modes below apply. |
| **Browser** (Web Speech) | Starts immediately. No Fast/Slow strip, no cleanup LLM, no context enhance. Text is appended locally. |

Switch to Whisper if you want Slow cleanup or context enhance.

---

## Whisper: Fast vs Slow

Tap the mic, then snap the strip:

| Snap | Label in UI | After you stop talking |
|---|---|---|
| **Left / Fast** | whisper only | Raw whisper transcript into the composer. No LLM. |
| **Right / Slow** | whisper + LLM | Strip closes. A **Slow dictation** modal asks what to do next (does **not** start the mic until you choose). |

Last Fast/Slow choice is remembered (`tierwyn.voice.dictationMode`, default Slow). Cancel on the Slow modal does not record.

---

## Slow modal: three choices

| Choice | Mic / LLM | Composer | Processing strip |
|---|---|---|---|
| **Enhance with the project** | Whisper only (cleanup LLM **skipped**), then **one** Prompt-enhancer call (`mode: project`) as a **read-only** agent one-shot scoped to the conversation's working directory | **Nothing** in the box until the rewrite lands | Same as context: one animation through whisper and the rewrite |
| **Cleanup only** | Whisper, then the **Voice → Transcript cleanup** LLM | Cleaned transcript appears when that job finishes | Animation for whisper + cleanup, then idle |
| **Enhance with context** | Whisper only (cleanup LLM **skipped**), then **one** Prompt-enhancer call (`mode: context`) | **Nothing** in the box until the rewrite lands | Animation stays up through whisper **and** the rewrite; one settle |
| **Cancel** | No recording | Unchanged | - |

**Enhance with context** is the seamless path: one rewrite that both tidies the raw dictation (filler, punctuation, obvious STT errors) **and** resolves references from recent chat (`it`, `that bug`, `the file we discussed`). It is **not** cleanup then a second ✨.

**Enhance with the project** is the same single rewrite, but the enhancer may read, search, and list files under the conversation's working directory, to correct file names, symbols, and speech-to-text errors that the repo confirms. It never edits files, runs shell, or carries out the prompt. It always uses the project prompt (Settings → Sidecar job routing → Enhance → Project-reads enhance prompt), with recent prose attached when there is any. The timeout is at least 120 s.

ArrowUp/ArrowDown cycle the enabled rows; Enter picks; Escape/Cancel never records.

The ✨ button on the input bar is unchanged (Quick / Context / Enhance with the project on whatever is already in the draft). Slow project/context is dictation-only.

---

## Prerequisites

| Path | Needs |
|---|---|
| Fast | Whisper binary + model |
| Slow → Cleanup only | Whisper + Voice cleanup enabled/configured. If cleanup is off, Slow-No is effectively Fast (raw transcript). |
| Slow → Enhance with context | Whisper + **Settings → General → Prompt enhancer** (provider + model). Same connection as ✨. |
| Slow → Enhance with the project | Whisper + Settings → Sidecar job routing → Enhance: an agent row whose adapter supports read-only one-shot, **or** a direct row with "Adapter/Model for project reads" set. The conversation needs an absolute working directory (checked when it runs). |

If enhance is not configured, **Enhance with context** is disabled with a settings hint. **Cleanup only** still works. If project reads are not configured, the row is disabled with the reason from the server.

Last choice is remembered in `tierwyn.voice.slowEnhanceContext`: `'false'` (cleanup, default), `'true'` (context), `'project'` (project). Older builds' boolean values still read back. The modal still appears (remembered choice is focused so Enter accepts it).

---

## Undo and failure

- Slow enhance stashes the **raw** (typed prefix + clip) as ✨ undo (`pre_text`) without putting it in the visible draft. Undo restores that raw draft. The composer stays on the pre-dictation text (locked) until the rewrite settles.
- If the enhance LLM fails or returns empty, the composer then gets the raw transcript (never a half-finished two-step). Project failures (including "this conversation has no absolute working directory") land the raw transcript exactly like context failures.
- **Auto-send** is stored on the draft row (`auto_send` + profile ctx) so a reload while whisper/enhance is still running restores the armed button. After Slow enhance, auto-send fires on the **rewritten** prompt, not the raw clip. Fast / Slow cleanup still auto-send the transcript as soon as whisper (and cleanup) finish. A successful send deletes the server draft and must clear the composer (and ✨ undo) even if a localStorage mirror still holds the sent text.

---

## What is not a dictation mode

- **Browser STT**: no modal, no server cleanup/enhance.
- **✨ Quick / Context / Enhance with the project**: manual rewrite of the current draft (also on the prompt-collection Enhance modal); not started from the mic strip.
- A third slider stop: Fast/Slow stays two-way; the Slow modal holds the three enhance/cleanup choices.

---

## Protocol (whisper upload)

`POST /transcribe` query flags:

| Flag | Fast | Slow-Cleanup | Slow-Context | Slow-Project |
|---|---|---|---|---|
| `skipCleanup` | `1` | omitted (cleanup runs if enabled) | forced on the server when `enhanceContext` is set | forced on the server when `enhanceProject` is set |
| `enhanceContext` | omitted | omitted | `1` | omitted |
| `enhanceProject` | omitted | omitted | omitted | `1` |

If both flags arrive, project wins. Either flag forces skipCleanup.

Slow enhance keeps the draft lock as `transcribing` until the rewrite settles (no idle flash of the raw text, no `enhancing` grey-out). The HTTP request stays open for that whole job so the local processing visual does not drop when whisper finishes. Reloading mid-job restores `processing: transcribing` and the auto-send arm; the composer is locked until idle.
