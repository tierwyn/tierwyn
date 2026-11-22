import { useState, useRef, useCallback } from 'react';

// Feature-detect the Web Speech API without relying on DOM lib type declarations.
// Both the constructor and every instance access go through `any` to keep this
// file typecheck-clean with no extra @types packages required.
function getSpeechRecognitionCtor(): (new () => any) | undefined {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? undefined;
}

/**
 * Thin wrapper around the browser Web Speech API.
 *
 * @param onFinalText - Called whenever a final (non-interim) transcript
 *                      segment is produced.  The caller decides how to
 *                      append it to the prompt. Second arg is the conversation
 *                      id pinned at recognition start (D7 / R8).
 * @param getConversationId - Read at start() time to pin the cid for the session.
 */
export function useSpeechInput(
  onFinalText: (chunk: string, pinnedConversationId: string | null) => void,
  getConversationId: () => string | null,
): {
  supported: boolean;
  listening: boolean;
  transcribing: boolean;
  /** Browser path has no transcribing window — always null (D8 shape parity). */
  transcribingConversationId: null;
  toggle: () => void;
  cancel: () => void;
  /** Browser path doesn't surface errors; included for shape-parity with useWhisperInput. */
  error: null;
  /** Web Speech API exposes no MediaStream to tap — always null. VoiceWave
   *  renders a decorative synthetic shimmer when this is null. */
  getMicLevel: null;
} {
  const supported = !!getSpeechRecognitionCtor();
  const [listening, setListening] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const pinnedCidRef = useRef<string | null>(null);

  const toggle = useCallback(() => {
    if (recognitionRef.current) {
      // Already running — stop it.
      recognitionRef.current.stop();
      return;
    }

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;

    pinnedCidRef.current = getConversationId();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition: any = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language;

    recognition.onresult = (event: any) => {
      const result = event.results[event.results.length - 1];
      if (result && result.isFinal) {
        onFinalText(result[0].transcript as string, pinnedCidRef.current);
      }
    };

    recognition.onerror = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [onFinalText, getConversationId]);

  const cancel = useCallback(() => {
    if (recognitionRef.current) recognitionRef.current.stop();
  }, []);

  return {
    supported,
    listening,
    transcribing: false,
    transcribingConversationId: null,
    toggle,
    cancel,
    error: null,
    getMicLevel: null,
  };
}
