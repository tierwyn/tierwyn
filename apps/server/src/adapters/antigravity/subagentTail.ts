/**
 * Tail native agy subagent transcript.jsonl files and emit nested events.
 *
 * agy does not stream subagent internals inline; it writes NDJSON to the
 * log_uri on the invoke_subagent step_update frame. We poll (no fs.watch)
 * until the adapter stops the set at parent-turn end, or the file never
 * appears. stopAll() also closes each invoke_subagent card with a
 * tool_result, because agy marks the step DONE at launch, not completion.
 */

import { readFileSync, existsSync } from 'fs';
import type { PartialEvent } from './mapping.js';
import {
  AgySubagentTranscriptMapper,
  agyTranscriptSubagentLaunches,
  type AgySubagentLaunch,
} from './mapping.js';

export type SubagentTailEmit = (event: PartialEvent) => void;

export type SubagentTailerSetOpts = {
  emit: SubagentTailEmit;
  pollMs?: number;
  /** Give up quietly if the transcript never appears. Default 30s. */
  missingMs?: number;
  /**
   * Max ensure() layers. Top-level ensure() from the adapter is depth 0;
   * a nested launch is parentDepth+1. ensure() at depth >= maxDepth is
   * skipped (the invoke_subagent tool_call is still emitted). Default 4.
   */
  maxDepth?: number;
};

type Tailer = {
  logPath: string;
  conversationId: string;
  parentToolUseId: string;
  label: string;
  mapper: AgySubagentTranscriptMapper;
  offset: number;
  leftover: string;
  missingSince: number;
  timer: ReturnType<typeof setInterval> | null;
  /** 0 = top-level adapter ensure(); nested = parent.depth + 1. */
  depth: number;
};

export class SubagentTailerSet {
  private readonly tailers = new Map<string, Tailer>();
  /**
   * Nested invoke_subagent cards that were emitted but never got a tailer
   * (depth cap, duplicate conversation_id, empty logPath). Closed on stopAll
   * without polling — same “agy DONE-at-launch” rule as tailed cards.
   */
  private readonly orphanCloses = new Map<string, string>();
  private readonly pollMs: number;
  private readonly missingMs: number;
  private readonly maxDepth: number;

  constructor(private readonly opts: SubagentTailerSetOpts) {
    this.pollMs = opts.pollMs ?? 1500;
    this.missingMs = opts.missingMs ?? 30_000;
    this.maxDepth = opts.maxDepth ?? 4;
  }

  /** True while any tailer still has an interval. Used by tests. */
  get activeCount(): number {
    let n = 0;
    for (const t of this.tailers.values()) if (t.timer) n++;
    return n;
  }

  /**
   * Start tailing `launch`. `depth` is 0 for top-level adapter ensure();
   * nested ensure() from a child transcript is parentDepth+1.
   * Returns true when a new interval was started.
   */
  ensure(launch: AgySubagentLaunch, parentToolUseId: string, depth = 0): boolean {
    if (!launch.conversation_id || this.tailers.has(launch.conversation_id)) return false;
    if (!launch.logPath) return false;
    if (depth >= this.maxDepth) return false;
    const tailer: Tailer = {
      logPath: launch.logPath,
      conversationId: launch.conversation_id,
      parentToolUseId,
      label: launch.role || launch.type_name || launch.conversation_id,
      mapper: new AgySubagentTranscriptMapper(parentToolUseId, launch.conversation_id),
      offset: 0,
      leftover: '',
      missingSince: Date.now(),
      timer: null,
      depth,
    };
    this.tailers.set(launch.conversation_id, tailer);
    this._tick(tailer);
    tailer.timer = setInterval(() => this._tick(tailer), this.pollMs);
    return true;
  }

  /**
   * Final read of every tailer (deepest-first), then stop them all and close
   * each parent's invoke_subagent card. agy never signals subagent completion
   * inline (the step goes DONE at launch), so the adapter calls this at
   * parent-turn end — the nested events flush before the parent's final
   * message is emitted. Closing tool_results are grouped by parentToolUseId
   * in deepest-first order so a grandchild card closes before its parent.
   */
  stopAll(): void {
    const seen = new Set<string>();
    // Nested launches discovered during a tick are ensure()'d into the map;
    // loop so those new tailers also get a final read + interval clear.
    // Cap tracks maxDepth (one new layer per iteration on a chain discovered
    // only at stop) rather than a magic 64 that would leak if maxDepth grew.
    const guardCap = Math.max(64, this.maxDepth + 2);
    for (let guard = 0; guard < guardCap; guard++) {
      const batch = [...this.tailers.values()]
        .filter((t) => !seen.has(t.conversationId))
        .sort((a, b) => b.depth - a.depth);
      if (batch.length === 0) break;
      for (const t of batch) {
        try { this._tick(t); } catch { /* emit/read must not skip interval clear */ }
        try { this._flushLeftover(t); } catch { /* same */ }
        this._stopOne(t);
        seen.add(t.conversationId);
      }
    }
    for (const t of this.tailers.values()) this._stopOne(t);

    const sorted = [...this.tailers.values()].sort((a, b) => b.depth - a.depth);
    const byParent = new Map<string, string[]>();
    const parentOrder: string[] = [];
    for (const t of sorted) {
      const labels = byParent.get(t.parentToolUseId);
      if (labels) labels.push(t.label);
      else {
        byParent.set(t.parentToolUseId, [t.label]);
        parentOrder.push(t.parentToolUseId);
      }
    }
    const orphans = [...this.orphanCloses.entries()];
    this.orphanCloses.clear();
    this.tailers.clear();
    // Uncapped / duplicate-id cards are "deeper" than the tailer that saw them.
    for (const [toolUseId, label] of orphans) {
      this._emitClose(toolUseId, `subagent ${label} finished`);
    }
    for (const toolUseId of parentOrder) {
      const labels = byParent.get(toolUseId) ?? [];
      const content = labels.length === 1
        ? `subagent ${labels[0]} finished`
        : `${labels.length} subagents finished: ${labels.join(', ')}`;
      this._emitClose(toolUseId, content);
    }
  }

  private _stopOne(t: Tailer): void {
    if (t.timer) {
      clearInterval(t.timer);
      t.timer = null;
    }
  }

  private _flushLeftover(t: Tailer): void {
    const trimmed = t.leftover.trim();
    t.leftover = '';
    if (!trimmed) return;
    try {
      const step = JSON.parse(trimmed) as Record<string, unknown>;
      this._handleStep(t, step);
    } catch {
      // incomplete trailing line — drop
    }
  }

  private _handleStep(t: Tailer, step: Record<string, unknown>): void {
    let events: PartialEvent[] = [];
    try {
      events = t.mapper.map(step);
    } catch {
      return;
    }
    for (const ev of events) {
      try { this.opts.emit(ev); } catch { /* emit must not skip nested ensure or kill the interval */ }
    }
    this._ensureNested(t, step, events);
  }

  private _emitClose(toolUseId: string, content: string): void {
    try {
      this.opts.emit({ type: 'tool_result', payload: { toolUseId, content, isError: false } });
    } catch {
      // remaining cards must still close
    }
  }

  private _noteOrphanClose(toolUseId: string, launch: AgySubagentLaunch): void {
    if (this.orphanCloses.has(toolUseId)) return;
    this.orphanCloses.set(
      toolUseId,
      launch.role || launch.type_name || launch.conversation_id || 'subagent',
    );
  }

  private _ensureNested(t: Tailer, step: Record<string, unknown>, events: PartialEvent[]): void {
    const launches = agyTranscriptSubagentLaunches(step);
    if (launches.length === 0) return;
    const invokeIds: string[] = [];
    for (const ev of events) {
      if (ev.type !== 'tool_call') continue;
      const p = ev.payload as { name?: string; toolUseId?: string };
      if (p.name === 'invoke_subagent' && p.toolUseId) invokeIds.push(p.toolUseId);
    }
    for (let i = 0; i < launches.length; i++) {
      const id = invokeIds[i];
      if (!id) break;
      if (!this.ensure(launches[i], id, t.depth + 1)) this._noteOrphanClose(id, launches[i]);
    }
  }

  private _tick(t: Tailer): void {
    try {
      if (!existsSync(t.logPath)) {
        if (Date.now() - t.missingSince >= this.missingMs) this._stopOne(t);
        return;
      }
      const buf = readFileSync(t.logPath, 'utf8');
      if (buf.length < t.offset) {
        // File truncated/replaced — reread from start.
        t.offset = 0;
        t.leftover = '';
      }
      const chunk = t.leftover + buf.slice(t.offset);
      t.offset = buf.length;
      const lines = chunk.split('\n');
      t.leftover = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let step: Record<string, unknown>;
        try {
          step = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        this._handleStep(t, step);
      }
    } catch {
      // ponytail: a bad read must not kill the parent conversation stream
    }
  }
}
