import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AbcElem, TuneObject } from 'abcjs';
import { AbcAudioControls, type AbcAudioHandle } from './AbcAudioControls.js';
import { AbcPianoKeyboard } from './AbcPianoKeyboard.js';

interface Props {
  source: string;
}

/** Standard 6-string guitar tablature under standard notation (EADGBE tuning). */
const GUITAR_TABLATURE = [{ instrument: 'guitar' as const }];

/** Let CSS width:100% scale abcjs output; strip inline sizing that clips overflow. */
function fitAbcSvg(container: HTMLElement): void {
  for (const wrapper of container.querySelectorAll<HTMLElement>(':scope > div')) {
    wrapper.classList.add('abc-line');
    wrapper.style.overflow = '';
    wrapper.style.height = '';
  }

  for (const svg of container.querySelectorAll('svg')) {
    const w = svg.getAttribute('width');
    const h = svg.getAttribute('height');
    if (w && h && !svg.getAttribute('viewBox')) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    svg.removeAttribute('width');
    svg.removeAttribute('height');
  }

  // abcjs setParentStyles writes these inline; they beat our stylesheet and clip
  // the right edge when the engraved width exceeds the container.
  container.style.overflow = '';
  container.style.height = '';
  container.style.width = '';
}

/**
 * Renders an ```abc fenced code block (ABC music notation) as SVG via abcjs,
 * with full playback controls, note cursor, guitar tablature toggle, and MIDI export.
 * Dynamic import keeps abcjs (~150KB) out of the initial bundle.
 *
 * Errors fall back to rendering the source verbatim so the user can see the
 * ABC source.
 */
export function AbcBlock({ source }: Props): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<AbcAudioHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const [visualObj, setVisualObj] = useState<TuneObject | null>(null);
  const [tablature, setTablature] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [activePitches, setActivePitches] = useState<readonly number[]>([]);

  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;

    // Matches .abc-render horizontal padding in index.css (12px each side).
    const BOX_PADDING = 24;
    const FALLBACK_STAFFWIDTH = 680;
    let lastStaffwidth = 0;
    let lastTablature = false;
    let rendering = false;

    const onNoteClick = (abcElem: AbcElem) => {
      void audioRef.current?.seekToNote(abcElem);
    };

    const render = async () => {
      const staffwidth = Math.max(
        200,
        (el.clientWidth > 0 ? el.clientWidth : FALLBACK_STAFFWIDTH) - BOX_PADDING,
      );
      // Height-only resize after fitAbcSvg must not trigger a full re-engrave loop.
      if (
        rendering ||
        (staffwidth === lastStaffwidth && tablature === lastTablature && el.querySelector('svg'))
      ) return;

      rendering = true;
      lastStaffwidth = staffwidth;
      lastTablature = tablature;

      try {
        const abcjs = (await import('abcjs')).default;
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        const tunes = abcjs.renderAbc(containerRef.current, source, {
          staffwidth,
          add_classes: true,
          oneSvgPerLine: true,
          clickListener: onNoteClick,
          tablature: tablature ? GUITAR_TABLATURE : undefined,
        });
        fitAbcSvg(containerRef.current);
        if (!cancelled) {
          setError(null);
          setVisualObj(tunes[0] ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        rendering = false;
      }
    };

    void render();
    const ro = new ResizeObserver(() => {
      if (audioRef.current?.isPlaying()) return;
      void render();
    });
    ro.observe(el);

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [source, tablature]);

  if (error) {
    return (
      <pre className="abc-error">
        <code>{source}</code>
      </pre>
    );
  }

  return (
    <div className="abc-block">
      <div ref={containerRef} className="abc-render abc-audio-score" aria-label="Music notation" />
      {showKeyboard && (
        <AbcPianoKeyboard
          activePitches={activePitches}
          onKeyClick={async (pitch) => {
            try {
              const abcjs = (await import('abcjs')).default;
              const ms = visualObj?.millisecondsPerMeasure?.() || 1000;
              await abcjs.synth.playEvent(
                [{ pitch, duration: 1, volume: 95, instrument: 0, start: 0, gap: 0 }],
                undefined,
                ms,
              );
            } catch (e) {
              console.error('[abcjs piano preview]', e);
            }
          }}
        />
      )}
      {visualObj && (
        <AbcAudioControls
          ref={audioRef}
          source={source}
          visualObj={visualObj}
          scoreRef={containerRef}
          tablature={tablature}
          onToggleTablature={() => setTablature((t) => !t)}
          showKeyboard={showKeyboard}
          onToggleKeyboard={() => setShowKeyboard((k) => !k)}
          onActivePitchesChange={setActivePitches}
        />
      )}
    </div>
  );
}
