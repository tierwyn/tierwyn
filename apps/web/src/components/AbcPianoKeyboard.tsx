import { type ReactNode, useMemo } from 'react';

interface Props {
  /** Set of MIDI note numbers currently sounding / active (e.g. 60 for Middle C). */
  activePitches?: readonly number[] | Set<number>;
  /** Optional click handler to preview a pitch when a key is pressed. */
  onKeyClick?: (midiPitch: number) => void;
  /** Lowest MIDI note to render. Defaults to 21 (A0, standard 88-key piano). */
  startPitch?: number;
  /** Highest MIDI note to render. Defaults to 108 (C8, standard 88-key piano). */
  endPitch?: number;
}

interface WhiteKeyInfo {
  pitch: number;
  noteName: string;
  isC: boolean;
  whiteIndex: number;
}

interface BlackKeyInfo {
  pitch: number;
  noteName: string;
  /** Position in units of white key width from the left edge */
  offsetWhiteKeys: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const IS_BLACK_KEY = [false, true, false, true, false, false, true, false, true, false, true, false];

// Distance in white keys from the previous C for each black key:
// C# (pitch%12==1): between C(0) and D(1), center ~ 0.6
// D# (pitch%12==3): between D(1) and E(2), center ~ 1.7
// F# (pitch%12==6): between F(3) and G(4), center ~ 3.6
// G# (pitch%12==8): between G(4) and A(5), center ~ 4.65
// A# (pitch%12==10): between A(5) and B(6), center ~ 5.7
const BLACK_KEY_C_OFFSETS: Record<number, number> = {
  1: 0.6,
  3: 1.7,
  6: 3.6,
  8: 4.65,
  10: 5.7,
};

export function AbcPianoKeyboard({
  activePitches,
  onKeyClick,
  startPitch = 21, // A0
  endPitch = 108,  // C8
}: Props): ReactNode {
  const activeSet = useMemo(() => {
    if (!activePitches) return new Set<number>();
    if (activePitches instanceof Set) return activePitches;
    return new Set(activePitches);
  }, [activePitches]);

  const { whiteKeys, blackKeys, totalWhiteKeys } = useMemo(() => {
    const whites: WhiteKeyInfo[] = [];
    const blacks: BlackKeyInfo[] = [];
    let currentWhiteIndex = 0;

    for (let p = startPitch; p <= endPitch; p++) {
      const noteInOctave = ((p % 12) + 12) % 12;
      const octave = Math.floor(p / 12) - 1;
      const noteName = `${NOTE_NAMES[noteInOctave]}${octave}`;

      if (!IS_BLACK_KEY[noteInOctave]) {
        whites.push({
          pitch: p,
          noteName,
          isC: noteInOctave === 0,
          whiteIndex: currentWhiteIndex,
        });
        currentWhiteIndex++;
      } else {
        // Find preceding white key index
        const whiteBase = currentWhiteIndex - 1;
        // Natural center between the two adjacent white keys:
        const offset = whiteBase + 0.62;
        blacks.push({
          pitch: p,
          noteName,
          offsetWhiteKeys: offset,
        });
      }
    }

    return { whiteKeys: whites, blackKeys: blacks, totalWhiteKeys: currentWhiteIndex };
  }, [startPitch, endPitch]);

  // SVG viewBox coordinates
  // Each white key is 20 units wide, 90 units tall
  const WHITE_WIDTH = 20;
  const WHITE_HEIGHT = 90;
  const BLACK_WIDTH = 12;
  const BLACK_HEIGHT = 56;
  const totalSvgWidth = totalWhiteKeys * WHITE_WIDTH;

  return (
    <div className="abc-keyboard-wrap" aria-label="Piano keyboard visualizer">
      <svg
        className="abc-keyboard-svg"
        viewBox={`0 0 ${totalSvgWidth} ${WHITE_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
      >
        {/* Layer 1: White keys */}
        <g className="abc-keyboard-white-keys">
          {whiteKeys.map((k) => {
            const isActive = activeSet.has(k.pitch);
            const x = k.whiteIndex * WHITE_WIDTH;
            return (
              <g key={k.pitch} className="abc-key-group">
                <rect
                  x={x}
                  y={0}
                  width={WHITE_WIDTH}
                  height={WHITE_HEIGHT}
                  rx={2}
                  ry={2}
                  className={`abc-key abc-key-white${isActive ? ' abc-key-active' : ''}`}
                  onClick={() => onKeyClick?.(k.pitch)}
                  aria-label={`${k.noteName}${isActive ? ' (active)' : ''}`}
                >
                  <title>{k.noteName}</title>
                </rect>
                {k.isC && (
                  <text
                    x={x + WHITE_WIDTH / 2}
                    y={WHITE_HEIGHT - 6}
                    textAnchor="middle"
                    className="abc-key-label"
                  >
                    {k.noteName}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Layer 2: Black keys (drawn on top) */}
        <g className="abc-keyboard-black-keys">
          {blackKeys.map((k) => {
            const isActive = activeSet.has(k.pitch);
            const x = k.offsetWhiteKeys * WHITE_WIDTH - BLACK_WIDTH / 2 + 1.5;
            return (
              <rect
                key={k.pitch}
                x={x}
                y={0}
                width={BLACK_WIDTH}
                height={BLACK_HEIGHT}
                rx={1.5}
                ry={1.5}
                className={`abc-key abc-key-black${isActive ? ' abc-key-active' : ''}`}
                onClick={() => onKeyClick?.(k.pitch)}
                aria-label={`${k.noteName}${isActive ? ' (active)' : ''}`}
              >
                <title>{k.noteName}</title>
              </rect>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
