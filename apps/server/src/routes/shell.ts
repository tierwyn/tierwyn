import type { Express } from 'express';
import { spawn } from 'child_process';
import type { Database } from 'better-sqlite3';
import { SHELL_BASE_ALLOW, SHELL_TIMEOUT_MS, SHELL_OUTPUT_CAP_BYTES, REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { getProject } from '../repositories/projects.js';
import { getConversation } from '../repositories/conversations.js';
import { remoteHostIdFor } from '../repositories/remoteHosts.js';
import { resolveConversationCwd } from '../git/shadowCheckpoint.js';
import { listShellAllow, addShellAllow, removeShellAllow } from '../repositories/shellAllow.js';
import { tokenise } from '../shell/tokeniser.js';
import { gate } from '../shell/gate.js';
import type { SessionManager } from '../sessionManager.js';
import { buildChildEnv } from '../childEnv.js';
import { assertSafeRepoConfig, gitArgv, gitEnv } from '../git/gitExec.js';

/**
 * Operator shell routes — cookie-auth only.
 * MUST be registered AFTER app.use(requireAuth(...)). Agents carry bearer
 * tokens, not the operator cookie; mounting after requireAuth structurally
 * denies them. Never mount on the pre-auth dual-auth path where /spawn lives.
 */
export function registerShellRoutes(app: Express, deps: { getDb: () => Database; sessionManager: SessionManager }) {
  const { getDb, sessionManager } = deps;

  app.post('/conversations/:id/shell', (req, res) => {
    const db = getDb();
    const conv = getConversation(db, req.params.id);
    if (!conv) { res.status(404).json({ error: 'no such conversation' }); return; }
    const project = conv.projectId ? getProject(db, conv.projectId) : undefined;
    const command = String((req.body as { command?: string })?.command ?? '');

    // v2: worktree-aware cwd — same resolution the session manager uses for the agent
    // (sessionManager.ts resolveConversationCwd). Returns conv.workdirPath ?? project.rootPath.
    const cwd = resolveConversationCwd(db, conv.id) ?? project?.rootPath ?? '-';

    const refuse = (status: number, reason: string, msg: string) => {
      sessionManager.recordShellTurn(conv.id, { command, cwd },
        { content: `⛔ ${msg}`, isError: true });
      res.status(status).json({ error: msg, reason });
    };

    if (!project) return refuse(400, 'no_project', 'Shell commands require a project (no working directory).');
    if (project.system || project.id === REMOTE_AGENTS_PROJECT_ID) {
      return refuse(400, 'grok_bot', 'Grok Bot does not support shell commands.');
    }
    if (remoteHostIdFor(db, { conversationId: conv.id })) {
      sessionManager.recordShellTurn(conv.id, { command, cwd },
        { content: '⛔ not available for remote-host projects (P3)', isError: true });
      res.status(409).json({ error: 'not available for remote-host projects (P3)' });
      return;
    }
    const tok = tokenise(command);
    if (!tok.ok) return refuse(400, tok.reason, tok.reason === 'empty' ? 'Empty command.' : 'Shell metacharacters are not allowed.');
    const g = gate(tok.argv, listShellAllow(db, project.id).map((r) => r.rule));
    if (!g.ok) return refuse(403, g.reason, g.reason === 'denied' ? 'Command contains a denied argument.' : 'Command is not on the allow-list.');

    // Accept → broadcast tool_call immediately so the UI shows "running" while
    // the process is still open. Result card arrives later via recordShellResult.
    // HTTP returns 202; client is fire-and-forget and only needs the WS stream.
    const toolUseId = sessionManager.recordShellStart(conv.id, { command, cwd });
    const start = Date.now();
    // shell:false is load-bearing — never exec, never sh -c.
    // env decision (b): operator shell gets the scrubbed child env; it never
    // needs hub secrets. Git commands also get GIT_SAFE_CONFIG -c overrides.
    let settled = false;
    const settle = (result: { content: string; isError: boolean }, body: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      sessionManager.recordShellResult(conv.id, toolUseId, result);
      if (!res.headersSent) res.status(200).json(body);
    };

    let child: ReturnType<typeof spawn>;
    try {
      const cmd = tok.argv[0]!;
      const isGit = cmd === 'git';
      if (isGit) assertSafeRepoConfig(cwd);
      const argv = isGit ? gitArgv(tok.argv.slice(1), 'operator') : tok.argv.slice(1);
      child = spawn(cmd, argv, {
        cwd,
        env: isGit ? gitEnv('operator') : buildChildEnv(undefined, cwd),
        shell: false,
        // stdin ignored: read-only commands must not block waiting on stdin
        // (`!cat` / `!grep x` / `!tail` / `!wc` would otherwise hang for the
        // full 60s timeout holding a process open). pipe+close EOF would also
        // work; 'ignore' is simplest.
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SHELL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sessionManager.recordShellResult(conv.id, toolUseId, { content: `⛔ ${msg}`, isError: true });
      res.status(200).json({
        exitCode: null, stdout: '', stderr: msg,
        durationMs: Date.now() - start, truncated: false, timedOut: false,
      });
      return;
    }

    sessionManager.registerShellChild(toolUseId, child, conv.id);

    // Tell the client the command was accepted. Result still arrives on WS;
    // if the client waits on this response we keep the connection open until
    // settle() below (so a future non-fire-and-forget client still works).
    // For fire-and-forget InputBar the early tool_call WS frame is the UX signal.
    if (!res.headersSent) {
      // Prefer not to end the response yet — some clients await exitCode.
      // The running card is already on the wire via recordShellStart.
    }

    let out = '';
    let cap = false;
    const append = (b: Buffer) => {
      if (cap) return;
      out += b.toString('utf8');
      if (Buffer.byteLength(out) > SHELL_OUTPUT_CAP_BYTES) {
        out = out.slice(0, SHELL_OUTPUT_CAP_BYTES) + '\n… [output truncated]';
        cap = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      // ENOENT etc. (binary not on PATH — see prod gotcha)
      settle(
        { content: `⛔ ${err.message}`, isError: true },
        {
          exitCode: null, stdout: '', stderr: err.message,
          durationMs: Date.now() - start, truncated: false, timedOut: false,
        },
      );
    });
    child.on('close', (code, signal) => {
      const timedOut = signal === 'SIGKILL';
      const durationMs = Date.now() - start;
      const body = timedOut ? `${out}\n⏱ timed out after ${SHELL_TIMEOUT_MS / 1000}s` : out;
      settle(
        {
          content: body || '(no output)',
          isError: (code ?? 1) !== 0 || timedOut,
        },
        {
          exitCode: code, stdout: out, stderr: '', durationMs, truncated: cap, timedOut,
        },
      );
    });
  });

  app.get('/projects/:id/shell-allow', (req, res) => {
    const db = getDb();
    const project = getProject(db, req.params.id);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }
    if (project.system || project.id === REMOTE_AGENTS_PROJECT_ID) {
      res.status(400).json({ error: 'Grok Bot does not support shell commands' });
      return;
    }
    // base is a readonly nested array — serialise as plain arrays for JSON
    res.json({
      base: SHELL_BASE_ALLOW.map((r) => [...r]),
      project: listShellAllow(db, req.params.id),
    });
  });

  app.post('/projects/:id/shell-allow', (req, res) => {
    const db = getDb();
    const project = getProject(db, req.params.id);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }
    if (project.system || project.id === REMOTE_AGENTS_PROJECT_ID) {
      res.status(400).json({ error: 'Grok Bot does not support shell commands' });
      return;
    }
    const r = addShellAllow(db, req.params.id, (req.body as { rule?: unknown })?.rule);
    if (!r.ok) {
      res.status(400).json({
        error: r.reason === 'forbidden'
          ? 'rule contains a shell/interpreter or denied token'
          : 'invalid rule',
        reason: r.reason,
      });
      return;
    }
    res.json({ rule: r.row });
  });

  app.delete('/projects/:id/shell-allow/:ruleId', (req, res) => {
    const db = getDb();
    const project = getProject(db, req.params.id);
    if (!project) { res.status(404).json({ error: 'no such project' }); return; }
    if (project.system || project.id === REMOTE_AGENTS_PROJECT_ID) {
      res.status(400).json({ error: 'Grok Bot does not support shell commands' });
      return;
    }
    res.json({ ok: removeShellAllow(db, req.params.ruleId) });
  });
}
