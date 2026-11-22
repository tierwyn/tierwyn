import type { RemoteHostLoginState } from '@tierwyn/shared';
import type { LoginActions } from '../remoteHostAgents.js';
import { AgentLoginModal } from './AgentLoginModal.js';
import { ClaudeLoginModal } from './ClaudeLoginModal.js';
import { CodexLoginModal } from './CodexLoginModal.js';

interface Props {
  targetName: string;
  login: RemoteHostLoginState;
  actions: LoginActions;
  onClosed: () => void;
}

export function AgentLoginModalFor(p: Props) {
  if (p.login.agentType === 'claude-code') return <ClaudeLoginModal {...p} />;
  if (p.login.agentType === 'codex') return <CodexLoginModal {...p} />;
  return <AgentLoginModal {...p} />;
}
