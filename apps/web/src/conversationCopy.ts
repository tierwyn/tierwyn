import type { NormalisedEvent } from '@tierwyn/shared';
import { mainAgentEvents } from './subagents.js';

export type ConversationCopyMode = 'markdown' | 'full';

const SEPARATOR = '─'.repeat(40);

function isSubagentNotifyPrompt(event: NormalisedEvent): boolean {
  return event.type === 'prompt' && (event.payload as { source?: string }).source === 'subagent_notify';
}

function isHiddenSpawnCurlToolCall(event: NormalisedEvent): boolean {
  if (event.type !== 'tool_call') return false;
  const input = event.payload.input;
  const cmd = typeof input === 'object' && input && 'command' in input
    ? String((input as Record<string, unknown>).command)
    : '';
  return cmd.includes('/spawn') && /curl\b/.test(cmd);
}

function isHiddenSpawnCurlResult(event: NormalisedEvent): boolean {
  if (event.type !== 'tool_result') return false;
  const content = event.payload.content || '';
  return content.includes('"parentConversationId"') && /spawn/i.test(content);
}

function flushAgentBuffer(buffer: string): string {
  if (!buffer) return '';
  return `Agent:\n${buffer}\n\n`;
}

/** User prompts and agent markdown only — matches the pre-tool-call copy behaviour. */
export function formatConversationMarkdown(evs: NormalisedEvent[]): string {
  let text = '';
  let currentAgentResponse = '';
  for (const event of evs) {
    if (event.type === 'prompt') {
      if (currentAgentResponse) {
        text += flushAgentBuffer(currentAgentResponse) + SEPARATOR + '\n\n';
        currentAgentResponse = '';
      }
      if (isSubagentNotifyPrompt(event)) continue;
      text += `User: ${event.payload.text}\n\n`;
    } else if (event.type === 'message') {
      currentAgentResponse += event.payload.chunk;
    }
  }
  if (currentAgentResponse) {
    text += flushAgentBuffer(currentAgentResponse);
  }
  return text.trim();
}

function formatToolCall(event: Extract<NormalisedEvent, { type: 'tool_call' }>): string {
  return `[tool call: ${event.payload.name}]\n${JSON.stringify(event.payload.input, null, 2)}\n\n`;
}

function formatToolResult(event: Extract<NormalisedEvent, { type: 'tool_result' }>): string {
  const content = event.payload.content?.trim() ? event.payload.content : '(no output)';
  const prefix = event.payload.isError ? '[result — error]' : '[result]';
  return `${prefix}\n${content}\n\n`;
}

function formatFileChange(event: Extract<NormalisedEvent, { type: 'file_change' }>): string {
  const counts = event.payload.additions !== undefined
    ? ` (+${event.payload.additions} -${event.payload.deletions ?? 0})`
    : '';
  return `[file change: ${event.payload.kind}] ${event.payload.path}${counts}\n\n`;
}

function formatError(event: Extract<NormalisedEvent, { type: 'error' }>): string {
  const msg = typeof event.payload.message === 'string'
    ? event.payload.message
    : JSON.stringify(event.payload.message);
  let s = `[error] ${msg}\n`;
  if (event.payload.detail != null) {
    s += `${typeof event.payload.detail === 'string' ? event.payload.detail : JSON.stringify(event.payload.detail)}\n`;
  }
  return `${s}\n`;
}

function formatSteer(event: Extract<NormalisedEvent, { type: 'steer' }>): string {
  return `Steer / Injection:\n${event.payload.text}\n\n`;
}

function formatInteractionRequest(event: Extract<NormalisedEvent, { type: 'interaction_request' }>): string {
  const p = event.payload;
  let s = `[interaction: ${p.kind}] ${p.prompt || p.toolName || ''}\n`;
  if (p.questions?.length) {
    for (const q of p.questions) {
      s += `- ${q.prompt}\n`;
    }
  } else if (p.choices.length) {
    s += `Choices: ${p.choices.map((c) => c.label).join(', ')}\n`;
  }
  return `${s}\n`;
}

function formatInteractionResolved(event: Extract<NormalisedEvent, { type: 'interaction_resolved' }>): string {
  const p = event.payload;
  if (p.resolution === 'answered') {
    const answer = p.text || p.selection.join(', ');
    return `[interaction answered] ${answer}\n\n`;
  }
  return `[interaction auto-resolved (${p.resolution})]\n\n`;
}

/** Full transcript: prompts, markdown, tool calls/results, file changes, errors, steer, interactions. */
export function formatConversationFull(evs: NormalisedEvent[]): string {
  let text = '';
  let agentBuffer = '';

  const flushAgent = () => {
    if (agentBuffer) {
      text += flushAgentBuffer(agentBuffer);
      agentBuffer = '';
    }
  };

  for (const event of evs) {
    switch (event.type) {
      case 'prompt':
        flushAgent();
        if (isSubagentNotifyPrompt(event)) continue;
        text += `User: ${event.payload.text}\n\n`;
        break;
      case 'message':
        agentBuffer += event.payload.chunk;
        break;
      case 'tool_call':
        if (event.payload.name === 'AskUserQuestion') break;
        if (isHiddenSpawnCurlToolCall(event)) break;
        flushAgent();
        text += formatToolCall(event);
        break;
      case 'tool_result':
        if (isHiddenSpawnCurlResult(event)) break;
        flushAgent();
        text += formatToolResult(event);
        break;
      case 'file_change':
        flushAgent();
        text += formatFileChange(event);
        break;
      case 'error':
        flushAgent();
        text += formatError(event);
        break;
      case 'steer':
        flushAgent();
        text += formatSteer(event);
        break;
      case 'interaction_request':
        flushAgent();
        text += formatInteractionRequest(event);
        break;
      case 'interaction_resolved':
        flushAgent();
        text += formatInteractionResolved(event);
        break;
      default:
        break;
    }
  }
  flushAgent();
  return text.trim();
}

export function formatConversationCopy(evs: NormalisedEvent[], mode: ConversationCopyMode): string {
  const main = mainAgentEvents(evs);
  return mode === 'full' ? formatConversationFull(main) : formatConversationMarkdown(main);
}
