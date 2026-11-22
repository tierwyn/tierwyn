import type { NormalisedEvent } from '@tierwyn/shared';

export type PartialEvent = NormalisedEvent extends infer E
  ? E extends NormalisedEvent
    ? Omit<E, 'sessionId' | 'seq' | 'ts'>
    : never
  : never;

// Pi's built-in file-mutating tools (best-effort; verify against installed Pi tool names).
const PI_FILE_TOOLS = new Set(['edit', 'write', 'create', 'str_replace', 'apply_patch']);

function fileChangeFromTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  toolUseId?: string,
): PartialEvent | null {
  if (!PI_FILE_TOOLS.has(toolName) || !args) return null;
  const path = (args.path ?? args.file_path ?? args.filename) as string | undefined;
  if (!path) return null;
  const kind = toolName === 'write' || toolName === 'create' ? 'created' : 'modified';
  return { type: 'file_change', payload: { path, kind, ...(toolUseId ? { toolUseId } : {}) } };
}

export function mapPiEvent(frame: Record<string, unknown>): PartialEvent[] {
  const type = frame.type as string;

  switch (type) {
    case 'agent_start':
      return [{ type: 'status', payload: { status: 'running' } }];

    case 'message_update': {
      const ame = frame.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!ame) return [];
      const k = ame.type as string;
      if (k === 'text_delta') return [{ type: 'message', payload: { chunk: String(ame.delta ?? ''), final: false } }];
      if (k === 'done') return [{ type: 'message', payload: { chunk: '', final: true } }];
      if (k === 'error') {
        return [
          { type: 'error', payload: { message: `assistant ${String(ame.reason ?? 'error')}` } },
          { type: 'status', payload: { status: 'error' } },
        ];
      }
      return [];
    }

    case 'tool_execution_start': {
      const toolName = frame.toolName as string;
      const args = (frame.args as Record<string, unknown>) ?? {};
      const out: PartialEvent[] = [
        { type: 'tool_call', payload: { toolUseId: frame.toolCallId as string, name: toolName, input: args } },
      ];
      const fc = fileChangeFromTool(toolName, args, frame.toolCallId as string | undefined);
      if (fc) out.push(fc);
      return out;
    }

    case 'tool_execution_end': {
      const result = frame.result as { content?: { type: string; text?: string }[] } | undefined;
      const content = (result?.content ?? []).map((c) => c.text ?? '').join('');
      return [{
        type: 'tool_result',
        payload: { toolUseId: frame.toolCallId as string, content, isError: (frame.isError as boolean) ?? false },
      }];
    }

    case 'extension_error':
      return [{ type: 'error', payload: { message: String(frame.error ?? 'extension error') } }];

    case 'message_end':
    case 'turn_end': {
      // Pi emits message_end/turn_end with `message.stopReason === 'error'` and
      // `message.errorMessage` set when the upstream model returns a non-success
      // status (e.g. zai 429 "subscription plan does not yet include access to
      // <model>"). Without this case the error is silently dropped and pi's
      // auto-retry exhausts in the background while the UI shows status:done.
      // Pi retries up to 3 times — the adapter dedupes the resulting repeated
      // error events within a single sendPrompt turn (see index.ts _onPiEvent).
      const msg = frame.message as Record<string, unknown> | undefined;
      if (!msg) return [];
      const stopReason = msg.stopReason as string | undefined;
      const errMsg = msg.errorMessage as string | undefined;
      if (stopReason !== 'error' && !errMsg) return [];
      return [{ type: 'error', payload: { message: String(errMsg ?? 'pi turn ended with an error') } }];
    }

    case 'permission_request': {
      const requestId = String(frame.id ?? '');
      const toolName = String(frame.toolName ?? 'tool');
      const args = (frame.args as Record<string, unknown>) ?? {};
      return [{
        type: 'interaction_request',
        payload: {
          requestId,
          kind: 'permission',
          prompt: `Allow ${toolName}?`,
          choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
          toolName,
          toolInput: args,
          allowFreeText: true,
        },
      }];
    }

    default:
      return []; // turn_start/queue_update/compaction_*/etc. are not surfaced to the UI directly
  }
}

interface PiMessage {
  role: 'user' | 'assistant' | 'toolResult' | string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/** Flatten Pi's active-branch message array into ordered normalised partial events. */
export function flattenActiveThread(messages: PiMessage[]): PartialEvent[] {
  const out: PartialEvent[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
          : '';
      out.push({ type: 'prompt', payload: { text } });
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content as Record<string, unknown>[]) {
        if (block.type === 'text') out.push({ type: 'message', payload: { chunk: String(block.text ?? ''), final: true } });
        else if (block.type === 'toolCall') {
          const args = (block.arguments as Record<string, unknown>) ?? {};
          out.push({ type: 'tool_call', payload: { toolUseId: String(block.id), name: String(block.name), input: args } });
          const fc = fileChangeFromTool(String(block.name), args);
          if (fc) out.push(fc);
        }
      }
    } else if (m.role === 'toolResult') {
      const content = Array.isArray(m.content)
        ? (m.content as { text?: string }[]).map((c) => c.text ?? '').join('')
        : String(m.content ?? '');
      out.push({ type: 'tool_result', payload: { toolUseId: String(m.toolCallId), content, isError: m.isError ?? false } });
    }
  }
  return out;
}
