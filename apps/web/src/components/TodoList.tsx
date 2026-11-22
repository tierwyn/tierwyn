import { normalizeTodoStatus, todoLabel, type TodoItem } from '../subagents';

export function TodoList({ todos }: { todos: unknown[] }) {
  return (
    <div className="todos-display-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {todos.map((todo: any, idx) => {
        if (!todo || typeof todo !== 'object') return null;
        const item = todo as TodoItem;
        const status = normalizeTodoStatus(item.status);
        const label = todoLabel(item);
        const activeForm = typeof item.activeForm === 'string' ? item.activeForm : undefined;
        const missingContent = !item.content && !item.description && !item.title;

        let statusIcon = '○';
        let statusClass = 'pending';
        let statusColor = 'var(--text-3)';
        let statusBg = 'var(--surface-3)';

        if (status === 'in_progress' || status === 'progress') {
          statusIcon = '●';
          statusClass = 'in-progress';
          statusColor = 'var(--accent, #6366f1)';
          statusBg = 'var(--accent-bg)';
        } else if (status === 'completed' || status === 'done' || status === 'success') {
          statusIcon = '✓';
          statusClass = 'completed';
          statusColor = 'var(--green, #10b981)';
          statusBg = 'rgba(16, 185, 129, 0.1)';
        } else if (status === 'cancelled' || status === 'canceled') {
          statusIcon = '–';
          statusClass = 'cancelled';
          statusColor = 'var(--text-3)';
          statusBg = 'var(--surface-3)';
        }

        return (
          <div
            key={item.id != null ? String(item.id) : idx}
            className={`todo-item-card ${statusClass}`}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'var(--surface-1)',
              fontFamily: 'var(--ui)',
              fontSize: '11px',
              transition: 'all 0.15s ease',
            }}
          >
            <span
              className={`todo-status-badge ${statusClass}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                background: statusBg,
                color: statusColor,
                fontWeight: 'bold',
                fontSize: '10px',
                flexShrink: 0,
              }}
            >
              {statusIcon}
            </span>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span
                className="todo-content"
                style={{
                  fontWeight: 500,
                  color: missingContent ? 'var(--text-3)' : 'var(--text-1)',
                  fontStyle: missingContent ? 'italic' : undefined,
                }}
              >
                {label}
              </span>
              {activeForm && activeForm !== label && (
                <span className="todo-active-form" style={{ fontSize: '10px', color: 'var(--text-3)', fontStyle: 'italic' }}>
                  Context: {activeForm}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
