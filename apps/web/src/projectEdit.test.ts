import { describe, it, expect } from 'vitest';
import { buildProjectEditPatch, splitProjectEdit, moveErrorMessage } from './projectEdit.js';

const current = { name: 'Demo', rootPath: '/home/user/Projects/Demo' };

describe('buildProjectEditPatch', () => {
  it('returns a null patch when nothing changed after trim', () => {
    expect(buildProjectEditPatch(current, {
      name: '  Demo  ',
      rootPath: ' /home/user/Projects/Demo ',
    })).toEqual({ ok: true, patch: null });
  });

  it('includes only the fields that changed', () => {
    expect(buildProjectEditPatch(current, {
      name: 'Tierwyn',
      rootPath: current.rootPath,
    })).toEqual({ ok: true, patch: { name: 'Tierwyn' } });

    expect(buildProjectEditPatch(current, {
      name: current.name,
      rootPath: '/home/user/Projects/Tierwyn',
    })).toEqual({ ok: true, patch: { rootPath: '/home/user/Projects/Tierwyn' } });

    expect(buildProjectEditPatch(current, {
      name: current.name,
      rootPath: current.rootPath,
      trustRepoConfig: true,
    })).toEqual({ ok: true, patch: { trustRepoConfig: true } });
  });

  it('includes name and rootPath together', () => {
    expect(buildProjectEditPatch(current, {
      name: 'Tierwyn',
      rootPath: '/home/user/Projects/Tierwyn',
    })).toEqual({
      ok: true,
      patch: { name: 'Tierwyn', rootPath: '/home/user/Projects/Tierwyn' },
    });
  });

  it('rejects an empty name', () => {
    expect(buildProjectEditPatch(current, { name: '   ', rootPath: current.rootPath }))
      .toEqual({ ok: false, error: 'name required' });
  });

  it('rejects a name longer than 200 characters', () => {
    expect(buildProjectEditPatch(current, { name: 'x'.repeat(201), rootPath: current.rootPath }))
      .toEqual({ ok: false, error: 'name too long (max 200)' });
  });

  it('rejects a missing or relative rootPath', () => {
    expect(buildProjectEditPatch(current, { name: 'Tierwyn', rootPath: '   ' }))
      .toEqual({ ok: false, error: 'rootPath required' });
    expect(buildProjectEditPatch(current, { name: 'Tierwyn', rootPath: 'relative/path' }))
      .toEqual({ ok: false, error: 'rootPath must be an absolute path (leading /)' });
  });

  it('includes sandbox on when current inherits', () => {
    expect(buildProjectEditPatch(
      { ...current, sandbox: undefined },
      { name: current.name, rootPath: current.rootPath, sandbox: 'on' },
    )).toEqual({ ok: true, patch: { sandbox: 'on' } });
  });

  it('sends sandbox null to clear a project override', () => {
    expect(buildProjectEditPatch(
      { ...current, sandbox: 'on' },
      { name: current.name, rootPath: current.rootPath, sandbox: null },
    )).toEqual({ ok: true, patch: { sandbox: null } });
  });

  it('returns null patch when sandbox is unchanged', () => {
    expect(buildProjectEditPatch(
      { ...current, sandbox: 'off' },
      { name: current.name, rootPath: current.rootPath, sandbox: 'off' },
    )).toEqual({ ok: true, patch: null });
  });

  it('includes sandboxPaths when the list changes', () => {
    expect(buildProjectEditPatch(
      { ...current, sandboxPaths: undefined },
      { name: current.name, rootPath: current.rootPath, sandboxPaths: [{ path: '/srv/models', mode: 'ro' }] },
    )).toEqual({ ok: true, patch: { sandboxPaths: [{ path: '/srv/models', mode: 'ro' }] } });
  });

  it('sends sandboxPaths null to clear project paths', () => {
    expect(buildProjectEditPatch(
      { ...current, sandboxPaths: [{ path: '/srv/models', mode: 'ro' }] },
      { name: current.name, rootPath: current.rootPath, sandboxPaths: [] },
    )).toEqual({ ok: true, patch: { sandboxPaths: null } });
  });

  it('returns null patch when sandboxPaths are unchanged', () => {
    const paths = [{ path: '/srv/models', mode: 'ro' as const }];
    expect(buildProjectEditPatch(
      { ...current, sandboxPaths: paths },
      { name: current.name, rootPath: current.rootPath, sandboxPaths: [{ path: '/srv/models', mode: 'ro' }] },
    )).toEqual({ ok: true, patch: null });
  });

  it('includes agentSearchScope when it changes', () => {
    expect(buildProjectEditPatch(
      { ...current, agentSearchScope: undefined },
      { name: current.name, rootPath: current.rootPath, agentSearchScope: 'all' },
    )).toEqual({ ok: true, patch: { agentSearchScope: 'all' } });
  });

  it('sends agentSearchScope null to clear a project override', () => {
    expect(buildProjectEditPatch(
      { ...current, agentSearchScope: 'all' },
      { name: current.name, rootPath: current.rootPath, agentSearchScope: null },
    )).toEqual({ ok: true, patch: { agentSearchScope: null } });
  });

  it('returns null patch when agentSearchScope is unchanged', () => {
    expect(buildProjectEditPatch(
      { ...current, agentSearchScope: 'project' },
      { name: current.name, rootPath: current.rootPath, agentSearchScope: 'project' },
    )).toEqual({ ok: true, patch: null });
  });
});

describe('splitProjectEdit', () => {
  it('returns newRootPath: null on name-only change', () => {
    expect(splitProjectEdit(current, {
      name: 'New Name',
      rootPath: current.rootPath,
    })).toEqual({
      ok: true,
      patch: { name: 'New Name' },
      newRootPath: null,
    });
  });

  it('returns patch: null and newRootPath set on path-only change', () => {
    expect(splitProjectEdit(current, {
      name: current.name,
      rootPath: '/home/user/Projects/NewDir',
    })).toEqual({
      ok: true,
      patch: null,
      newRootPath: '/home/user/Projects/NewDir',
    });
  });

  it('returns patch {name} and newRootPath on both changed', () => {
    expect(splitProjectEdit(current, {
      name: 'New Name',
      rootPath: '/home/user/Projects/NewDir',
    })).toEqual({
      ok: true,
      patch: { name: 'New Name' },
      newRootPath: '/home/user/Projects/NewDir',
    });
  });

  it('returns patch: null and newRootPath: null when nothing changed', () => {
    expect(splitProjectEdit(current, {
      name: current.name,
      rootPath: current.rootPath,
    })).toEqual({
      ok: true,
      patch: null,
      newRootPath: null,
    });
  });

  it('forwards validation error with ok: false', () => {
    expect(splitProjectEdit(current, {
      name: '',
      rootPath: current.rootPath,
    })).toEqual({
      ok: false,
      error: 'name required',
    });
  });

  it('keeps sandbox in patch when rootPath also changes', () => {
    expect(splitProjectEdit(
      { ...current, sandbox: undefined },
      { name: current.name, rootPath: '/home/user/Projects/NewDir', sandbox: 'on' },
    )).toEqual({
      ok: true,
      patch: { sandbox: 'on' },
      newRootPath: '/home/user/Projects/NewDir',
    });
  });
});

describe('moveErrorMessage', () => {
  it('maps each known code to exact copy', () => {
    expect(moveErrorMessage('agents_active', 'x'))
      .toBe('Agents are working in this project. Stop them, then try again.');
    expect(moveErrorMessage('move_in_progress', 'x'))
      .toBe("This project's folder is already being moved.");
    expect(moveErrorMessage('exists', 'x'))
      .toBe('Something already exists at the new path.');
    expect(moveErrorMessage('parent_missing', 'x'))
      .toBe('The parent folder could not be created. Check permissions, or create it first (folder browser → New folder).');
    expect(moveErrorMessage('cross_device', 'x'))
      .toBe('The new path is on a different disk. Move the folder by hand, then set the path to point at it.');
    expect(moveErrorMessage('path_outside_roots', 'x'))
      .toBe('Both paths must be inside the allowed project roots.');
    expect(moveErrorMessage('into_self', 'x'))
      .toBe('A folder cannot be moved inside itself.');
    expect(moveErrorMessage('contains_other_project', 'x'))
      .toBe('Another project lives inside this folder. Move that project first.');
    expect(moveErrorMessage('node_update_required', 'x'))
      .toBe('Update tierwyn node on the host to move folders (tierwyn node update).');
    expect(moveErrorMessage('host_disconnected', 'x'))
      .toBe('The remote host is not connected.');
  });

  it('returns fallback verbatim for rollback_failed, move_state_unknown, and unknown codes', () => {
    expect(moveErrorMessage('rollback_failed', 'server details')).toBe('server details');
    expect(moveErrorMessage('move_state_unknown', 'server details')).toBe('server details');
    expect(moveErrorMessage(undefined, 'server details')).toBe('server details');
    expect(moveErrorMessage('bad_path', 'server details')).toBe('server details');
  });
});
