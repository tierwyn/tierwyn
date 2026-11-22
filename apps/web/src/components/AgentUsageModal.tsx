import { AgentUsageSettings } from './AgentUsageSettings.js';

interface Props {
  onClose: () => void;
}

export function AgentUsageModal({ onClose }: Props) {
  return <AgentUsageSettings asModal onClose={onClose} />;
}
