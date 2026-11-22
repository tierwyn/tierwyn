import { memo, type ReactNode } from 'react';
import type { Conversation, Project } from '@tierwyn/shared';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { TouchHoldButton } from '../touchTap.js';
import type { DotResult } from '../statusDot.js';
import { ConvOverflowMenu, type OverflowPos } from './ConvOverflowMenu.js';

export { ConvOverflowMenu, type OverflowPos };

export function DesignationChip({ designation }: { designation?: string }) {
  if (!designation) return null;
  return <span className="conversation-designation">{designation}</span>;
}

export function ConversationTagChips({
  tags,
  activeTag,
  onToggle,
}: {
  tags: string[] | undefined;
  activeTag: string | null;
  onToggle: (tag: string) => void;
}) {
  const list = tags ?? [];
  if (list.length === 0) return null;
  return (
    <span className="conversation-tags">
      {list.map((t) => (
        <span
          key={t}
          role="button"
          tabIndex={0}
          className={`conversation-tag${activeTag === t ? ' conversation-tag--active' : ''}`}
          title={activeTag === t ? `Clear filter: ${t}` : `Filter by tag: ${t}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(t);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onToggle(t);
            }
          }}
        >
          {t}
        </span>
      ))}
    </span>
  );
}

export interface SidebarConversationRowProps {
  c: Conversation;
  depth: number;
  selected: boolean;
  selecting: boolean;
  checked: boolean;
  hasKids: boolean;
  kidsCount?: number;
  folded: boolean;
  dot: DotResult;
  isAncestorContext?: boolean;
  projectLabel?: string;
  meta?: ReactNode;
  breadcrumb?: string;
  titleTooltip?: string;
  activeTag: string | null;
  overflowPos: OverflowPos | null;
  project?: Project;
  isUnread?: boolean;
  onToggleFold?: (id: string) => void;
  onToggleSelect?: (id: string) => void;
  onSelectConversation: (c: Conversation) => void;
  onToggleTag?: (tag: string) => void;
  onToggleOverflow: (id: string, btn: HTMLElement) => void;
  onCloseOverflow: () => void;
  onEnterSelect?: (id: string) => void;
  onRename?: (project: Project, c: Conversation, e: React.MouseEvent) => void;
  onOpenConversationRules?: (c: Conversation, project: Project) => void;
  onTogglePin?: (project: Project, c: Conversation, e: React.MouseEvent) => void;
  onToggleArchive?: (project: Project, c: Conversation, e: React.MouseEvent) => void;
  onMarkRead?: (project: Project, c: Conversation, e: React.MouseEvent) => void;
  onMarkUnread?: (project: Project, c: Conversation, e: React.MouseEvent) => void;
  onDuplicate?: (project: Project, c: Conversation, e: React.MouseEvent) => void;
  /** Projects-tab only: open the create-schedule modal for this conversation's project. */
  onSchedule?: (project: Project, c: Conversation) => void;
  onOpenGitPanel?: (c: Conversation) => void;
  onDelete?: (project: Project, c: Conversation, e: React.MouseEvent) => void;
}

export const SidebarConversationRow = memo(function SidebarConversationRow(
  props: SidebarConversationRowProps,
) {
  const {
    c,
    depth,
    selected,
    selecting,
    checked,
    hasKids,
    kidsCount = 0,
    folded,
    dot,
    isAncestorContext = false,
    projectLabel,
    meta,
    breadcrumb,
    titleTooltip,
    activeTag,
    overflowPos,
    project,
    isUnread = false,
    onToggleFold,
    onToggleSelect,
    onSelectConversation,
    onToggleTag,
    onToggleOverflow,
    onCloseOverflow,
    onEnterSelect,
    onRename,
    onOpenConversationRules,
    onTogglePin,
    onToggleArchive,
    onMarkRead,
    onMarkUnread,
    onDuplicate,
    onSchedule,
    onOpenGitPanel,
    onDelete,
  } = props;

  const isWaiting = !isAncestorContext && dot.dotClass.includes('waiting');
  const isError = !isAncestorContext && dot.dotClass.includes('error');
  const isRowUnread = !isAncestorContext && (dot.dotClass.includes('unread') || dot.dotClass.includes('done'));

  const rowClasses = [
    'conversation-row',
    selected ? 'selected' : '',
    selecting && c.kind !== 'schedule_home' && checked ? 'conversation-row--checked' : '',
    depth > 0 && c.parentConversationId ? 'conversation-child' : '',
    isAncestorContext ? 'conversation-row--ancestor-context' : '',
    isWaiting ? 'conversation-row--waiting' : '',
    isError ? 'conversation-row--error' : '',
    isRowUnread ? 'conversation-row--unread' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      key={c.id}
      data-conv-id={c.id}
      className={rowClasses}
      style={depth > 0 ? { paddingLeft: `${depth * 1.25}rem` } : undefined}
    >
      <TouchHoldButton
        type="button"
        className={`conversation-item ${selected ? 'active' : ''}`}
        holdEnabled={hasKids}
        holdMs={1000}
        onHold={() => onToggleFold?.(c.id)}
        onClick={() => {
          if (selecting) {
            if (c.kind !== 'schedule_home') onToggleSelect?.(c.id);
            return;
          }
          onSelectConversation(c);
        }}
        aria-pressed={selecting && c.kind !== 'schedule_home' ? checked : undefined}
        aria-label={
          selecting && c.kind !== 'schedule_home'
            ? checked
              ? `Deselect ${c.title}`
              : `Select ${c.title}`
            : undefined
        }
        title={titleTooltip || (c.description ? `${c.title}\n${c.description}` : c.title)}
      >
        <span className="conversation-item-line">
          <span
            className={`${dot.dotClass}${depth > 0 && c.parentConversationId ? ' subagent-diamond' : ''}`}
            style={{ display: 'inline-block', flexShrink: 0 }}
            title={dot.title}
          />
          {hasKids && (
            <span
              role="button"
              tabIndex={0}
              aria-expanded={!folded}
              aria-label={folded ? `Show ${kidsCount} spawn children` : 'Hide spawn children'}
              className={`fold-toggle${folded ? ' fold-toggle--folded' : ''}`}
              title={folded ? `Show ${kidsCount} spawn child(ren)` : 'Hide spawn children'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFold?.(c.id);
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleFold?.(c.id);
                }
              }}
            >
              <span className="fold-toggle-icon" aria-hidden>▾</span>
            </span>
          )}
          {breadcrumb && (
            <span className="conversation-breadcrumb" title={breadcrumb}>
              {breadcrumb}
            </span>
          )}
          <span className="conversation-title-text">{c.title}</span>
          {isWaiting && (
            <span className="needs-you-pill" title="Waiting on you">
              needs you
            </span>
          )}
          <DesignationChip designation={c.designation} />
          {!c.parentConversationId && c.pinned && (
            <span className="pin-indicator" title="Pinned — exempt from auto-cleanup">
              📌
            </span>
          )}
          {projectLabel && (
            <span className="pinned-row-project" title={`In project ${projectLabel}`}>
              {projectLabel}
            </span>
          )}
          {meta}
          {!c.parentConversationId && c.archived && (
            <span className="pin-indicator" title="Archived — hidden from the active list, kept forever">
              🗄️
            </span>
          )}
        </span>
        {c.description ? <span className="conversation-desc">{c.description}</span> : null}
        <ConversationTagChips
          tags={c.tags}
          activeTag={activeTag}
          onToggle={(t) => onToggleTag?.(t)}
        />
      </TouchHoldButton>

      <ConvOverflowMenu
        convId={c.id}
        pos={overflowPos}
        onToggle={onToggleOverflow}
        onClose={onCloseOverflow}
      >
        {onEnterSelect && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onEnterSelect(c.id);
              onCloseOverflow();
            }}
          >
            Select…
          </button>
        )}
        {onRename && project && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              onRename(project, c, e);
              onCloseOverflow();
            }}
          >
            Edit / Rename
          </button>
        )}
        {onOpenConversationRules && project && c.projectId !== REMOTE_AGENTS_PROJECT_ID && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onOpenConversationRules(c, project);
              onCloseOverflow();
            }}
          >
            Rules…
          </button>
        )}
        {!c.parentConversationId && onTogglePin && project && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              void onTogglePin(project, c, e);
              onCloseOverflow();
            }}
          >
            {c.pinned ? 'Unpin' : 'Pin'}
          </button>
        )}
        {!c.parentConversationId && onToggleArchive && project && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              void onToggleArchive(project, c, e);
              onCloseOverflow();
            }}
          >
            {c.archived ? 'Unarchive' : 'Archive'}
          </button>
        )}
        {isUnread ? (
          onMarkRead && project && (
            <button
              type="button"
              className="dropdown-item"
              role="menuitem"
              onClick={(e) => {
                void onMarkRead(project, c, e);
                onCloseOverflow();
              }}
            >
              Mark as read
            </button>
          )
        ) : (
          onMarkUnread && project && (
            <button
              type="button"
              className="dropdown-item"
              role="menuitem"
              onClick={(e) => {
                void onMarkUnread(project, c, e);
                onCloseOverflow();
              }}
            >
              Mark as unread
            </button>
          )
        )}
        {c.projectId !== REMOTE_AGENTS_PROJECT_ID && onDuplicate && project && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              void onDuplicate(project, c, e);
              onCloseOverflow();
            }}
          >
            Duplicate
          </button>
        )}
        {onSchedule && project && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onSchedule(project, c);
              onCloseOverflow();
            }}
          >
            Schedule…
          </button>
        )}
        {onOpenGitPanel && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onOpenGitPanel(c);
              onCloseOverflow();
            }}
          >
            Git working tree…
          </button>
        )}
        {onDelete && project && (
          <button
            type="button"
            className="dropdown-item"
            role="menuitem"
            onClick={(e) => {
              onDelete(project, c, e);
              onCloseOverflow();
            }}
          >
            Delete
          </button>
        )}
      </ConvOverflowMenu>
    </div>
  );
});
