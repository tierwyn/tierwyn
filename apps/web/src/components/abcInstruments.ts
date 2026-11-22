import type { TuneObject } from 'abcjs';

// ponytail: abcjs default CDN soundfont (FluidR3_GM, auto ×3 volume). Self-host under public/soundfonts/ + pass soundFontUrl if offline use is ever needed.

export interface BundledInstrument {
  program: number;
  label: string;
}

export const INSTRUMENTS: readonly BundledInstrument[] = [
  { program: 0, label: 'Piano' },
  { program: 40, label: 'Violin' },
  { program: 73, label: 'Flute' },
  { program: 42, label: 'Cello' },
  { program: 25, label: 'Guitar (steel)' },
  { program: 24, label: 'Guitar (nylon)' },
  { program: 71, label: 'Clarinet' },
  { program: 56, label: 'Trumpet' },
] as const;

const BUNDLED_PROGRAMS = new Set(INSTRUMENTS.map((i) => i.program));

export function isBundledProgram(program: number): boolean {
  return BUNDLED_PROGRAMS.has(program);
}

export function defaultProgram(): number {
  return INSTRUMENTS[0].program;
}

export function normalizeBundledProgram(program: number | undefined): number {
  if (program != null && isBundledProgram(program)) return program;
  return defaultProgram();
}

export function makeAudioParams(program: number) {
  return {
    program: normalizeBundledProgram(program),
  };
}

/** First `%%MIDI program` in the tune, if any. */
export function tuneMidiProgram(visualObj: TuneObject): number | undefined {
  const headerProg = (visualObj as unknown as { formatting?: { midi?: { program?: unknown[] } } })
    .formatting?.midi?.program;
  if (Array.isArray(headerProg) && headerProg.length > 0) {
    const raw = headerProg.length > 1 ? headerProg[1] : headerProg[0];
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  for (const line of visualObj.lines ?? []) {
    for (const staff of line.staff ?? []) {
      for (const voice of staff.voices ?? []) {
        for (const item of voice) {
          if (item.el_type === 'midi' && item.cmd === 'program' && item.params?.[0] != null) {
            const n = Number(item.params[0]);
            if (Number.isFinite(n)) return n;
          }
        }
      }
    }
  }
  return undefined;
}

export function initialProgramForTune(
  visualObj: TuneObject,
  prefProgram: number | undefined,
): number {
  const fromTune = tuneMidiProgram(visualObj);
  if (fromTune != null && isBundledProgram(fromTune)) return fromTune;
  return normalizeBundledProgram(prefProgram);
}

export function instrumentLabel(program: number): string {
  return INSTRUMENTS.find((i) => i.program === program)?.label ?? 'Piano';
}

/** `T:` title → safe `<title>.mid`; falls back to `tune.mid`. */
export function midiFileName(source: string): string {
  const raw = source.match(/^\s*T:\s*(.+?)\s*$/m)?.[1] ?? 'tune';
  const safe = raw.replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, '_').replace(/^_+|_+$/g, '') || 'tune';
  return `${safe}.mid`;
}
