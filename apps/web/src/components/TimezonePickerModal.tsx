import { useMemo, useState } from 'react';
import { COMMON_TIMEZONES, listAllTimezones } from '@tierwyn/shared';
import { Modal } from './Modal.js';

export interface TimezonePickerModalProps {
  open: boolean;
  value: string;
  onClose: () => void;
  onSelect: (timezone: string) => void;
}

function defaultBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function TimezonePickerModal({ open, value, onClose, onSelect }: TimezonePickerModalProps) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  const browserTz = useMemo(() => defaultBrowserTimezone(), []);

  const zones = useMemo(() => {
    const base = showAll ? listAllTimezones() : [...COMMON_TIMEZONES];
    const extras = new Set<string>();
    if (value?.trim()) extras.add(value.trim());
    if (browserTz) extras.add(browserTz);
    for (const z of extras) {
      if (!base.includes(z)) base.unshift(z);
    }
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((z) => z.toLowerCase().includes(q));
  }, [showAll, query, value, browserTz]);

  if (!open) return null;

  return (
    <Modal title="Choose timezone" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          className="modal-input"
          type="search"
          placeholder="Search timezones…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className="modal-btn"
            onClick={() => onSelect(browserTz)}
          >
            Use browser ({browserTz})
          </button>
          <button
            type="button"
            className="modal-btn"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show common only' : 'Show all IANA zones'}
          </button>
        </div>
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            maxHeight: 320,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          {zones.length === 0 ? (
            <li style={{ padding: 12, fontSize: 12, color: 'var(--text-3)' }}>No matches</li>
          ) : zones.map((tz) => (
            <li key={tz}>
              <button
                type="button"
                className="modal-btn"
                style={{
                  width: '100%',
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  background: tz === value ? 'var(--surface-3)' : undefined,
                  borderRadius: 0,
                  border: 'none',
                  borderBottom: '1px solid var(--border)',
                }}
                onClick={() => {
                  onSelect(tz);
                  onClose();
                }}
              >
                {tz}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

/** Read-only field + button that opens the timezone picker. */
export function TimezoneField({
  value,
  onChange,
  required,
}: {
  value: string;
  onChange: (tz: string) => void;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <input
          type="text"
          className="modal-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          placeholder="e.g. Europe/London"
          style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 12 }}
        />
        <button
          type="button"
          className="modal-btn"
          onClick={() => setOpen(true)}
          title="Browse timezones"
        >
          Browse…
        </button>
      </div>
      <TimezonePickerModal
        open={open}
        value={value}
        onClose={() => setOpen(false)}
        onSelect={onChange}
      />
    </>
  );
}
