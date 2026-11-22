import { useState, type FormEvent } from 'react';
import { Modal } from './Modal.js';

const BRANCH_RE = /^(?![-./])(?!.*(?:\.\.|\/\/|@\{|\.lock$|\/$|\.$))[\p{L}\p{N}._\/+-]{1,200}$/u;

export interface GitNameModalField {
  key: string;
  label: string;
  placeholder?: string;
  initial?: string;
}

export interface GitNameModalProps {
  title: string;
  fields: GitNameModalField[];
  checkbox?: { key: string; label: string; initial: boolean };
  busy?: boolean;
  error?: string | null;
  submitLabel?: string;
  overlayClassName?: string;
  onSubmit: (values: Record<string, string | boolean>) => void | Promise<void>;
  onClose: () => void;
}

export function GitNameModal({
  title,
  fields,
  checkbox,
  busy,
  error,
  submitLabel = 'Submit',
  overlayClassName = 'modal-overlay--stack-2',
  onSubmit,
  onClose,
}: GitNameModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])),
  );
  const [checked, setChecked] = useState<boolean>(() => checkbox?.initial ?? false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const result: Record<string, string | boolean> = { ...values };
    if (checkbox) {
      result[checkbox.key] = checked;
    }
    onSubmit(result);
  };

  const firstKey = fields[0]?.key;
  const firstVal = (values[firstKey] ?? '').trim();
  const isValid = firstVal.length > 0 && BRANCH_RE.test(firstVal);

  return (
    <Modal title={title} onClose={onClose} className="git-name-modal" overlayClassName={overlayClassName}>
      <form onSubmit={handleSubmit} className="git-name-modal-form">
        {error && <div className="modal-error-banner" style={{ marginBottom: '12px' }}>{error}</div>}
        {fields.map((field, idx) => (
          <div key={field.key} className="form-field" style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', opacity: 0.85 }}>
              {field.label}
            </label>
            <input
              type="text"
              autoFocus={idx === 0}
              className="text-input"
              style={{ width: '100%' }}
              placeholder={field.placeholder}
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              disabled={busy}
            />
          </div>
        ))}
        {checkbox && (
          <div className="form-field" style={{ marginBottom: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                disabled={busy}
              />
              {checkbox.label}
            </label>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
          <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="modal-btn modal-btn--primary"
            disabled={busy || !isValid}
          >
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
