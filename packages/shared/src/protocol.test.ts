import { describe, it, expect } from 'vitest';
import type { ClientFrame, CommandMessage, ServerFrame } from './index.js';

describe('protocol frames', () => {
  it('discriminates client and server frames', () => {
    const sub: ClientFrame = { type: 'subscribe', conversationId: 'c1' };
    const stop: ClientFrame = { type: 'stop', sessionId: 's1' };
    const ev: ServerFrame = {
      type: 'session_ended', conversationId: 'c1', sessionId: 's1',
    };
    expect([sub.type, stop.type, ev.type]).toEqual(['subscribe', 'stop', 'session_ended']);
  });

  it('accepts CommandMessage in ClientFrame union', () => {
    const cmd: CommandMessage = {
      type: 'command',
      projectId: 'p1',
      conversationId: 'c1',
      agent: 'claude-code',
      model: 'sonnet',
      profileId: 'prof1',
      name: 'review',
      args: 'src/',
    };
    const frame: ClientFrame = cmd;
    expect(frame.type).toBe('command');
    expect(frame).toMatchObject({
      type: 'command',
      projectId: 'p1',
      conversationId: 'c1',
      agent: 'claude-code',
      model: 'sonnet',
      profileId: 'prof1',
      name: 'review',
      args: 'src/',
    });
  });

  it('accepts SteerMessage in ClientFrame union and steer frames in ServerFrame union', () => {
    const steer: ClientFrame = {
      type: 'steer', conversationId: 'c1', sessionId: 's1', text: 'also check the tests',
    };
    const queued: ServerFrame = {
      type: 'steer_queued', conversationId: 'c1', sessionId: 's1', queueLength: 2, text: 'also check the tests',
    };
    const result: ServerFrame = {
      type: 'steer_result', sessionId: 's1', mode: 'queued', queueLength: 2,
    };
    expect([steer.type, queued.type, result.type]).toEqual(['steer', 'steer_queued', 'steer_result']);
  });

  it('accepts EditSteerMessage in ClientFrame union', () => {
    const edit: ClientFrame = {
      type: 'edit_steer',
      conversationId: 'c1',
      sessionId: 's1',
      messageId: 'q1',
      text: 'second edited',
    };
    expect(edit.type).toBe('edit_steer');
  });

  it('accepts ping/pong frames', () => {
    const ping: ClientFrame = { type: 'ping', id: 'p1', clientTs: 1 };
    const pong: ServerFrame = { type: 'pong', id: 'p1', clientTs: 1, serverTs: 2 };
    expect([ping.type, pong.type]).toEqual(['ping', 'pong']);
  });

  it('accepts stop_helper and helpersRunning on conversation_updated / active_sessions', () => {
    const stopHelper: ClientFrame = { type: 'stop_helper', conversationId: 'c1', taskId: 't1' };
    const updated: ServerFrame = {
      type: 'conversation_updated',
      conversationId: 'c1',
      ts: 1,
      helpersRunning: 2,
    };
    const active: ServerFrame = {
      type: 'active_sessions',
      sessions: [{
        conversationId: 'c1',
        sessionId: 's1',
        profileId: 'p1',
        model: 'sonnet',
        status: 'done',
        helpersRunning: 1,
      }],
    };
    expect(stopHelper.type).toBe('stop_helper');
    expect(updated.helpersRunning).toBe(2);
    expect(active.sessions[0]?.helpersRunning).toBe(1);
  });

  it('accepts conversations_changed and pendingHandoffMode on conversation_updated', () => {
    const changed: ServerFrame = {
      type: 'conversations_changed',
      projectIds: ['p1'],
      createdIds: ['c-new'],
      deletedIds: ['c-gone'],
    };
    const updated: ServerFrame = {
      type: 'conversation_updated',
      conversationId: 'c1',
      ts: 1,
      pendingHandoffMode: 'fresh',
    };
    const cleared: ServerFrame = {
      type: 'conversation_updated',
      conversationId: 'c1',
      ts: 2,
      pendingHandoffMode: null,
    };
    expect(changed.type).toBe('conversations_changed');
    expect(updated.pendingHandoffMode).toBe('fresh');
    expect(cleared.pendingHandoffMode).toBeNull();
  });
});
