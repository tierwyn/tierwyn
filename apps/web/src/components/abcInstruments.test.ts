import { describe, expect, it } from 'vitest';
import type { TuneObject } from 'abcjs';
import {
  initialProgramForTune,
  midiFileName,
  tuneMidiProgram,
} from './abcInstruments.js';

describe('abcInstruments', () => {
  describe('midiFileName', () => {
    it('extracts title and sanitizes it to a valid filename', () => {
      expect(midiFileName('X:1\nT:Speed the Plough\nK:G')).toBe('Speed_the_Plough.mid');
    });

    it('falls back to tune.mid when no title is present', () => {
      expect(midiFileName('X:1\nK:C')).toBe('tune.mid');
    });

    it('removes slashes and directory traversal sequences', () => {
      const fileName = midiFileName('T: ../../etc/passwd');
      expect(fileName).not.toContain('/');
      expect(fileName).not.toContain('\\');
      expect(fileName.endsWith('.mid')).toBe(true);
    });
  });

  describe('tuneMidiProgram', () => {
    it('finds %%MIDI program from tune lines', () => {
      const visualObj = {
        lines: [
          {
            staff: [
              {
                voices: [
                  [
                    { el_type: 'midi', cmd: 'program', params: [40] },
                  ],
                ],
              },
            ],
          },
        ],
      } as unknown as TuneObject;
      expect(tuneMidiProgram(visualObj)).toBe(40);
    });

    it('finds %%MIDI program from formatting.midi.program in header', () => {
      const visualObj = {
        formatting: { midi: { program: [40] } },
        lines: [],
      } as unknown as TuneObject;
      expect(tuneMidiProgram(visualObj)).toBe(40);
    });

    it('extracts program from multi-element formatting.midi.program [channel, program]', () => {
      const visualObj = {
        formatting: { midi: { program: [1, 73] } },
        lines: [],
      } as unknown as TuneObject;
      expect(tuneMidiProgram(visualObj)).toBe(73);
    });

    it('returns undefined when no MIDI program is specified', () => {
      const visualObj = {
        lines: [],
      } as unknown as TuneObject;
      expect(tuneMidiProgram(visualObj)).toBeUndefined();
    });
  });

  describe('initialProgramForTune', () => {
    it('falls back to preference when tune has an unbundled program', () => {
      const visualObj = {
        lines: [
          {
            staff: [
              {
                voices: [
                  [
                    { el_type: 'midi', cmd: 'program', params: [99] },
                  ],
                ],
              },
            ],
          },
        ],
      } as unknown as TuneObject;
      expect(initialProgramForTune(visualObj, 73)).toBe(73);
    });

    it('falls back to default program (0) when tune has unbundled program and no pref', () => {
      const visualObj = {
        lines: [
          {
            staff: [
              {
                voices: [
                  [
                    { el_type: 'midi', cmd: 'program', params: [99] },
                  ],
                ],
              },
            ],
          },
        ],
      } as unknown as TuneObject;
      expect(initialProgramForTune(visualObj, undefined)).toBe(0);
    });

    it('uses bundled tune program when present', () => {
      const visualObj = {
        lines: [
          {
            staff: [
              {
                voices: [
                  [
                    { el_type: 'midi', cmd: 'program', params: [40] },
                  ],
                ],
              },
            ],
          },
        ],
      } as unknown as TuneObject;
      expect(initialProgramForTune(visualObj, 73)).toBe(40);
    });
  });
});
