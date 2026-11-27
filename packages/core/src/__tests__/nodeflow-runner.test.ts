import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileCanvasStore,
  createCanvasRecord,
  executeNodeflowSubgraph,
  listTemplates,
  topologicalSortSubgraph,
} from '../index.js';

describe('nodeflow runner and multimodal templates', () => {
  it('registers the three multimodal nodeflow templates and executes all of them in dry_run mode', async () => {
    const templates = listTemplates().map((t) => t.id);
    expect(templates).toContain('brand_campaign_pipeline');
    expect(templates).toContain('multi_llm_architecture_review');
    expect(templates).toContain('knowledge_distillation_studio');

    for (const template of ['brand_campaign_pipeline', 'multi_llm_architecture_review', 'knowledge_distillation_studio'] as const) {
      const canvas = createCanvasRecord({ title: `Test ${template}`, template });
      const { canvas: next, result } = await executeNodeflowSubgraph(canvas, { mode: 'dry_run' });
      expect(result.status).toBe('completed');
      expect(result.steps.length).toBeGreaterThanOrEqual(2);
      expect(result.totalEstimatedCostUsd).toBe(0);
      expect(result.r2Manifest.schemaVersion).toBe('starlight.r2Bundle.v1');
      expect(result.r2Manifest.graphSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(next.artifacts.length).toBe(result.steps.length);
    }
  });

  it('rejects cyclic graphs cleanly', () => {
    const canvas = createCanvasRecord({ title: 'Cyclic test', template: 'blank' });
    const now = new Date().toISOString();
    canvas.nodes = [
      { id: 'n1', kind: 'llm_council', title: 'A', body: 'a', position: { x: 0, y: 0 }, metadata: {}, createdAt: now, updatedAt: now },
      { id: 'n2', kind: 'image_gen', title: 'B', body: 'b', position: { x: 100, y: 0 }, metadata: {}, createdAt: now, updatedAt: now },
    ];
    canvas.edges = [
      { id: 'e1', source: 'n1', target: 'n2', kind: 'runs', createdAt: now },
      { id: 'e2', source: 'n2', target: 'n1', kind: 'derives_from', createdAt: now },
    ];
    expect(() => topologicalSortSubgraph(canvas)).toThrow(/cycle/i);
  });

  it('fails closed on Higgsfield without approved /hf-plan and on ElevenLabs live without consent', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'nodeflow-gates-'));
    const store = new FileCanvasStore(home);
    const created = await store.createCanvas({ title: 'Gate test', template: 'blank' });

    await store.upsertMediaNode(created.id, {
      kind: 'image_gen',
      title: 'Gated Higgsfield image',
      body: 'Hero render',
      provider: 'higgsfield',
    });
    await store.upsertMediaNode(created.id, {
      kind: 'audio_voice',
      title: 'ElevenLabs live voice',
      body: 'Narration text',
      provider: 'elevenlabs',
    });

    const denied = await store.runNodeflow(created.id, { mode: 'live', consentVerified: false });
    expect(denied.result.status).toBe('failed');
    expect(denied.result.steps[0].error).toMatch(/\/hf-plan/i);
    expect(denied.result.steps[1].error).toMatch(/consentVerified/i);

    // Metadata flag alone must NOT bypass server-side consent gate
    const spoofed = await store.upsertMediaNode(created.id, {
      nodeId: denied.canvas.nodes[1].id,
      kind: 'audio_voice',
      title: 'ElevenLabs live voice',
      body: 'Narration text',
      provider: 'elevenlabs',
      metadata: { consentVerified: true },
    });
    const stillDenied = await store.runNodeflow(created.id, {
      nodeIds: [spoofed.node.id],
      mode: 'live',
      consentVerified: false,
    });
    expect(stillDenied.result.status).toBe('failed');
    expect(stillDenied.result.steps[0].error).toMatch(/consentVerified/i);

    const allowedVoiceOnly = await store.runNodeflow(created.id, {
      nodeIds: [spoofed.node.id],
      mode: 'live',
      consentVerified: true,
    });
    expect(allowedVoiceOnly.result.status).toBe('completed');
    expect(allowedVoiceOnly.result.steps[0].r2Key).toContain('media/audio');
  });
});
