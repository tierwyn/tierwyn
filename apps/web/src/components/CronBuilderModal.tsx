import { useEffect, useMemo, useState } from 'react';
import cronstrue from 'cronstrue';
import { Modal } from './Modal.js';
import { SelectDropdown } from './SelectDropdown.js';

export interface CronBuilderModalProps {
  open: boolean;
  onClose: () => void;
  onApply: (cronExpression: string) => void;
  initialValue?: string;
}

const COMMON_PRESETS = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 2 hours', value: '0 */2 * * *' },
  { label: 'Every day at 00:00', value: '0 0 * * *' },
  { label: 'Every day at 08:00', value: '0 8 * * *' },
  { label: 'Every day at 09:00', value: '0 9 * * *' },
  { label: 'Monday to Friday at 08:00', value: '0 8 * * 1-5' },
  { label: 'Monday to Friday at 09:00', value: '0 9 * * 1-5' },
  { label: 'Every Saturday at 00:00', value: '0 0 * * 6' },
  { label: 'Every Sunday at 00:00', value: '0 0 * * 0' },
  { label: 'First day of every month at 00:00', value: '0 0 1 * *' },
] as const;

const DAYS_OF_WEEK = [
  { label: 'Sunday', value: '0' },
  { label: 'Monday', value: '1' },
  { label: 'Tuesday', value: '2' },
  { label: 'Wednesday', value: '3' },
  { label: 'Thursday', value: '4' },
  { label: 'Friday', value: '5' },
  { label: 'Saturday', value: '6' },
] as const;

type BuilderTab = 'preset' | 'custom' | 'free';

/** Human-readable cron via cronstrue; null when empty/invalid. */
export function describeCron(expr: string): { text: string; valid: boolean } {
  const trimmed = expr.trim();
  if (!trimmed) return { text: 'Enter a cron expression', valid: false };
  try {
    return { text: cronstrue.toString(trimmed, { use24HourTimeFormat: true }), valid: true };
  } catch {
    return { text: 'Invalid cron expression', valid: false };
  }
}

function parseCustomFromCron(expr: string): { time: string; days: string[] } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') return null;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(min);
  const h = Number(hour);
  if (m < 0 || m > 59 || h < 0 || h > 23) return null;
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (dow === '*') return { time, days: [] };
  // Only simple lists of day numbers (no ranges / steps) for reverse-fill.
  if (!/^[\d,]+$/.test(dow)) return null;
  const days = dow.split(',').filter((d) => DAYS_OF_WEEK.some((x) => x.value === d));
  if (days.length === 0) return null;
  return { time, days: [...new Set(days)].sort() };
}

function buildCustomCron(time: string, days: string[]): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hour = match ? Math.min(23, Math.max(0, Number(match[1]))) : 0;
  const min = match ? Math.min(59, Math.max(0, Number(match[2]))) : 0;
  const dow = days.length > 0 ? [...days].sort().join(',') : '*';
  return `${min} ${hour} * * ${dow}`;
}

export function CronBuilderModal({
  open,
  onClose,
  onApply,
  initialValue = '',
}: CronBuilderModalProps) {
  const [activeTab, setActiveTab] = useState<BuilderTab>('preset');
  const [presetValue, setPresetValue] = useState<string>(COMMON_PRESETS[0].value);
  const [freeTextValue, setFreeTextValue] = useState('* * * * *');
  const [customDays, setCustomDays] = useState<string[]>([]);
  const [customTime, setCustomTime] = useState('09:00');

  useEffect(() => {
    if (!open) return;
    const initial = initialValue.trim() || '0 9 * * *';
    setFreeTextValue(initial);

    const matchedPreset = COMMON_PRESETS.find((p) => p.value === initial);
    if (matchedPreset) {
      setPresetValue(matchedPreset.value);
      setActiveTab('preset');
      return;
    }

    const custom = parseCustomFromCron(initial);
    if (custom) {
      setCustomTime(custom.time);
      setCustomDays(custom.days);
      setActiveTab('custom');
      return;
    }

    setActiveTab('free');
  }, [open, initialValue]);

  const currentCron = useMemo(() => {
    if (activeTab === 'preset') return presetValue;
    if (activeTab === 'custom') return buildCustomCron(customTime, customDays);
    return freeTextValue;
  }, [activeTab, presetValue, customTime, customDays, freeTextValue]);

  const preview = useMemo(() => describeCron(currentCron), [currentCron]);

  if (!open) return null;

  const handleApply = () => {
    if (!preview.valid) return;
    onApply(currentCron.trim());
    onClose();
  };

  const toggleDay = (day: string) => {
    setCustomDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  };

  return (
    <Modal title="Design schedule" onClose={onClose}>
      <div className="cron-builder">
        <div className="cron-builder-tabs" role="tablist">
          {([
            ['preset', 'Preset'],
            ['custom', 'Custom'],
            ['free', 'Free text'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              className={`cron-builder-tab${activeTab === id ? ' active' : ''}`}
              onClick={() => setActiveTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'preset' && (
          <div className="cron-builder-panel" role="tabpanel">
            <label className="modal-label">Common schedule</label>
            <SelectDropdown
              options={COMMON_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              value={presetValue}
              onChange={setPresetValue}
              placement="bottom"
              searchable
            />
            <div className="cron-builder-expr" aria-live="polite">
              Expression: <code>{presetValue}</code>
            </div>
          </div>
        )}

        {activeTab === 'custom' && (
          <div className="cron-builder-panel" role="tabpanel">
            <label className="modal-label">Time of day</label>
            <input
              type="text"
              inputMode="numeric"
              className="modal-input"
              placeholder="HH:MM"
              value={customTime}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '' || /^\d{0,2}(:\d{0,2})?$/.test(val)) {
                  setCustomTime(val);
                }
              }}
            />
            <label className="modal-label" style={{ marginTop: 10 }}>Days of week</label>
            <p className="cron-builder-hint">Leave all unchecked for every day</p>
            <div className="cron-builder-days">
              {DAYS_OF_WEEK.map((day) => {
                const checked = customDays.includes(day.value);
                return (
                  <label key={day.value} className="cron-builder-day">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDay(day.value)}
                    />
                    <span>{day.label}</span>
                  </label>
                );
              })}
            </div>
            <div className="cron-builder-expr" aria-live="polite">
              Expression: <code>{buildCustomCron(customTime, customDays)}</code>
            </div>
          </div>
        )}

        {activeTab === 'free' && (
          <div className="cron-builder-panel" role="tabpanel">
            <label className="modal-label">Cron expression</label>
            <input
              className="modal-input"
              style={{ fontFamily: 'var(--mono)' }}
              value={freeTextValue}
              onChange={(e) => setFreeTextValue(e.target.value)}
              placeholder="* * * * *"
              spellCheck={false}
            />
            <p className="cron-builder-hint">
              Format: <code>min hour day-of-month month day-of-week</code> (5-field)
            </p>
          </div>
        )}

        <div className={`cron-builder-preview${preview.valid ? '' : ' invalid'}`}>
          <div className="cron-builder-preview-label">Reads as</div>
          <div className="cron-builder-preview-text">{preview.text}</div>
        </div>

        <div className="modal-footer">
          <button type="button" className="modal-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="modal-btn primary"
            disabled={!preview.valid}
            onClick={handleApply}
          >
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}
