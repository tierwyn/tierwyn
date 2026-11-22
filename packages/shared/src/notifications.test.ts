import { describe, it, expect } from 'vitest';
import { buildNotification } from './notifications.js';

const CID = 'conv-1';

describe('buildNotification conversationComplete', () => {
  it('builds a done notification from title and project', () => {
    expect(buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: '↳ Implementer',
      projectName: 'Tierwyn',
      agentStatus: 'done',
    })).toEqual({
      title: '↳ Implementer',
      body: 'Completed · Tierwyn',
      tag: `tierwyn:conv:${CID}`,
      url: `/?c=${CID}`,
      conversationId: CID,
    });
  });

  it('uses a Failed body when agentStatus is error', () => {
    const out = buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: '↳ Implementer',
      projectName: 'Tierwyn',
      agentStatus: 'error',
    });
    expect(out?.body.startsWith('Failed')).toBe(true);
  });

  it('returns null for a non-terminal agentStatus', () => {
    expect(buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: '↳ Implementer',
      agentStatus: 'running',
    })).toBeNull();
  });

  it('falls back to Conversation when title is missing, never another input field', () => {
    const out = buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      projectName: 'Tierwyn',
      jobName: 'Nightly wave',
      agentStatus: 'done',
    });
    expect(out?.title).toBe('Conversation');
    expect(out?.title).not.toBe('Tierwyn');
    expect(out?.title).not.toContain('Nightly');
  });
});

describe('buildNotification scheduleFired', () => {
  it('names the job and tags by runId', () => {
    expect(buildNotification({
      category: 'scheduleFired',
      jobName: 'Nightly wave',
      runId: 'run-1',
      conversationId: CID,
    })).toEqual({
      title: '⏱ Nightly wave',
      body: 'Run started',
      tag: 'tierwyn:run:run-1:fired',
      url: `/?c=${CID}`,
      conversationId: CID,
    });
  });

  it('returns null when there is no runId', () => {
    expect(buildNotification({
      category: 'scheduleFired',
      jobName: 'Nightly wave',
    })).toBeNull();
  });
});

describe('buildNotification scheduleRunEnded', () => {
  it.each([
    ['succeeded', 'Run succeeded'],
    ['failed', 'Run failed'],
    ['timed_out', 'Run timed out'],
    ['skipped', 'Run skipped'],
  ] as const)('body for %s', (runStatus, body) => {
    const out = buildNotification({
      category: 'scheduleRunEnded',
      jobName: 'Nightly wave',
      runId: 'run-1',
      runStatus,
      conversationId: CID,
    });
    expect(out?.body).toBe(body);
    expect(out?.tag).toBe('tierwyn:run:run-1:ended');
  });

  it('returns null for running or pending', () => {
    expect(buildNotification({
      category: 'scheduleRunEnded',
      jobName: 'Nightly wave',
      runId: 'run-1',
      runStatus: 'running',
    })).toBeNull();
    expect(buildNotification({
      category: 'scheduleRunEnded',
      jobName: 'Nightly wave',
      runId: 'run-1',
      runStatus: 'pending',
    })).toBeNull();
  });
});

describe('buildNotification agentMessage', () => {
  it('builds a title/body/tag from the conversation', () => {
    expect(buildNotification({
      category: 'agentMessage',
      conversationId: CID,
      conversationTitle: 'Grok Bot · Research',
      description: 'Here are the news',
    })).toEqual({
      title: 'Grok Bot · Research',
      body: 'New message · Here are the news',
      tag: `tierwyn:conv:${CID}:msg`,
      url: `/?c=${CID}`,
      conversationId: CID,
    });
  });

  it('falls back to Agent when title is missing', () => {
    const out = buildNotification({
      category: 'agentMessage',
      conversationId: CID,
      projectName: 'Tierwyn',
    });
    expect(out?.title).toBe('Agent');
    expect(out?.body).toBe('New message · Tierwyn');
    expect(out?.tag).toBe(`tierwyn:conv:${CID}:msg`);
  });

  it('returns null without conversationId', () => {
    expect(buildNotification({
      category: 'agentMessage',
      conversationTitle: 'Grok Bot · Research',
    })).toBeNull();
  });
});

describe('buildNotification grokBotApp', () => {
  it('builds a conversation-less Grok Bot payload', () => {
    expect(buildNotification({
      category: 'grokBotApp',
      description: 'Grok Bot failed to start after 5 attempts',
    })).toEqual({
      title: 'Grok Bot',
      body: 'Grok Bot failed to start after 5 attempts',
      tag: 'tierwyn:grokbot:app',
      url: '/',
    });
  });
});

describe('buildNotification scheduleDisabled', () => {
  it('uses the auto-disabled body and a job tag with url /', () => {
    expect(buildNotification({
      category: 'scheduleDisabled',
      jobId: 'job-1',
      jobName: 'Nightly wave',
    })).toEqual({
      title: '⏱ Nightly wave',
      body: 'Schedule auto-disabled',
      tag: 'tierwyn:job:job-1:disabled',
      url: '/',
    });
  });
});

describe('buildNotification security clamps', () => {
  it('single-lines and clamps title to 80 and body to 120', () => {
    const out = buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: `${'A'.repeat(40)}\n${'B'.repeat(500)}`,
      projectName: 'P'.repeat(200),
      agentStatus: 'done',
    });
    expect(out).not.toBeNull();
    expect(out!.title.length).toBe(80);
    expect(out!.title.includes('\n')).toBe(false);
    expect(out!.body.length).toBeLessThanOrEqual(120);
    expect(out!.body.includes('\n')).toBe(false);
  });

  it('never leaks SENTINEL ids into title or body', () => {
    const out = buildNotification({
      category: 'conversationComplete',
      conversationId: 'SENTINEL_C',
      jobId: 'SENTINEL_J',
      runId: 'SENTINEL_R',
      conversationTitle: '↳ Implementer',
      projectName: 'Tierwyn',
      agentStatus: 'done',
    });
    expect(out).not.toBeNull();
    expect(out!.title).not.toContain('SENTINEL');
    expect(out!.body).not.toContain('SENTINEL');
    expect(out!.tag).toContain('SENTINEL');
    expect(out!.url).toContain('SENTINEL');
  });
});

describe('buildNotification detail suffix', () => {
  it('prefers the description over the project name on conversationComplete', () => {
    const out = buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: '↳ Implementer',
      projectName: 'Tierwyn',
      description: 'Wire descriptions into notifications',
      agentStatus: 'done',
    });
    expect(out?.body).toBe('Completed · Wire descriptions into notifications');
    expect(out?.body).not.toContain('Tierwyn');
    expect(out?.title).toBe('↳ Implementer');
  });

  it('uses Failed with the description on error', () => {
    const out = buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: '↳ Implementer',
      projectName: 'Tierwyn',
      description: 'Wire descriptions into notifications',
      agentStatus: 'error',
    });
    expect(out?.body).toBe('Failed · Wire descriptions into notifications');
  });

  it('falls back to the project name when the description is absent or blank', () => {
    expect(buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: '↳ Implementer',
      projectName: 'Tierwyn',
      agentStatus: 'done',
    })?.body).toBe('Completed · Tierwyn');

    expect(buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: '↳ Implementer',
      projectName: 'Tierwyn',
      description: '   \n  ',
      agentStatus: 'done',
    })?.body).toBe('Completed · Tierwyn');
  });

  it('falls back to the bare verb when description and project are both blank', () => {
    expect(buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: '↳ Implementer',
      description: '  ',
      projectName: '  ',
      agentStatus: 'done',
    })?.body).toBe('Completed');
  });

  it('appends the project name to a schedule fire', () => {
    expect(buildNotification({
      category: 'scheduleFired',
      jobName: 'Nightly wave',
      runId: 'run-1',
      conversationId: CID,
      projectName: 'Tierwyn',
    })).toEqual({
      title: '⏱ Nightly wave',
      body: 'Run started · Tierwyn',
      tag: 'tierwyn:run:run-1:fired',
      url: `/?c=${CID}`,
      conversationId: CID,
    });
  });

  it('appends the run description to a schedule run end, preferring it over the project', () => {
    const out = buildNotification({
      category: 'scheduleRunEnded',
      jobName: 'Nightly wave',
      runId: 'run-1',
      runStatus: 'failed',
      conversationId: CID,
      projectName: 'Tierwyn',
      description: 'Nightly dependency audit',
    });
    expect(out?.body).toBe('Run failed · Nightly dependency audit');
    expect(out?.body).not.toContain('Tierwyn');
    expect(out?.title).toBe('⏱ Nightly wave');
    expect(out?.tag).toBe('tierwyn:run:run-1:ended');
  });

  it('appends the project name to an auto-disable', () => {
    expect(buildNotification({
      category: 'scheduleDisabled',
      jobId: 'job-1',
      jobName: 'Nightly wave',
      projectName: 'Tierwyn',
    })).toEqual({
      title: '⏱ Nightly wave',
      body: 'Schedule auto-disabled · Tierwyn',
      tag: 'tierwyn:job:job-1:disabled',
      url: '/',
    });
  });

  it('drops the suffix entirely when there is no detail, on every category', () => {
    expect(buildNotification({
      category: 'scheduleFired',
      jobName: 'Nightly wave',
      runId: 'run-1',
    })?.body).toBe('Run started');

    expect(buildNotification({
      category: 'scheduleRunEnded',
      jobName: 'Nightly wave',
      runId: 'run-1',
      runStatus: 'succeeded',
    })?.body).toBe('Run succeeded');

    expect(buildNotification({
      category: 'scheduleDisabled',
      jobId: 'job-1',
      jobName: 'Nightly wave',
    })?.body).toBe('Schedule auto-disabled');
  });

  it('single-lines and clamps a long multi-line description to 120', () => {
    const out = buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      conversationTitle: 'Short title',
      description: `${'D'.repeat(60)}\n${'E'.repeat(400)}`,
      agentStatus: 'done',
    });
    expect(out).not.toBeNull();
    expect(out!.body.length).toBe(120);
    expect(out!.body.includes('\n')).toBe(false);
    expect(out!.title).toBe('Short title');
  });

  it('still falls back to the Conversation title when only a description is present', () => {
    const out = buildNotification({
      category: 'conversationComplete',
      conversationId: CID,
      description: 'Wire descriptions into notifications',
      agentStatus: 'done',
    });
    expect(out?.title).toBe('Conversation');
    expect(out?.body).toBe('Completed · Wire descriptions into notifications');
  });

  it('still falls back to the Agent run title when only a description is present', () => {
    const out = buildNotification({
      category: 'scheduleRunEnded',
      runId: 'run-1',
      runStatus: 'succeeded',
      description: 'Nightly dependency audit',
    });
    expect(out?.title).toBe('⏱ Agent run');
    expect(out?.body).toBe('Run succeeded · Nightly dependency audit');
  });

  it('never leaks SENTINEL ids into a description-bearing title or body', () => {
    const out = buildNotification({
      category: 'conversationComplete',
      conversationId: 'SENTINEL_C',
      jobId: 'SENTINEL_J',
      runId: 'SENTINEL_R',
      conversationTitle: '↳ Implementer',
      projectName: 'Tierwyn',
      description: 'A perfectly ordinary description',
      agentStatus: 'done',
    });
    expect(out).not.toBeNull();
    expect(out!.title).not.toContain('SENTINEL');
    expect(out!.body).not.toContain('SENTINEL');
    expect(out!.tag).toContain('SENTINEL');
    expect(out!.url).toContain('SENTINEL');
  });

  it('never leaks SENTINEL ids into a schedule body either', () => {
    const out = buildNotification({
      category: 'scheduleRunEnded',
      conversationId: 'SENTINEL_C',
      jobId: 'SENTINEL_J',
      runId: 'SENTINEL_R',
      jobName: 'Nightly wave',
      projectName: 'Tierwyn',
      description: 'Nightly dependency audit',
      runStatus: 'succeeded',
    });
    expect(out).not.toBeNull();
    expect(out!.title).not.toContain('SENTINEL');
    expect(out!.body).not.toContain('SENTINEL');
    expect(out!.tag).toContain('SENTINEL');
  });
});
