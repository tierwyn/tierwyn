import type { SpawnTemplate } from '@tierwyn/shared';

interface Props {
  templates: SpawnTemplate[];
  profileLabels: Record<string, string>;
  selectedTemplateName?: string;
  onClose: () => void;
}

function workdirLabel(workdir: SpawnTemplate['roles'][number]['defaultWorkdir']): string {
  return workdir === 'worktree' ? 'worktree' : 'shared';
}

export function TemplatePreviewModal({ templates, profileLabels, selectedTemplateName, onClose }: Props) {
  return (
    <div className="modal-overlay template-preview-overlay" onClick={onClose}>
      <div className="modal-content template-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Delegation Templates</span>
          <button type="button" className="usage-close" onClick={onClose} style={{ fontSize: '18px' }} aria-label="Close">×</button>
        </div>
        <div className="template-preview-body">
          {templates.length === 0 ? (
            <div className="template-preview-empty">No templates saved yet.</div>
          ) : (
            <div className="template-preview-list">
              {templates.map((t) => (
                <details
                  key={t.name}
                  className={`template-preview-item${t.name === selectedTemplateName ? ' template-preview-item--selected' : ''}`}
                  open={t.name === selectedTemplateName || templates.length === 1}
                >
                  <summary className="template-preview-summary">
                    <span className="template-preview-name">{t.name}</span>
                    <span className="template-preview-roles-hint">
                      {t.roles.map((r) => r.role).filter(Boolean).join(', ') || '(no roles)'}
                    </span>
                  </summary>
                  <div className="template-preview-details">
                    <div className="template-preview-section">
                      <span className="modal-label">Roles</span>
                      {t.roles.length === 0 ? (
                        <div className="template-preview-muted">(no roles)</div>
                      ) : (
                        <ul className="template-preview-roles">
                          {t.roles.map((r, i) => (
                            <li key={i} className="template-preview-role">
                              <div className="template-preview-role-line">
                                <span className="template-preview-role-name">{r.role || '(unnamed)'}</span>
                                <span className="template-preview-role-model">
                                  {r.profileId ? (profileLabels[r.profileId] ?? r.profileId) : '(no model)'}
                                </span>
                              </div>
                              {r.when ? (
                                <div className="template-preview-role-when">use when: {r.when}</div>
                              ) : null}
                              <div className="template-preview-role-workdir">workdir: {workdirLabel(r.defaultWorkdir)}</div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {t.delegationInstructions?.trim() ? (
                      <div className="template-preview-section">
                        <span className="modal-label">Delegation instructions</span>
                        <pre className="template-preview-instructions">{t.delegationInstructions.trim()}</pre>
                      </div>
                    ) : (
                      <div className="template-preview-section">
                        <span className="modal-label">Delegation instructions</span>
                        <div className="template-preview-muted">(built-in Result/file-path guidance)</div>
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
