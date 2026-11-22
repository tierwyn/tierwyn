import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { getProject } from '../repositories/projects.js';
import {
  createRulePreset,
  deleteRulePreset,
  getRulePreset,
  listRulePresets,
  nameConflict,
  normalisePresetDescription,
  normalisePresetName,
  updateRulePreset,
} from '../repositories/rulePresets.js';
import { normaliseRules } from '../spawn/rules.js';

export function registerRulePresetRoutes(app: Express, getDb: () => Database): void {
  app.get('/rule-presets', (req, res) => {
    const db = getDb();
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    if (projectId && !getProject(db, projectId)) {
      res.status(404).json({ error: 'no such project' });
      return;
    }
    res.json({ presets: listRulePresets(db, projectId) });
  });

  app.post('/rule-presets', (req, res) => {
    const db = getDb();
    const body = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      content?: unknown;
      projectId?: unknown;
    };
    const name = normalisePresetName(body.name);
    if (!name.ok) { res.status(400).json({ error: name.error }); return; }
    const description = normalisePresetDescription(body.description);
    if (!description.ok) { res.status(400).json({ error: description.error }); return; }
    if (typeof body.content !== 'string' || !body.content.trim()) {
      res.status(400).json({ error: 'content required' });
      return;
    }
    const content = normaliseRules(body.content);
    if (!content.ok) { res.status(400).json({ error: content.error }); return; }
    if (!content.value) { res.status(400).json({ error: 'content required' }); return; }

    let projectId: string | null = null;
    if (body.projectId !== undefined && body.projectId !== null) {
      if (typeof body.projectId !== 'string' || !body.projectId) {
        res.status(400).json({ error: 'projectId must be a string' });
        return;
      }
      const project = getProject(db, body.projectId);
      if (!project) { res.status(404).json({ error: 'no such project' }); return; }
      if (project.system) { res.status(409).json({ error: 'system project cannot have rule presets' }); return; }
      projectId = project.id;
    }

    if (nameConflict(db, name.value, projectId)) {
      res.status(409).json({ error: 'a preset with that name already exists in this scope' });
      return;
    }
    const preset = createRulePreset(db, {
      name: name.value,
      description: description.value,
      content: content.value,
      projectId,
    });
    res.status(201).json({ preset });
  });

  app.patch('/rule-presets/:id', (req, res) => {
    const db = getDb();
    const existing = getRulePreset(db, req.params.id);
    if (!existing) { res.status(404).json({ error: 'no such preset' }); return; }
    const body = (req.body ?? {}) as { name?: unknown; description?: unknown; content?: unknown; projectId?: unknown };
    if (Object.prototype.hasOwnProperty.call(body, 'projectId')) {
      res.status(400).json({ error: 'projectId cannot be changed; delete and recreate' });
      return;
    }
    const patch: { name?: string; description?: string | null; content?: string } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      const name = normalisePresetName(body.name);
      if (!name.ok) { res.status(400).json({ error: name.error }); return; }
      if (nameConflict(db, name.value, existing.projectId, existing.id)) {
        res.status(409).json({ error: 'a preset with that name already exists in this scope' });
        return;
      }
      patch.name = name.value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      const description = normalisePresetDescription(body.description);
      if (!description.ok) { res.status(400).json({ error: description.error }); return; }
      patch.description = description.value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'content')) {
      if (typeof body.content !== 'string' || !body.content.trim()) {
        res.status(400).json({ error: 'content required' });
        return;
      }
      const content = normaliseRules(body.content);
      if (!content.ok) { res.status(400).json({ error: content.error }); return; }
      if (!content.value) { res.status(400).json({ error: 'content required' }); return; }
      patch.content = content.value;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'name, description, or content required' });
      return;
    }
    const preset = updateRulePreset(db, existing.id, patch);
    res.json({ preset });
  });

  app.delete('/rule-presets/:id', (req, res) => {
    const result = deleteRulePreset(getDb(), req.params.id);
    if (!result.ok) { res.status(404).json({ error: 'no such preset' }); return; }
    res.json({ scrubbed: result.scrubbed });
  });
}
