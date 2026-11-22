import { forwardRef, useMemo, useCallback, useEffect, useState, useImperativeHandle } from 'react';
import { useTapSelect } from '../touchTap.js';

export interface ShellRule {
  label: string;              // "git status" | "ls"
  source: 'base' | 'project';
}

interface Props {
  text: string;
  rules: ShellRule[];         // base first, then project (built in InputBar)
  onSelect: (rule: ShellRule) => void;
  onDismiss?: () => void;
}

export interface ShellPickerHandle {
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

function ShellPickerItem({
  rule,
  active,
  onActivate,
  onPick,
}: {
  rule: ShellRule;
  active: boolean;
  onActivate: () => void;
  onPick: () => void;
}) {
  const tap = useTapSelect(onPick);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`command-picker-item shell-picker-item${active ? ' active' : ''}`}
      onMouseEnter={onActivate}
      onTouchStart={tap.onTouchStart}
      onTouchMove={tap.onTouchMove}
      onTouchEnd={tap.onTouchEnd}
      onTouchCancel={tap.onTouchCancel}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      <span className="command-picker-name">!{rule.label}</span>
      {rule.source === 'project' && <span className="shell-picker-tag">project</span>}
    </button>
  );
}

export const ShellCommandPicker = forwardRef<ShellPickerHandle, Props>(function ShellCommandPicker(
  { text, rules, onSelect, onDismiss },
  ref,
) {
  const [activeIdx, setActiveIdx] = useState(0);
  const query = text.startsWith('!') ? text.slice(1).toLowerCase().trimStart() : '';

  const filtered = useMemo(() => {
    if (!text.startsWith('!')) return [];
    if (!query) return rules;
    return rules.filter((r) => r.label.toLowerCase().includes(query));
  }, [text, query, rules]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, rules.length]);

  const pick = useCallback((r: ShellRule) => {
    onSelect(r);
  }, [onSelect]);

  const isOpen = text.startsWith('!') && filtered.length > 0;

  useImperativeHandle(ref, () => ({
    handleKeyDown(e: React.KeyboardEvent): boolean {
      if (!isOpen) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        pick(filtered[activeIdx]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss?.();
        return true;
      }
      return false;
    },
  }), [isOpen, filtered, activeIdx, pick, onDismiss]);

  if (!text.startsWith('!') || filtered.length === 0) return null;

  return (
    <div className="command-picker" role="listbox" aria-label="Shell commands">
      {filtered.slice(0, 12).map((r, i) => (
        <ShellPickerItem
          key={`${r.source}:${r.label}`}
          rule={r}
          active={i === activeIdx}
          onActivate={() => setActiveIdx(i)}
          onPick={() => pick(r)}
        />
      ))}
    </div>
  );
});
