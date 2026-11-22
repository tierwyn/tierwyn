import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { upsertHost } from './components/RemoteHostsSettings.js';
import type { RemoteHostView } from '@tierwyn/shared';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('remote hosts web wiring', () => {
  it('exposes cookie-auth remote-host API helpers and omits unset remoteHostId', () => {
    const api = src('./api.ts');
    expect(api).toContain('listRemoteHosts');
    expect(api).toContain('createRemoteHost');
    expect(api).toContain('autoTrust');
    expect(api).toContain('trustRemoteHost');
    expect(api).toContain('patchRemoteHost');
    expect(api).toContain('refreshRemoteHost');
    expect(api).toContain('installRemoteAgent');
    expect(api).toContain('loginRemoteAgent');
    expect(api).toContain('cancelRemoteAgentLogin');
    expect(api).toContain('submitRemoteAgentLoginCode');
    expect(api).toContain('updateRemoteHost');
    expect(api).toContain('deleteRemoteHost');
    expect(api).toContain("unbind ? '?unbind=1' : ''");
    expect(api).toContain('/remote-hosts/${id}/update');
    expect(api).toMatch(/createProject: \(name: string, rootPath: string, remoteHostId\?: string, cloneUrl\?: string/);
    expect(api).toContain('...(remoteHostId ? { remoteHostId } : {})');
    expect(api).toContain('...(cloneUrl ? { cloneUrl } : {})');
  });

  it('dispatches remote_host_status next to grokbot_status', () => {
    const ws = src('./ws.ts');
    expect(ws).toContain('onRemoteHostStatus');
    expect(ws).toContain('RemoteHostStatusFrame');
    const grok = ws.indexOf("frame.type === 'grokbot_status'");
    const remote = ws.indexOf("frame.type === 'remote_host_status'");
    expect(grok).toBeGreaterThan(-1);
    expect(remote).toBeGreaterThan(grok);
  });

  it('adds a Remote Hosts settings tab with an icon', () => {
    const settings = src('./components/SettingsModal.tsx');
    expect(settings).toContain("'remoteHosts'");
    expect(settings).toContain("label: 'Remote Hosts'");
    expect(settings).toMatch(/remoteHosts:\s*\(/);
    expect(settings).toContain('{tab === \'remoteHosts\' && <RemoteHostsSettings');
  });

  it('shows enrollment one-liner once and never stores the token', () => {
    const panel = src('./components/RemoteHostsSettings.tsx');
    expect(panel).toContain('<pre');
    expect(panel).toContain('expiresAt');
    expect(panel).not.toMatch(/setEnroll\([^)]*token/);
    expect(panel).toContain('tierwyn node allow');
    expect(panel).toContain('Then use Install ▸ here');
    expect(panel).toContain('log in on the box');
    expect(panel).toContain('remoteHostAgentRows');
    expect(panel).toContain('Install ▸');
    expect(panel).toContain('api.installRemoteAgent');
    expect(panel).toContain('api.loginRemoteAgent');
    // Restart must end the running child first: the node re-attaches a same-agent start.
    expect(panel).toMatch(/restartLogin = [\s\S]{0,300}api\.cancelRemoteAgentLogin\(hostId, agentType\)[\s\S]{0,120}loginAgent\(hostId, agentType\)/);
    // Dismiss leaves a running login alone; only a failed leftover is cleared.
    expect(panel).toMatch(/dismissLogin = [\s\S]{0,250}if \(!running\) [^\n]*cancelRemoteAgentLogin/);
    expect(panel).toContain('Log in ▸');
    expect(panel).toContain('AgentLoginModalFor');
    expect(panel).toContain('loginFor');
    expect(panel).toContain('h.logins');
    expect(panel).not.toMatch(/h\.login\b/);
    expect(panel).not.toMatch(/host\.login\b/);
    expect(panel).toContain('shouldShowLoginResume');
    expect(panel).toContain('shouldShowLoginModal');
    expect(panel).toContain('inFlightLogins');
    expect(panel).toContain('Re-open');
    expect(panel).toContain('Restart');
    expect(panel).toContain('Dismiss');
    expect(panel).toContain('rh-login-resume');
    expect(panel).toContain('reopenLogin');
    expect(panel).toContain('restartLogin');
    expect(panel).toContain('dismissLogin');
    expect(panel).toContain('api.loginRemoteAgent');
    expect(panel).toContain('agentLoginAvailable');
    expect(panel).not.toContain('codexLoginAvailable');
    expect(panel).toContain('notLoggedInTitle');
    expect(src('./remoteHostAgents.ts')).toContain('export function notLoggedInTitle');
    expect(panel).not.toMatch(/`run "\$\{type\} login"/);
    expect(panel).toContain('api.updateRemoteHost');
    expect(panel).toContain('Update node');
    expect(panel).toContain('not installed (manual)');
    expect(panel).toContain('rh-install-error');
    expect(panel).toContain('sidecarAdvisoryText');
    expect(panel).toContain('rh-advisory');
    expect(panel).toContain('Auto-trust when enrolled');
    expect(panel).toContain('useState(false)');
    expect(panel).toContain('approve the host');
    expect(panel).toContain('role="switch"');
    expect(panel).toContain('toggle-switch');
    expect(panel).toContain('autoTrust');
    expect(panel).toMatch(/hostId:/);
    expect(panel).toContain('Refresh');
    expect(panel).toContain('5000');
    expect(panel).toContain('onHostsChange((cur) =>');
    expect(panel).toContain('descriptionPatch');
    expect(panel).toContain('rh-card-description');
    expect(panel).toContain('<SelectDropdown');
    expect(panel).toContain('searchable');
    expect(panel).toContain('rh-chip-remove');
    expect(panel).not.toContain('rh-agent-mode');
    expect(panel).not.toContain('type="radio"');
    expect(panel).not.toContain('type="checkbox"');
    expect(panel).toContain('Allow MCP secrets');
    expect(panel).toContain('hostDeleteConfirm');
    expect(panel).toContain('deleteTarget');
    expect(panel).toContain('unbind: true');
  });

  it('adds Runs on This server and a host chip on project rows', () => {
    const sidebar = src('./components/Sidebar.tsx');
    expect(sidebar).toContain('Runs on');
    expect(sidebar).toContain('This server');
    expect(sidebar).toContain('host-chip');
    expect(sidebar).toContain('api.createProject(name, rootPath, newProjectHostId || undefined, cloneUrl, !cloneUrl)');
  });

  it('greys unavailable picker entries with the reason label', () => {
    const ms = src('./components/ModelSelector.tsx');
    expect(ms).toContain('unavailable?: Record<string, string>');
    expect(ms).toContain('if (!blocked) select(profile.id)');
    expect(ms).toContain('unavailable?.[p.id]');
    const bar = src('./components/InputBar.tsx');
    expect(bar).toContain('unavailable={unavailable}');
    const app = src('./App.tsx');
    expect(app).toContain('remoteProfileAvailability');
    expect(app).toContain('onRemoteHostStatus');
  });

  it('opens FileModal for remote files with a host chip and hub-only git actions hidden', () => {
    const pane = src('./components/OutputPane.tsx');
    expect(pane).toContain('remoteHostName?: string');
    expect(pane).toContain('const onOpenFile = handleOpenFile;');
    expect(pane).toContain('remoteHostName={remoteHostName}');
    const modal = src('./components/FileModal.tsx');
    expect(modal).toContain('remoteHostName?: string');
    expect(modal).toContain('{remoteHostName && <span className="host-chip" title={`Read-only — file on ${remoteHostName}`}>{remoteHostName}</span>}');
    expect(modal).toContain('(state.kind === \'md\' || state.kind === \'code\') && !remoteHostName && edit.mode !== \'git-diff\'');
    expect(modal).toContain('if (remoteHostName) return; // git-diff is hub-only until P2b-2');
    const item = src('./components/EventItem.tsx');
    expect(item).toContain('isOpenableExt(event.payload.path) && onOpenFile');
    const label = src('./remoteHostLabel.ts');
    expect(label).toContain("'remote host'");
  });

  it('no longer gates checkpoint code diff/restore for remote hosts (P3)', () => {
    const app = src('./App.tsx');
    // P3: code snapshots ride git.call, so the hub no longer disables the
    // Code badge / diff / restore for remote-host projects.
    expect(app).not.toContain('skipCodeDiff={Boolean(project?.remoteHostId)}');
    expect(app).not.toContain('hasCode: hasCode && !project?.remoteHostId');
    const list = src('./components/CheckpointListModal.tsx');
    expect(list).toContain('skipCodeDiff');
    const restore = src('./components/RestoreChoiceModal.tsx');
    expect(restore).toContain("remote_host: 'Code restore is not available for remote-host projects yet.'");
    expect(restore).toContain('not available for remote-host projects (P3)');
  });

  it('performs initial list fetch on mount and handles live push without duplicate fetches or stale overwrites', () => {
    const panel = src('./components/RemoteHostsSettings.tsx');
    const app = src('./App.tsx');
    const settings = src('./components/SettingsModal.tsx');

    // 1. Initial list fetch on mount in RemoteHostsSettings
    expect(panel).toContain('api.listRemoteHosts()');
    // Does not include `hosts` in effect deps, preventing duplicate refetches on live push/prop update
    expect(panel).not.toMatch(/useEffect\(\(\) => \{[^}]*api\.listRemoteHosts\(\)[^}]*\}, \[[^\]]*\bhosts\b[^\]]*\]\)/);
    // Cancellation guard prevents stale responses committing after unmount
    expect(panel).toMatch(/cancelled\s*=\s*true/);

    // 2. SettingsModal wiring
    expect(settings).toContain("<RemoteHostsSettings hosts={remoteHosts} onHostsChange={onRemoteHostsChange}");

    // 3. App.tsx wiring and live push handling
    expect(app).toContain('remoteHosts={remoteHosts}');
    expect(app).toContain('onRemoteHostsChange={setRemoteHosts}');
    expect(app).toContain('onRemoteHostStatus: (frame) => {');
    expect(app).toMatch(/setRemoteHosts\(\(prev\) => \{[\s\S]*prev\.findIndex\(.*frame\.host\.id\)[\s\S]*\}\)/);
  });

  it('upsertHost updates existing hosts and appends new hosts without mutating the input', () => {
    const hostA: RemoteHostView = {
      id: 'h1',
      name: 'Host 1',
      state: 'untrusted',
      hello: {},
      allowMcpSecrets: false,
      allowAgentEnvSecrets: false,
      createdAt: 1000,
    };
    const hostB: RemoteHostView = {
      id: 'h2',
      name: 'Host 2',
      state: 'connected',
      hello: {},
      allowMcpSecrets: false,
      allowAgentEnvSecrets: false,
      createdAt: 2000,
    };
    const list = [hostA];

    // Updates existing host in-place
    const updated = upsertHost(list, { ...hostA, state: 'connected' });
    expect(updated).toHaveLength(1);
    expect(updated[0].state).toBe('connected');
    expect(list[0].state).toBe('untrusted'); // immutability preserved

    // Appends new host
    const added = upsertHost(updated, hostB);
    expect(added).toHaveLength(2);
    expect(added[0].id).toBe('h1');
    expect(added[1].id).toBe('h2');
  });

  it('adds the agent env secrets toggle, gated on node support (A3)', () => {
    const panel = src('./components/RemoteHostsSettings.tsx');
    expect(panel).toContain('Allow agent env secrets');
    expect(panel).toContain('aria-label="Allow agent env secrets"');
    expect(panel).toMatch(/hostHasFeature\(host\.hello, 'agent_env'\)/);
    // Unsupported node: greyed out unless the toggle was left on server-side.
    expect(panel).toMatch(/!supported && !host\.allowAgentEnvSecrets/);
    expect(panel).toMatch(/patchRemoteHost\(host\.id, \{ allowAgentEnvSecrets: !host\.allowAgentEnvSecrets \}\)/);
    const api = src('./api.ts');
    expect(api).toContain('allowAgentEnvSecrets?: boolean');
  });

  it('AgentLoginModal is a generic device-code modal with an open-URL button', () => {
    const modal = src('./components/AgentLoginModal.tsx');
    expect(modal).toContain('rel="noopener noreferrer"');
    expect(modal).toContain('target="_blank"');
    expect(modal).toContain('codex-login-');
    expect(modal).toContain('login.userCode');
    expect(modal).not.toContain('api.submitRemoteAgentLoginCode');
    expect(modal).toMatch(/login\.agentType === 'copilot' && hint\?\.env/);
    expect(modal).toMatch(/Sandboxed runs need/);
    expect(modal).toMatch(/\{userCode \? \(/);
    expect(modal).not.toMatch(/cursor\.com\/loginDeepControl/);
  });

  it('ClaudeLoginModal uses a live URL, paste-back, and no hard-coded sign-in URL', () => {
    const modal = src('./components/ClaudeLoginModal.tsx');
    expect(modal).toContain('rel="noopener noreferrer"');
    expect(modal).toContain('actions.submitCode');
    expect(modal).toContain('autoComplete="off"');
    expect(modal).not.toMatch(/https:\/\//);
    // A refused Try again renders in the error state too, not only beside the input.
    expect(modal).toMatch(/\{body\}\s*\{submitError \?/);
  });
});
