import type { TranscriptEvent } from '@tierwyn/shared';

export interface ConversationExportMeta {
  title: string;
  conversationId: string;
  projectId: string;
  projectName?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  /** Injected by tests; defaults to now. */
  exportedAt?: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ponytail: deliberate ~60-line twin of apps/web/src/conversationCopy.ts. That one
// formats NormalisedEvent (typed payloads) for the clipboard with no header and a full
// JSON tool dump; this one formats TranscriptEvent (Record<string, unknown>) for an
// archive file with a header and tool summaries. Promote to @tierwyn/shared with a
// TranscriptEvent→NormalisedEvent adapter only if a third consumer shows up.

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

const PREVIEW_KEYS = ['command', 'file_path', 'path', 'pattern', 'prompt', 'description'];
const PREVIEW_MAX = 120;

function toolPreview(input: unknown): string {
  const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  let raw = '';
  for (const key of PREVIEW_KEYS) {
    if (typeof obj[key] === 'string' && obj[key]) { raw = obj[key] as string; break; }
  }
  if (!raw) raw = Object.keys(obj).length ? JSON.stringify(obj) : '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

function isHiddenSpawnCurl(payload: Record<string, unknown>): boolean {
  const input = payload.input as Record<string, unknown> | undefined;
  const cmd = typeof input?.command === 'string' ? input.command : '';
  return cmd.includes('/spawn') && /curl\b/.test(cmd);
}

function renderHeader(meta: ConversationExportMeta): string {
  const lines = [
    `# ${meta.title || 'Untitled conversation'}`,
    '',
    `- **Conversation:** \`${meta.conversationId}\``,
    meta.projectName
      ? `- **Project:** ${meta.projectName} (\`${meta.projectId}\`)`
      : `- **Project:** \`${meta.projectId}\``,
  ];
  if (meta.description) lines.push(`- **Description:** ${meta.description}`);
  lines.push(
    `- **Created:** ${iso(meta.createdAt)}`,
    `- **Updated:** ${iso(meta.updatedAt)}`,
    `- **Exported:** ${iso(meta.exportedAt ?? Date.now())}`,
    '',
    '---',
    '',
  );
  return lines.join('\n');
}

export function renderConversationMarkdown(
  meta: ConversationExportMeta,
  events: TranscriptEvent[],
): string {
  let out = renderHeader(meta);
  let agentBuffer = '';

  const flushAgent = () => {
    if (!agentBuffer.trim()) {
      agentBuffer = '';
      return;
    }
    out += `## Agent\n\n${agentBuffer.trim()}\n\n`;
    agentBuffer = '';
  };

  for (const event of events) {
    const payload = event.payload ?? {};
    switch (event.type) {
      case 'message':
        agentBuffer += str(payload, 'chunk');
        break;
      case 'prompt':
        flushAgent();
        if (payload.source === 'subagent_notify') {
          out += `## Subagent result\n\n${str(payload, 'text')}\n\n`;
        } else if (payload.source === 'parent_message') {
          out += `## Parent message\n\n${str(payload, 'text')}\n\n`;
        } else if (payload.source === 'peer_message') {
          out += `## Peer message\n\n${str(payload, 'text')}\n\n`;
        } else {
          out += `## User\n\n${str(payload, 'text')}\n\n`;
        }
        break;
      case 'steer':
        flushAgent();
        out += `## Steer\n\n${str(payload, 'text')}\n\n`;
        break;
      case 'tool_call': {
        if (str(payload, 'name') === 'AskUserQuestion') break;
        if (isHiddenSpawnCurl(payload)) break;
        flushAgent();
        const preview = toolPreview(payload.input);
        out += preview
          ? `- **Tool** \`${str(payload, 'name')}\` — \`${preview}\`\n\n`
          : `- **Tool** \`${str(payload, 'name')}\`\n\n`;
        break;
      }
      case 'tool_result': {
        if (!payload.isError) break;
        flushAgent();
        const content = str(payload, 'content').replace(/\s+/g, ' ').trim().slice(0, 200);
        out += `- **Tool error** — ${content || '(no output)'}\n\n`;
        break;
      }
      case 'file_change': {
        flushAgent();
        const counts = typeof payload.additions === 'number'
          ? ` (+${payload.additions} -${typeof payload.deletions === 'number' ? payload.deletions : 0})`
          : '';
        out += `- **File ${str(payload, 'kind')}** \`${str(payload, 'path')}\`${counts}\n\n`;
        break;
      }
      case 'error': {
        flushAgent();
        const msg = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload.message);
        out += `- **Error** ${msg}\n\n`;
        break;
      }
      default:
        break;
    }
  }
  flushAgent();
  return `${out.trimEnd()}\n`;
}

export function exportFilename(title: string, conversationId: string): string {
  const slug = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || 'conversation'}-${conversationId.slice(0, 8)}.md`;
}
