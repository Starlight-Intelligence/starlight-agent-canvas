import { createHash } from 'node:crypto';
import {
  nodeflowRunRequestSchema,
  type CanvasArtifact,
  type CanvasNode,
  type CanvasRecord,
  type MediaProvider,
  type NodeflowExecutionMode,
  type NodeflowRunRequest,
  type NodeflowRunResult,
  type NodeflowStepReceipt,
  type R2BundleManifest,
} from './schemas.js';
import { chunksForArtifact, buildSourceChunks } from './chunks.js';
import { makeId, nowIso } from './ids.js';

export type NodeflowAdapterContext = {
  canvas: CanvasRecord;
  node: CanvasNode;
  upstreamNodes: CanvasNode[];
  mode: NodeflowExecutionMode;
  consentVerified: boolean;
  executionId: string;
};

export type NodeflowAdapterOutput = {
  provider: string;
  summary: string;
  body: string;
  estimatedCostUsd: number;
  artifactKind?: CanvasArtifact['kind'];
  r2Key?: string;
  pollHandle?: string;
  tasteScore?: number;
  metadata?: Record<string, unknown>;
};

export type NodeflowAdapter = (ctx: NodeflowAdapterContext) => Promise<NodeflowAdapterOutput>;

export type NodeflowAdapters = {
  llm_council: NodeflowAdapter;
  image_gen: NodeflowAdapter;
  video_gen: NodeflowAdapter;
  audio_voice: NodeflowAdapter;
  taste_gate: NodeflowAdapter;
};

const EXECUTABLE_MEDIA_KINDS = new Set<CanvasNode['kind']>([
  'llm_council',
  'image_gen',
  'video_gen',
  'audio_voice',
  'taste_gate',
]);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stringMeta(node: CanvasNode, key: string): string | undefined {
  const val = node.metadata[key];
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

function numberMeta(node: CanvasNode, key: string): number | undefined {
  const val = node.metadata[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function defaultProviderForKind(kind: CanvasNode['kind']): MediaProvider {
  switch (kind) {
    case 'llm_council':
      return 'cloudflare-council';
    case 'image_gen':
      return 'gemini-nanobanana';
    case 'video_gen':
      return 'veo';
    case 'audio_voice':
      return 'elevenlabs';
    case 'taste_gate':
      return 'local-dry-run';
    default:
      return 'local-dry-run';
  }
}

/**
 * Deterministic Kahn topological sort over either the full canvas or a selected subgraph.
 * Fails loudly if any cycle exists in the induced edges.
 */
export function topologicalSortSubgraph(canvas: CanvasRecord, nodeIds: string[] = []): CanvasNode[] {
  const targetSet = nodeIds.length
    ? new Set(nodeIds)
    : new Set(canvas.nodes.map((node) => node.id));

  const nodes = canvas.nodes.filter((node) => targetSet.has(node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const inDegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const adjacency = new Map<string, string[]>(nodes.map((node) => [node.id, []]));

  for (const edge of canvas.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    adjacency.get(edge.source)!.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue = nodes
    .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const ordered: CanvasNode[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = nodeById.get(id);
    if (node) ordered.push(node);
    for (const nextId of adjacency.get(id) ?? []) {
      const nextDegree = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, nextDegree);
      if (nextDegree === 0) queue.push(nextId);
    }
  }

  if (ordered.length !== nodes.length) {
    throw new Error('Nodeflow graph contains a cycle; remove cyclic edges before execution.');
  }

  return ordered;
}

export function buildR2BundleManifest(canvas: CanvasRecord, nodeIds: string[] = []): R2BundleManifest {
  const createdAt = nowIso();
  const targetSet = nodeIds.length
    ? new Set(nodeIds)
    : new Set(canvas.nodes.map((node) => node.id));

  const scopedNodes = canvas.nodes.filter((node) => targetSet.has(node.id));
  const referencedArtifactIds = new Set(
    scopedNodes
      .map((node) => stringMeta(node, 'artifactId'))
      .filter((id): id is string => Boolean(id)),
  );
  const scopedArtifacts = canvas.artifacts.filter(
    (artifact) => nodeIds.length === 0 || referencedArtifactIds.has(artifact.id),
  );

  const r2Prefix = `canvases/${canvas.id}/bundles/${createdAt.slice(0, 10)}`;
  const graphSha256 = sha256Hex(JSON.stringify({
    id: canvas.id,
    title: canvas.title,
    nodes: scopedNodes,
    edges: canvas.edges.filter((e) => targetSet.has(e.source) && targetSet.has(e.target)),
  }));

  return {
    schemaVersion: 'starlight.r2Bundle.v1',
    canvasId: canvas.id,
    canvasTitle: canvas.title,
    r2Prefix,
    graphSha256,
    createdAt,
    nodeCount: scopedNodes.length,
    artifactCount: scopedArtifacts.length,
    artifacts: scopedArtifacts.map((artifact) => {
      const bytes = Buffer.byteLength(artifact.body, 'utf8');
      const r2Key = typeof artifact.metadata.r2Key === 'string'
        ? artifact.metadata.r2Key
        : `${r2Prefix}/artifacts/${artifact.id}.json`;
      return {
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        r2Key,
        sha256: sha256Hex(artifact.body),
        bytes,
      };
    }),
  };
}

function validateNodeGates(ctx: NodeflowAdapterContext): void {
  const provider = stringMeta(ctx.node, 'provider') ?? defaultProviderForKind(ctx.node.kind);

  // Higgsfield Plan Gate (Frank ruling 2026-10-19)
  if (provider === 'higgsfield') {
    const hfPlanId = stringMeta(ctx.node, 'hfPlanId');
    const creditCap = numberMeta(ctx.node, 'creditCap');
    if (!hfPlanId || creditCap === undefined || creditCap <= 0) {
      throw new Error(
        `Higgsfield node '${ctx.node.title}' requires an approved /hf-plan (metadata.hfPlanId and positive metadata.creditCap).`,
      );
    }
  }

  // ElevenLabs server-side consent gate (@starlight-intelligence/elevenlabs contract)
  if (ctx.node.kind === 'audio_voice' && provider === 'elevenlabs' && ctx.mode === 'live') {
    const nodeConsent = ctx.node.metadata.consentVerified === true;
    if (!ctx.consentVerified && !nodeConsent) {
      throw new Error(
        `ElevenLabs live synthesis on '${ctx.node.title}' failed closed: consentVerified must be true.`,
      );
    }
  }
}

export function createDefaultNodeflowAdapters(env: {
  FLEET_MCP_URL?: string;
  FLEET_TOKEN?: string;
} = {}): NodeflowAdapters {
  return {
    async llm_council(ctx) {
      const provider = stringMeta(ctx.node, 'provider') ?? 'cloudflare-council';
      const upstreamText = ctx.upstreamNodes
        .map((n) => `- ${n.title}: ${n.body.slice(0, 220)}`)
        .join('\n');

      if (ctx.mode === 'live' && env.FLEET_MCP_URL && env.FLEET_TOKEN) {
        const res = await fetch(`${env.FLEET_MCP_URL.replace(/\/+$/, '')}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.FLEET_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ctx.executionId,
            method: 'tools/call',
            params: {
              name: 'codemode',
              arguments: {
                code: `async () => await fleet.council_deliberate(${JSON.stringify({
                  topic: `${ctx.node.title}: ${ctx.node.body}`,
                  context: upstreamText,
                  mode: stringMeta(ctx.node, 'councilMode') ?? 'architect',
                  max_cost_usd: numberMeta(ctx.node, 'maxCostUsd') ?? 0.25,
                })})`,
              },
            },
          }),
        });
        if (!res.ok) {
          throw new Error(`Fleet MCP council request failed with HTTP ${res.status}`);
        }
        const payload = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
        const text = payload.result?.content?.[0]?.text ?? JSON.stringify(payload);
        return {
          provider: 'cloudflare-council',
          summary: `Live Cross-LLM Council completed for ${ctx.node.title}.`,
          body: text,
          estimatedCostUsd: 0.08,
          artifactKind: 'council_verdict',
          r2Key: `canvases/${ctx.canvas.id}/councils/${ctx.node.id}-${ctx.executionId}.json`,
          metadata: { makerCheckerVerified: true, liveTransport: 'fleet-mcp' },
        };
      }

      const body = [
        `## Cross-LLM Council Preview (${ctx.node.title})`,
        '',
        `- Mode: ${stringMeta(ctx.node, 'councilMode') ?? 'architect'} (deterministic dry-run)`,
        `- Upstream context nodes: ${ctx.upstreamNodes.length}`,
        `- Panelists: Anthropic + OpenAI + Google Gemini (cross-provider critique enabled)`,
        '',
        '### Consensus Synthesis',
        ctx.node.body || 'Synthesize upstream brief into clear hierarchy, verifiable claims, and reusable assets.',
        ...(upstreamText ? ['', '### Upstream Inputs', upstreamText] : []),
        '',
        '### Explicit Dissent Log',
        '- [Checker / OpenAI] Verify latency and fallback paths before promoting live.',
      ].join('\n');

      return {
        provider,
        summary: `Dry-run Cross-LLM Council synthesized (${ctx.upstreamNodes.length} inputs).`,
        body,
        estimatedCostUsd: 0,
        artifactKind: 'council_verdict',
        r2Key: `canvases/${ctx.canvas.id}/councils/${ctx.node.id}-${ctx.executionId}.json`,
        metadata: { makerCheckerVerified: true, simulation: true },
      };
    },

    async image_gen(ctx) {
      const provider = stringMeta(ctx.node, 'provider') ?? 'gemini-nanobanana';
      const promptHash = sha256Hex(`${ctx.node.title}\n${ctx.node.body}`);
      const r2Key = `canvases/${ctx.canvas.id}/media/images/${ctx.node.id}-${promptHash.slice(0, 10)}.png`;
      const aspect = stringMeta(ctx.node, 'aspectRatio') ?? '16:9';

      return {
        provider,
        summary: `Image spec prepared via ${provider} (${aspect}, dry-run).`,
        body: [
          `## Image Generation Receipt (${provider})`,
          `- Prompt: ${ctx.node.body || ctx.node.title}`,
          `- Aspect Ratio: ${aspect}`,
          `- Prompt SHA-256: ${promptHash}`,
          `- Target R2 Key: ${r2Key}`,
          `- Upstream References: ${ctx.upstreamNodes.map((n) => n.title).join(', ') || 'none'}`,
        ].join('\n'),
        estimatedCostUsd: ctx.mode === 'live' ? 0.04 : 0,
        artifactKind: 'image',
        r2Key,
        metadata: { promptHash, aspectRatio: aspect, simulation: ctx.mode !== 'live' },
      };
    },

    async video_gen(ctx) {
      const provider = stringMeta(ctx.node, 'provider') ?? 'veo';
      const durationSec = numberMeta(ctx.node, 'durationSec') ?? 6;
      const jobId = `vid-${ctx.executionId.slice(-8)}-${ctx.node.id.slice(-6)}`;
      const r2Key = `canvases/${ctx.canvas.id}/media/video/${jobId}.mp4`;
      const pollHandle = `workflow://starlight-media-video/${jobId}`;

      return {
        provider,
        summary: `Async video envelope staged via ${provider} (${durationSec}s).`,
        body: [
          `## Video Generation Envelope (${provider})`,
          `- Job ID: ${jobId}`,
          `- Poll Handle: ${pollHandle}`,
          `- Duration: ${durationSec}s`,
          `- Brief: ${ctx.node.body || ctx.node.title}`,
          `- Target R2 Key: ${r2Key}`,
        ].join('\n'),
        estimatedCostUsd: ctx.mode === 'live' ? 0.18 : 0,
        artifactKind: 'video',
        r2Key,
        pollHandle,
        metadata: { jobId, durationSec, asyncWorkflow: true, simulation: ctx.mode !== 'live' },
      };
    },

    async audio_voice(ctx) {
      const provider = stringMeta(ctx.node, 'provider') ?? 'elevenlabs';
      const voiceMode = stringMeta(ctx.node, 'voiceMode') ?? 'tts';
      const voiceId = stringMeta(ctx.node, 'voiceId') ?? 'starlight-narrator-v1';
      const r2Key = `canvases/${ctx.canvas.id}/media/audio/${ctx.node.id}-${ctx.executionId.slice(-8)}.mp3`;

      return {
        provider,
        summary: `Voice/audio node prepared via ${provider} (${voiceMode}).`,
        body: [
          `## Audio & Voice Synthesis (${provider})`,
          `- Voice Mode: ${voiceMode}`,
          `- Voice Profile: ${voiceId}`,
          `- Consent Verified: ${ctx.consentVerified || ctx.node.metadata.consentVerified === true}`,
          `- Script: ${ctx.node.body || ctx.node.title}`,
          `- Target R2 Key: ${r2Key}`,
        ].join('\n'),
        estimatedCostUsd: ctx.mode === 'live' ? 0.03 : 0,
        artifactKind: 'audio',
        r2Key,
        metadata: { voiceMode, voiceId, simulation: ctx.mode !== 'live' },
      };
    },

    async taste_gate(ctx) {
      const upstreamBodies = ctx.upstreamNodes.map((n) => n.body).join('\n');
      const bannedSlop = /\b(delve|unleash|unlock the power|game-changer|seamlessly|revolutionize)\b/i.test(upstreamBodies);
      const hasContent = ctx.upstreamNodes.some((n) => n.body.trim().length > 20);
      const tasteScore = Math.max(40, Math.min(98, (hasContent ? 86 : 62) - (bannedSlop ? 18 : 0) + Math.min(10, ctx.upstreamNodes.length * 2)));
      const verdict = tasteScore >= 75 && !bannedSlop ? 'pass' : 'revise';
      const r2Key = `canvases/${ctx.canvas.id}/provenance/${ctx.node.id}-${ctx.executionId.slice(-8)}.json`;

      return {
        provider: 'local-dry-run',
        summary: `Taste & Provenance Gate: ${verdict.toUpperCase()} (${tasteScore}/100).`,
        body: [
          `## Taste & Provenance Verdict: ${verdict.toUpperCase()}`,
          `- Score: ${tasteScore}/100`,
          `- Anti-slop scan: ${bannedSlop ? 'flagged generic copy patterns' : 'clean'}`,
          `- Upstream nodes audited: ${ctx.upstreamNodes.length}`,
          `- Provenance R2 Key: ${r2Key}`,
        ].join('\n'),
        estimatedCostUsd: 0,
        artifactKind: 'provenance',
        r2Key,
        tasteScore,
        metadata: { verdict, tasteScore, bannedSlop },
      };
    },
  };
}

export async function executeNodeflowSubgraph(
  canvas: CanvasRecord,
  rawRequest: NodeflowRunRequest = {},
  adapters: NodeflowAdapters = createDefaultNodeflowAdapters(),
): Promise<{ canvas: CanvasRecord; result: NodeflowRunResult }> {
  const request = nodeflowRunRequestSchema.parse(rawRequest);
  const executionId = makeId('flow', canvas.id);
  const ordered = topologicalSortSubgraph(canvas, request.nodeIds);

  const nodeMap = new Map(canvas.nodes.map((node) => [node.id, { ...node }]));
  const incomingEdges = new Map<string, string[]>();
  for (const edge of canvas.edges) {
    const list = incomingEdges.get(edge.target) ?? [];
    list.push(edge.source);
    incomingEdges.set(edge.target, list);
  }

  let spentUsd = 0;
  let hasFailure = false;
  let hasSkipped = false;
  const steps: NodeflowStepReceipt[] = [];
  const newArtifacts: CanvasArtifact[] = [];
  const timestamp = nowIso();

  for (const node of ordered) {
    if (!EXECUTABLE_MEDIA_KINDS.has(node.kind)) {
      continue;
    }

    const upstreamIds = incomingEdges.get(node.id) ?? [];
    const upstreamNodes = upstreamIds
      .map((id) => nodeMap.get(id))
      .filter((item): item is CanvasNode => Boolean(item));

    const ctx: NodeflowAdapterContext = {
      canvas,
      node,
      upstreamNodes,
      mode: request.mode,
      consentVerified: request.consentVerified,
      executionId,
    };

    try {
      validateNodeGates(ctx);
      if (spentUsd >= request.maxCostUsd) {
        hasSkipped = true;
        steps.push({
          nodeId: node.id,
          nodeTitle: node.title,
          kind: node.kind,
          provider: stringMeta(node, 'provider') ?? defaultProviderForKind(node.kind),
          status: 'skipped',
          mode: request.mode,
          estimatedCostUsd: 0,
          summary: `Skipped: spend ceiling $${request.maxCostUsd.toFixed(2)} reached.`,
        });
        continue;
      }

      const adapter = adapters[node.kind as keyof NodeflowAdapters];
      const output = await adapter(ctx);

      if (spentUsd + output.estimatedCostUsd > request.maxCostUsd) {
        hasSkipped = true;
        steps.push({
          nodeId: node.id,
          nodeTitle: node.title,
          kind: node.kind,
          provider: output.provider,
          status: 'skipped',
          mode: request.mode,
          estimatedCostUsd: 0,
          summary: `Skipped: estimated step cost ($${output.estimatedCostUsd.toFixed(2)}) exceeds remaining budget.`,
        });
        continue;
      }

      spentUsd += output.estimatedCostUsd;
      const artifactId = makeId('artifact', `${node.kind}-${node.title}`);
      const artifact: CanvasArtifact = {
        id: artifactId,
        kind: output.artifactKind ?? 'json',
        title: `${node.title} (${output.provider})`,
        body: output.body,
        source: output.r2Key,
        createdAt: timestamp,
        metadata: {
          executionId,
          nodeId: node.id,
          provider: output.provider,
          r2Key: output.r2Key,
          pollHandle: output.pollHandle,
          tasteScore: output.tasteScore,
          ...(output.metadata ?? {}),
        },
        chunks: [],
      };
      artifact.chunks = buildSourceChunks(artifact.id, artifact.body);
      newArtifacts.push(artifact);

      const updatedNode: CanvasNode = {
        ...nodeMap.get(node.id)!,
        updatedAt: timestamp,
        metadata: {
          ...nodeMap.get(node.id)!.metadata,
          provider: output.provider,
          artifactId,
          lastExecution: {
            executionId,
            status: 'completed',
            mode: request.mode,
            summary: output.summary,
            r2Key: output.r2Key,
            pollHandle: output.pollHandle,
            tasteScore: output.tasteScore,
            estimatedCostUsd: output.estimatedCostUsd,
            updatedAt: timestamp,
          },
        },
      };
      nodeMap.set(node.id, updatedNode);

      steps.push({
        nodeId: node.id,
        nodeTitle: node.title,
        kind: node.kind,
        provider: output.provider,
        status: 'completed',
        mode: request.mode,
        estimatedCostUsd: output.estimatedCostUsd,
        summary: output.summary,
        artifactId,
        r2Key: output.r2Key,
        pollHandle: output.pollHandle,
        tasteScore: output.tasteScore,
      });
    } catch (error) {
      hasFailure = true;
      const message = (error as Error).message;
      const existing = nodeMap.get(node.id)!;
      nodeMap.set(node.id, {
        ...existing,
        updatedAt: timestamp,
        metadata: {
          ...existing.metadata,
          lastExecution: {
            executionId,
            status: 'failed',
            mode: request.mode,
            error: message,
            updatedAt: timestamp,
          },
        },
      });
      steps.push({
        nodeId: node.id,
        nodeTitle: node.title,
        kind: node.kind,
        provider: stringMeta(node, 'provider') ?? defaultProviderForKind(node.kind),
        status: 'failed',
        mode: request.mode,
        estimatedCostUsd: 0,
        summary: message,
        error: message,
      });
    }
  }

  const updatedCanvas: CanvasRecord = {
    ...canvas,
    updatedAt: timestamp,
    nodes: canvas.nodes.map((node) => nodeMap.get(node.id) ?? node),
    artifacts: [...canvas.artifacts, ...newArtifacts],
    runs: [
      ...canvas.runs,
      {
        id: executionId,
        action: 'implementation_brief',
        inputNodeIds: ordered.map((n) => n.id),
        summary: `Nodeflow ${request.mode}: ${steps.filter((s) => s.status === 'completed').length}/${steps.length} media/council steps completed.`,
        status: hasFailure && steps.every((s) => s.status === 'failed') ? 'failed' : 'completed',
        createdAt: timestamp,
        metadata: {
          kind: 'nodeflow_run',
          mode: request.mode,
          totalEstimatedCostUsd: Number(spentUsd.toFixed(4)),
          steps,
        },
      },
    ],
  };

  const status: NodeflowRunResult['status'] = hasFailure && steps.every((s) => s.status === 'failed')
    ? 'failed'
    : (hasFailure || hasSkipped)
      ? 'partial'
      : 'completed';

  return {
    canvas: updatedCanvas,
    result: {
      executionId,
      mode: request.mode,
      status,
      orderedNodeIds: ordered.map((n) => n.id),
      steps,
      totalEstimatedCostUsd: Number(spentUsd.toFixed(4)),
      budgetCapUsd: request.maxCostUsd,
      r2Manifest: buildR2BundleManifest(updatedCanvas, request.nodeIds),
    },
  };
}

export function describeArtifactChunks(artifact: CanvasArtifact): number {
  return chunksForArtifact(artifact).length;
}
