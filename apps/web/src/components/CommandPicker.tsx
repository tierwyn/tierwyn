import { forwardRef, useMemo, useCallback, useEffect, useState, useImperativeHandle } from 'react';
import { slashCommandUnsupportedMessage, type CommandRecord } from '@tierwyn/shared';
import { useTapSelect } from '../touchTap.js';

interface Props {
  agentType: string;
  text: string;
  commands: CommandRecord[];
  /** Muted, non-selectable row shown above the list (e.g. remote host unreachable). */
  notice?: string;
  onSelect: (command: CommandRecord) => void;
  onDismiss?: () => void;
}

export interface CommandPickerHandle {
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

/** One row — own tap guard so scroll-release on a neighbour never selects this. */
function CommandPickerItem({
  cmd,
  active,
  onActivate,
  onPick,
}: {
  cmd: CommandRecord;
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
      className={`command-picker-item${active ? ' active' : ''}`}
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
      <span className="command-picker-name">/{cmd.name}</span>
      {cmd.description && <span className="command-picker-desc">{cmd.description}</span>}
    </button>
  );
}

export const CommandPicker = forwardRef<CommandPickerHandle, Props>(function CommandPicker(
  { agentType, text, commands, notice, onSelect, onDismiss },
  ref,
) {
  const [activeIdx, setActiveIdx] = useState(0);
  const query = text.startsWith('/') ? text.slice(1).toLowerCase() : '';

  const filtered = useMemo(() => {
    if (!text.startsWith('/')) return [];
    if (!query) return commands;
    return commands.filter((c) =>
      c.name.toLowerCase().includes(query) ||
      c.label.toLowerCase().includes(query) ||
      c.description.toLowerCase().includes(query),
    );
  }, [text, query, commands]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, commands.length]);

  const pick = useCallback((cmd: CommandRecord) => {
    onSelect(cmd);
  }, [onSelect]);

  // Pass text so Tierwyn-native verbs (/btw) are exempt — they never go to the agent.
  const unsupportedMessage = text.startsWith('/') ? slashCommandUnsupportedMessage(agentType, text) : null;
  const isOpen = text.startsWith('/') && !unsupportedMessage && filtered.length > 0;

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

  if (!text.startsWith('/')) return null;

  if (unsupportedMessage) {
    return (
      <div className="command-picker" role="alert">
        <div className="command-picker-note command-picker-unsupported">{unsupportedMessage}</div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return notice ? (
      <div className="command-picker"><div className="command-picker-note">{notice}</div></div>
    ) : null;
  }

  return (
    <div className="command-picker" role="listbox" aria-label="Slash commands">
      {notice && <div className="command-picker-note">{notice}</div>}
      {filtered.slice(0, 12).map((cmd, i) => (
        <CommandPickerItem
          key={cmd.id}
          cmd={cmd}
          active={i === activeIdx}
          onActivate={() => setActiveIdx(i)}
          onPick={() => pick(cmd)}
        />
      ))}
    </div>
  );
});
