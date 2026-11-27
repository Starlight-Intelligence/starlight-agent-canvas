import { describe, expect, it } from 'vitest';
import { applyOps } from '@starlight-agent-canvas/world';
import type { WorldGraph } from '@starlight-agent-canvas/world';
import { generateWorld } from '../generate-world';
import { LocalWorldSource } from '../local-source';

const graphOf = (n: number) => generateWorld({ nodes: n }) as unknown as WorldGraph;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A fake server holding the authoritative graph; each POST/GET answer is released by the test. */
function fakeServer(initial: WorldGraph) {
  let graph = initial;
  const posts: { ops: unknown[]; release: (accept: boolean) => void }[] = [];
  const gets: { release: (snapshot?: WorldGraph) => void }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const { ops } = JSON.parse(String(init.body));
      const gate = deferred<boolean>();
      posts.push({ ops, release: gate.resolve });
      if (!(await gate.promise)) return new Response(JSON.stringify({ ok: false, error: { code: 'STALE_VERSION', message: 'stale' } }), { status: 409 });
      const r = applyOps(graph, ops, { actor: { harness: 'human', at: new Date().toISOString() } });
      if (!r.ok) return new Response(JSON.stringify({ ok: false, error: r.error }), { status: 409 });
      graph = r.graph;
      const ids = new Set(r.changed.nodes);
      return new Response(JSON.stringify({ ok: true, version: graph.world.version, changed: r.changed, proposals: r.proposals, world: graph.world, nodes: graph.nodes.filter((n) => ids.has(n.id)), edges: [] }));
    }
    const snapshotAtRequest = graph;
    const gate = deferred<WorldGraph | undefined>();
    gets.push({ release: gate.resolve });
    return new Response(JSON.stringify((await gate.promise) ?? snapshotAtRequest));
  }) as unknown as typeof fetch;
  return { fetchImpl, posts, gets, current: () => graph };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LocalWorldSource reconciles by version', () => {
  it('a rejected batch reloading an older snapshot does not drop a later in-flight save that succeeds', async () => {
    const server = fakeServer(graphOf(30));
    const source = new LocalWorldSource(server.current(), { persistUrl: '/ops', reloadUrl: '/world', fetchImpl: server.fetchImpl });
    const a = source.applyOps([{ op: 'updateNode', id: 'n_gen_1', baseVersion: 1, patch: { title: 'Rejected A' } }]);
    const b = source.applyOps([{ op: 'updateNode', id: 'n_gen_2', baseVersion: 1, patch: { title: 'Saved B' } }]);
    await tick();
    server.posts[0].release(false);
    await tick();
    // A's reload is answered with the snapshot from before B reached the server.
    server.gets[0].release();
    expect((await a).ok).toBe(false);
    // While B is still in flight it stays visible.
    expect((await source.getNode('n_gen_2'))?.title).toBe('Saved B');
    server.posts[1].release(true);
    expect((await b).ok).toBe(true);
    expect((await source.getNode('n_gen_2'))?.title).toBe('Saved B');
    expect((await source.getNode('n_gen_1'))?.title).not.toBe('Rejected A');
    expect(source.snapshot().world.version).toBe(server.current().world.version);
  });

  it('never installs a reload snapshot older than a save the server already confirmed', async () => {
    const start = graphOf(30);
    const server = fakeServer(start);
    const source = new LocalWorldSource(start, { persistUrl: '/ops', reloadUrl: '/world', fetchImpl: server.fetchImpl });
    const a = source.applyOps([{ op: 'updateNode', id: 'n_gen_1', baseVersion: 1, patch: { title: 'Rejected A' } }]);
    const b = source.applyOps([{ op: 'updateNode', id: 'n_gen_2', baseVersion: 1, patch: { title: 'Saved B' } }]);
    await tick();
    server.posts[0].release(false);
    await tick();
    server.posts[1].release(true);
    expect((await b).ok).toBe(true);
    // The reload for A finally answers with a stale snapshot from before B.
    server.gets[0].release(start);
    expect((await a).ok).toBe(false);
    expect((await source.getNode('n_gen_2'))?.title).toBe('Saved B');
    expect(source.snapshot().world.version).toBeGreaterThanOrEqual(server.current().world.version);
  });

  it('adopts the server versions of a confirmed batch', async () => {
    const start = graphOf(30);
    // The server is ahead: another tab already made 5 changes.
    let ahead = start;
    for (let i = 0; i < 5; i++) {
      const r = applyOps(ahead, [{ op: 'updateNode', id: 'n_gen_10', baseVersion: ahead.nodes.find((n) => n.id === 'n_gen_10')!.version, patch: { summary: `tab ${i}` } }], { actor: { harness: 'human', at: new Date().toISOString() } });
      if (r.ok) ahead = r.graph;
    }
    const server = fakeServer(ahead);
    const source = new LocalWorldSource(start, { persistUrl: '/ops', reloadUrl: '/world', fetchImpl: server.fetchImpl });
    const save = source.applyOps([{ op: 'updateNode', id: 'n_gen_3', baseVersion: 1, patch: { title: 'Mine' } }]);
    await tick();
    server.posts[0].release(true);
    expect((await save).ok).toBe(true);
    const serverNode = server.current().nodes.find((n) => n.id === 'n_gen_3')!;
    // The optimistic local version differs from the server's.
    expect(ahead.world.version).toBeGreaterThan(start.world.version);
    expect(serverNode.version).not.toBe(start.world.version + 1);
    expect((await source.getNode('n_gen_3'))?.version).toBe(serverNode.version);
    // So the next edit's baseVersion matches the server.
    const next = source.applyOps([{ op: 'updateNode', id: 'n_gen_3', baseVersion: serverNode.version, patch: { title: 'Again' } }]);
    await tick();
    server.posts[1].release(true);
    expect((await next).ok).toBe(true);
  });

  it('keeps canon proposals made through the source', async () => {
    const source = new LocalWorldSource(graphOf(20));
    const out = await source.applyOps([{ op: 'proposeCanon', target: { type: 'node', id: 'n_gen_1' }, baseVersion: 1, note: 'why' }]);
    expect(out.ok).toBe(true);
    expect(source.proposals().map((p) => p.id)).toEqual(['n_gen_1']);
  });
});
