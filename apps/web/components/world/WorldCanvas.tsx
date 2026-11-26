'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  TILE_SIZE,
  boundsIntersect,
  newId,
  regionAt,
  tileKey,
  tileKeysForBounds,
} from '@starlight-agent-canvas/world';
import type { Bounds, Relation, WorldEdge, WorldNode } from '@starlight-agent-canvas/world';
import { createStressSource, createWorldSource } from '@/lib/world/create-source';
import { TIMELINE_LANE_HEIGHT, TIMELINE_LANE_TITLES, TIMELINE_STEP, nearestInDirection, timelineLayout } from '@/lib/world/layouts';
import type { ActivityEntry, RegionCluster, SearchHit, TileBatch, WorldSource, WorldSummary } from '@/lib/world/source';
import { ActivityRail, Toolbar, TopBar, type Tool, type WorldView } from './Chrome';
import { Inspector, type PendingLink } from './Inspector';
import { countLine } from './kinds';
import { flowTypeForKind, useSemanticLevel, worldNodeTypes, type RegionNodeData, type WorldNodeData } from './nodes';

const RELATION_TEXT: Record<Relation, string> = {
  'appears-in': 'appears in',
  'located-at': 'located at',
  precedes: 'precedes',
  follows: 'follows',
  'member-of': 'member of',
  'bonded-to': 'bonded to',
  rules: 'rules',
  'part-of': 'part of',
  references: 'references',
  'canon-of': 'canon of',
  contradicts: 'contradicts',
};

const MAX_TILES = 64;
/** Flow id suffix for the cluster of nodes outside every region. */
const UNPLACED = '__unplaced';
const STRUCTURAL: ReadonlySet<Relation> = new Set<Relation>(['rules', 'bonded-to', 'part-of', 'member-of', 'precedes', 'follows', 'appears-in', 'located-at', 'canon-of', 'contradicts']);
const DEFAULT_W = 240;
const DEFAULT_H = 120;

function pad(b: Bounds, by: number): Bounds {
  return { x: b.x - by, y: b.y - by, w: b.w + by * 2, h: b.h + by * 2 };
}

/** World bounds use w/h; xyflow rects use width/height. */
function rect(b: Bounds) {
  return { x: b.x, y: b.y, width: b.w, height: b.h };
}

function boxOf(n: WorldNode): Bounds {
  return { x: n.position.x, y: n.position.y, w: n.size?.w ?? DEFAULT_W, h: n.size?.h ?? DEFAULT_H };
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduce(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduce;
}

/** True on the narrow layout, where the inspector is a sheet over the canvas (world.css, 860px). */
function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)');
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

export default function WorldCanvas(props: { worldId: string; stressNodes?: number }) {
  return (
    <ReactFlowProvider>
      <WorldCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function WorldCanvasInner({ worldId, stressNodes }: { worldId: string; stressNodes?: number }) {
  const rf = useReactFlow();
  const level = useSemanticLevel();
  const reduceMotion = usePrefersReducedMotion();
  const narrow = useNarrowLayout();
  const duration = reduceMotion ? 0 : 360;

  const [source, setSource] = useState<WorldSource | null>(null);
  const [summary, setSummary] = useState<WorldSummary | null>(null);
  const [clusters, setClusters] = useState<RegionCluster[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [tiles, setTiles] = useState<Map<string, TileBatch>>(() => new Map());
  const [vp, setVp] = useState<Bounds | null>(null);
  const [view, setView] = useState<WorldView>('graph');
  const [timeline, setTimeline] = useState<TileBatch | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<WorldNode | null>(null);
  const [selectedEdges, setSelectedEdges] = useState<WorldEdge[]>([]);
  const [depth, setDepth] = useState(0);
  const [focusSet, setFocusSet] = useState<Set<string> | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const [canvasFocus, setCanvasFocus] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const inspectorTitleRef = useRef<HTMLInputElement>(null);
  const titles = useRef(new Map<string, string>());
  const raf = useRef<number | null>(null);
  const initialised = useRef(false);

  const announce = useCallback((text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage((m) => (m === text ? '' : m)), 5000);
  }, []);

  // Load the world record and region clusters. Nodes load per tile, below.
  useEffect(() => {
    let live = true;
    setActivityOpen(window.innerWidth >= 1100);
    (async () => {
      try {
        const s = stressNodes ? createStressSource(stressNodes) : await createWorldSource(worldId);
        const [sum, cl] = await Promise.all([s.loadWorld(), s.getClusters()]);
        if (!live) return;
        setSource(s);
        setSummary(sum);
        setClusters(cl);
        setActivity(s.activity());
      } catch (err) {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [worldId, stressNodes]);

  useEffect(() => {
    if (!source) return;
    return source.subscribe((event) => {
      if (event.type === 'changed') {
        setRevision((r) => r + 1);
        void source.loadWorld().then(setSummary);
        void source.getClusters().then(setClusters);
      } else if (event.type === 'activity') {
        setActivity(source.activity());
      } else if (event.type === 'rollback') {
        announce(`Change rolled back: ${event.error.message}`);
      }
    });
  }, [source, announce]);

  // After an accepted batch, drop cached tiles so they reload with new versions.
  useEffect(() => {
    if (revision > 0) setTiles(new Map());
  }, [revision]);

  const updateVp = useCallback((v: Viewport) => {
    const el = stageRef.current;
    if (!el || v.zoom <= 0) return;
    // Card text counter-scales with zoom through CSS, without re-rendering nodes.
    el.style.setProperty('--z', String(v.zoom));
    setVp({ x: -v.x / v.zoom, y: -v.y / v.zoom, w: el.clientWidth / v.zoom, h: el.clientHeight / v.zoom });
  }, []);

  /** Center a world point in the visible part of the stage (above the mobile inspector sheet). */
  const centerOn = useCallback(async (box: Bounds, zoom: number, ms: number, withInspector: boolean) => {
    const el = stageRef.current;
    const h = el?.clientHeight ?? 0;
    const sheet = withInspector && el && window.innerWidth <= 860 ? h * 0.58 : 0;
    const visible = h - sheet;
    const x = box.x + box.w / 2;
    // Tall nodes align their top edge; others center in the visible area.
    const y = box.h * zoom > visible - 32 ? box.y + (h / 2 - 16) / zoom : box.y + box.h / 2 + sheet / 2 / zoom;
    await rf.setCenter(x, y, { zoom, duration: ms });
  }, [rf]);

  const onMove = useCallback((_: unknown, v: Viewport) => {
    stageRef.current?.style.setProperty('--z', String(v.zoom));
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      updateVp(v);
    });
  }, [updateVp]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => updateVp(rf.getViewport()));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rf, updateVp]);

  // Initial camera, with optional ?node=, ?at=x,y, ?region=, ?zoom= and ?view= for deep links.
  useEffect(() => {
    if (!summary || initialised.current) return;
    initialised.current = true;
    const params = new URLSearchParams(window.location.search);
    const v = params.get('view');
    if (v === 'timeline' || v === 'map' || v === 'graph') setView(v);
    const zoomParam = Number(params.get('zoom'));
    const regionId = params.get('region');
    const nodeId = params.get('node');
    requestAnimationFrame(async () => {
      if (nodeId && source) {
        const node = await source.getNode(nodeId);
        if (node) {
          const b = boxOf(node);
          setSelectedId(node.id);
          // Wait for the inspector to open so the stage has its final size.
          await new Promise((r) => setTimeout(r, 120));
          await centerOn(b, zoomParam > 0 ? zoomParam : 1.4, 0, true);
          updateVp(rf.getViewport());
          return;
        }
      }
      const at = params.get('at')?.split(',').map(Number);
      if (at && at.length === 2 && at.every(Number.isFinite)) {
        await rf.setCenter(at[0], at[1], { zoom: zoomParam > 0 ? zoomParam : 1, duration: 0 });
        updateVp(rf.getViewport());
        return;
      }
      const region = regionId ? summary.world.regions.find((r) => r.id === regionId || r.title.toLowerCase() === regionId.toLowerCase()) : null;
      await rf.fitBounds(rect(region ? region.bounds : summary.bounds), { padding: 0.06, duration: 0 });
      if (zoomParam > 0) {
        const cur = rf.getViewport();
        const el = stageRef.current;
        if (el) {
          const cx = (-cur.x + el.clientWidth / 2) / cur.zoom;
          const cy = (-cur.y + el.clientHeight / 2) / cur.zoom;
          await rf.setCenter(cx, cy, { zoom: zoomParam, duration: 0 });
        }
      }
      updateVp(rf.getViewport());
    });
  }, [summary, source, rf, updateVp, centerOn]);

  // Viewport-driven tile loading (spec section 6).
  useEffect(() => {
    if (!source || !vp || view !== 'graph' || level === 'cluster') return;
    const keys = tileKeysForBounds(pad(vp, TILE_SIZE / 2));
    const missing = keys.filter((k) => !tiles.has(k));
    if (!missing.length) return;
    let live = true;
    void source.getTiles(missing).then((batch) => {
      if (!live) return;
      setTiles((prev) => {
        const next = new Map(prev);
        const fresh = new Map<string, TileBatch>(missing.map((k) => [k, { tileKeys: [k], nodes: [], edges: [] }]));
        const nodeTile = new Map<string, string>();
        for (const n of batch.nodes) {
          const k = tileKey(n.position);
          nodeTile.set(n.id, k);
          fresh.get(k)?.nodes.push(n);
          titles.current.set(n.id, n.title);
        }
        for (const e of batch.edges) {
          const a = nodeTile.get(e.from);
          const b = nodeTile.get(e.to);
          if (a) fresh.get(a)?.edges.push(e);
          if (b && b !== a) fresh.get(b)?.edges.push(e);
        }
        for (const [k, t] of fresh) next.set(k, t);
        // LRU by insertion order: drop the oldest tiles that are not in view.
        if (next.size > MAX_TILES) {
          const keep = new Set(keys);
          for (const k of next.keys()) {
            if (next.size <= MAX_TILES) break;
            if (!keep.has(k)) next.delete(k);
          }
        }
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [source, vp, view, level, tiles]);

  // Timeline data.
  useEffect(() => {
    if (!source || view !== 'timeline') return;
    let live = true;
    void source.getTimeline().then((batch) => {
      if (!live) return;
      for (const n of batch.nodes) titles.current.set(n.id, n.title);
      setTimeline(batch);
      requestAnimationFrame(() => void rf.fitView({ padding: 0.12, duration: 0 }));
    });
    return () => {
      live = false;
    };
  }, [source, view, revision, rf]);

  // Selected node and its relations.
  useEffect(() => {
    if (!source || !selectedId) {
      setSelectedNode(null);
      setSelectedEdges([]);
      return;
    }
    let live = true;
    void Promise.all([source.getNode(selectedId), source.getNeighborhood(selectedId, 1)]).then(([node, hood]) => {
      if (!live) return;
      for (const n of hood.nodes) titles.current.set(n.id, n.title);
      setSelectedNode(node);
      setSelectedEdges(hood.edges.filter((e) => e.from === selectedId || e.to === selectedId));
    });
    return () => {
      live = false;
    };
  }, [source, selectedId, revision]);

  // Neighborhood focus.
  useEffect(() => {
    if (!source || !selectedId || depth === 0 || view !== 'graph') {
      setFocusSet(null);
      return;
    }
    let live = true;
    void source.getNeighborhood(selectedId, depth).then((hood) => {
      if (!live) return;
      setFocusSet(new Set(hood.nodes.map((n) => n.id)));
      if (hood.nodes.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const n of hood.nodes) {
          const b = boxOf(n);
          x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
        }
        void rf.fitBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, { padding: 0.15, duration });
      }
    });
    return () => {
      live = false;
    };
  }, [source, selectedId, depth, view, revision, rf, duration]);

  useEffect(() => {
    if (view === 'map' && summary) requestAnimationFrame(() => void rf.fitBounds(rect(summary.bounds), { padding: 0.06, duration: 0 }));
  }, [view, summary, rf]);

  // On the narrow layout the inspector is a sheet over the canvas. While it is
  // open and focus is outside the canvas (in the sheet or the top bar), canvas
  // nodes leave the tab order so Tab cannot reach nodes hidden behind the sheet.
  // Taps on the visible part of the canvas still work (unlike inert).
  const sheetOpen = narrow && Boolean(selectedNode || pendingLink?.to);
  const canvasTabbable = !sheetOpen || canvasFocus;
  useEffect(() => {
    const sync = () => setCanvasFocus(Boolean((document.activeElement as HTMLElement | null)?.closest?.('.wc-stage')));
    document.addEventListener('focusin', sync);
    return () => document.removeEventListener('focusin', sync);
  }, []);

  const tintByRegion = useMemo(() => new Map(clusters.map((c) => [c.regionId, c.color])), [clusters]);

  // World nodes to render: graph view uses tiles in the padded viewport only.
  const visibleWorldNodes = useMemo<WorldNode[]>(() => {
    if (view === 'timeline') return timeline?.nodes ?? [];
    if (view !== 'graph' || level === 'cluster' || !vp) return [];
    const area = pad(vp, Math.max(vp.w, vp.h) * 0.25);
    const out: WorldNode[] = [];
    const seen = new Set<string>();
    for (const k of tileKeysForBounds(area)) {
      for (const n of tiles.get(k)?.nodes ?? []) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        if (boundsIntersect(boxOf(n), area)) out.push(n);
      }
    }
    return out;
  }, [view, level, vp, tiles, timeline]);

  const timelinePositions = useMemo(() => {
    if (view !== 'timeline' || !timeline) return null;
    return new Map(timelineLayout(timeline.nodes, timeline.edges).map((p) => [p.id, p]));
  }, [view, timeline]);

  const regionFlowNodes = useMemo<Node<RegionNodeData>[]>(() => {
    if (view === 'timeline') {
      if (!timeline || !timelinePositions) return [];
      const lanes = new Set([...timelinePositions.values()].map((p) => Math.round(p.y / TIMELINE_LANE_HEIGHT)));
      const width = Math.max(1, timeline.nodes.length) * TIMELINE_STEP + 320;
      return [...lanes].sort().map((lane) => ({
        id: `lane:${lane}`,
        type: 'region',
        position: { x: -160, y: lane * TIMELINE_LANE_HEIGHT - 48 },
        width,
        height: TIMELINE_LANE_HEIGHT - 16,
        style: { width, height: TIMELINE_LANE_HEIGHT - 16 },
        data: { title: TIMELINE_LANE_TITLES[lane] ?? 'Other', tint: '#8b8b95', total: [...timelinePositions.values()].filter((p) => Math.round(p.y / TIMELINE_LANE_HEIGHT) === lane).length, counts: '', mode: 'lane' as const },
        selectable: false,
        draggable: false,
        focusable: false,
        zIndex: -1,
      }));
    }
    return clusters
      .map((c) => ({
        id: `region:${c.regionId ?? UNPLACED}`,
        type: 'region',
        position: { x: c.bounds.x, y: c.bounds.y },
        width: c.bounds.w,
        height: c.bounds.h,
        style: { width: c.bounds.w, height: c.bounds.h },
        data: { title: c.title, tint: c.color, total: c.total, counts: countLine(c.byKind, 3), mode: view === 'map' ? ('map' as const) : ('graph' as const) },
        selectable: false,
        draggable: false,
        focusable: canvasTabbable && (view === 'map' || level === 'cluster'),
        zIndex: -1,
        ariaLabel: `Region ${c.title}`,
      }));
  }, [clusters, view, level, timeline, timelinePositions, canvasTabbable]);

  const derivedNodes = useMemo<Node[]>(() => {
    const out: Node[] = [...regionFlowNodes];
    for (const n of visibleWorldNodes) {
      const pos = timelinePositions?.get(n.id);
      const data: WorldNodeData = {
        node: n,
        tint: tintByRegion.get(n.regionId) ?? '#8b8b95',
        dim: Boolean(focusSet && !focusSet.has(n.id)),
        linkSource: pendingLink?.from === n.id,
      };
      out.push({
        id: n.id,
        type: flowTypeForKind(n.kind),
        position: pos ? { x: pos.x, y: pos.y } : n.position,
        data,
        selected: n.id === selectedId,
        draggable: view === 'graph' && tool === 'select',
        zIndex: n.layer,
      });
    }
    return out;
  }, [regionFlowNodes, visibleWorldNodes, timelinePositions, tintByRegion, focusSet, pendingLink, selectedId, view, tool]);

  // Merge derived nodes into flow state, reusing objects whose content is unchanged
  // so memoized node components skip rendering and measurements are kept.
  useEffect(() => {
    setRfNodes((prev) => {
      const before = new Map(prev.map((n) => [n.id, n]));
      return derivedNodes.map((n) => {
        const old = before.get(n.id);
        if (!old) return n;
        const a = old.data as Partial<WorldNodeData>;
        const b = n.data as Partial<WorldNodeData>;
        const same =
          old.type === n.type &&
          old.selected === n.selected &&
          old.draggable === n.draggable &&
          old.position.x === n.position.x &&
          old.position.y === n.position.y &&
          (old.type === 'region' ? old.data === n.data || JSON.stringify(old.data) === JSON.stringify(n.data) : a.node === b.node && a.dim === b.dim && a.tint === b.tint && a.linkSource === b.linkSource);
        return same ? old : { ...n, measured: old.measured };
      });
    });
  }, [derivedNodes]);

  const renderedIds = useMemo(() => new Set(visibleWorldNodes.map((n) => n.id)), [visibleWorldNodes]);

  const rfEdges = useMemo<Edge[]>(() => {
    const pool: WorldEdge[] = [];
    if (view === 'timeline') pool.push(...(timeline?.edges ?? []));
    else if (view === 'graph' && level !== 'cluster') for (const t of tiles.values()) pool.push(...t.edges);
    const seen = new Set<string>();
    const out: Edge[] = [];
    const positions = new Map(visibleWorldNodes.map((n) => [n.id, n.position]));
    for (const e of pool) {
      if (seen.has(e.id) || !renderedIds.has(e.from) || !renderedIds.has(e.to)) continue;
      seen.add(e.id);
      const hot = selectedId !== null && (e.from === selectedId || e.to === selectedId);
      // Card level keeps structure readable: long or cross-reference links show only when they touch the selection.
      if (view === 'graph' && level === 'card' && !hot) {
        if (!STRUCTURAL.has(e.relation)) continue;
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (a && b && Math.hypot(a.x - b.x, a.y - b.y) > 1600) continue;
      }
      const dim = focusSet ? !(focusSet.has(e.from) && focusSet.has(e.to)) : false;
      out.push({
        id: e.id,
        source: e.from,
        target: e.to,
        className: `we${hot ? ' is-hot' : ''}${dim ? ' is-dim' : ''}`,
        label: level === 'full' || hot ? (e.label ?? RELATION_TEXT[e.relation]) : undefined,
        focusable: false,
        selectable: false,
        zIndex: hot ? 5 : 0,
      });
    }
    return out;
  }, [view, timeline, tiles, level, renderedIds, selectedId, focusSet, visibleWorldNodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Selection and removal are driven by this component, not by xyflow.
    const allowed = changes.filter((c) => c.type !== 'select' && c.type !== 'remove');
    if (allowed.length) setRfNodes((nds) => applyNodeChanges(allowed, nds));
  }, []);

  const runOps = useCallback(async (ops: unknown[]) => {
    if (!source) return null;
    const outcome = await source.applyOps(ops);
    if (!outcome.ok) {
      const e = outcome.error;
      announce(
        e.code === 'STALE_VERSION' ? 'This node changed elsewhere. The latest version is loaded and your draft is kept; save again to apply it.'
        : e.code === 'DUPLICATE_ID' ? 'That relation already exists.'
        : e.code === 'CANON_LOCKED' ? 'Canon is locked. Propose a change through git instead.'
        : e.message,
      );
      setRevision((r) => r + 1);
    }
    return outcome;
  }, [source, announce]);

  const onNodeDragStop = useCallback(async (_: unknown, _node: Node, dragged: Node[]) => {
    if (!source || view !== 'graph') return;
    const moves = [];
    for (const d of dragged) {
      const wn = (d.data as Partial<WorldNodeData>).node;
      if (!wn || (wn.position.x === Math.round(d.position.x) && wn.position.y === Math.round(d.position.y))) continue;
      const position = { x: Math.round(d.position.x), y: Math.round(d.position.y) };
      const region = summary ? regionAt(summary.world.regions, position) : null;
      moves.push({ id: wn.id, baseVersion: wn.version, position, regionId: region?.id ?? null });
    }
    if (moves.length) await runOps([{ op: 'moveNodes', moves }]);
  }, [source, view, summary, runOps]);

  const jumpTo = useCallback(async (id: string, opts: { zoom?: number } = {}) => {
    if (!source) return;
    const node = await source.getNode(id);
    if (!node) return;
    if (view !== 'graph') setView('graph');
    setSelectedId(node.id);
    const b = boxOf(node);
    const zoom = opts.zoom ?? Math.max(rf.getZoom(), 1.3);
    await centerOn(b, zoom, duration, true);
  }, [source, view, rf, duration, centerOn]);

  const onPick = useCallback((hit: SearchHit) => void jumpTo(hit.id), [jumpTo]);

  const enterRegion = useCallback((regionId: string) => {
    const c = clusters.find((x) => (x.regionId ?? UNPLACED) === regionId);
    if (!c) return;
    setView('graph');
    requestAnimationFrame(() => void rf.fitBounds(rect(c.bounds), { padding: 0.05, duration }));
  }, [clusters, rf, duration]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.type === 'region') {
      if (node.id.startsWith('region:') && (view === 'map' || level === 'cluster')) enterRegion(node.id.slice('region:'.length));
      return;
    }
    if (tool === 'link') {
      if (!pendingLink || pendingLink.to) {
        setPendingLink({ from: node.id });
        setSelectedId(node.id);
        announce('Link from this node. Now pick the target node.');
      } else if (pendingLink.from !== node.id) {
        setPendingLink({ from: pendingLink.from, to: node.id });
      }
      return;
    }
    setSelectedId(node.id);
  }, [tool, pendingLink, view, level, enterRegion, announce]);

  const onConnect = useCallback((c: Connection) => {
    if (c.source && c.target && c.source !== c.target) {
      setPendingLink({ from: c.source, to: c.target });
      setSelectedId(c.source);
    }
  }, []);

  const addNode = useCallback(async () => {
    // Timeline and Map positions are generated, not authored; adding there would
    // place the node at an unrelated graph position. Same rule as the toolbar.
    if (!source || !vp || !summary || view !== 'graph') return;
    const position = { x: Math.round(vp.x + vp.w / 2 - DEFAULT_W / 2), y: Math.round(vp.y + vp.h / 2 - DEFAULT_H / 2) };
    const id = newId('n', 'untitled');
    const region = regionAt(summary.world.regions, position);
    const outcome = await runOps([{ op: 'addNode', node: { id, kind: 'note', title: 'Untitled note', position, regionId: region?.id ?? null } }]);
    if (outcome?.ok) {
      setSelectedId(id);
      if (rf.getZoom() < 0.4) await rf.setCenter(position.x + DEFAULT_W / 2, position.y + DEFAULT_H / 2, { zoom: 0.8, duration });
      requestAnimationFrame(() => inspectorTitleRef.current?.select());
    }
  }, [source, vp, summary, runOps, rf, duration, view]);

  const onSave = useCallback(async (node: WorldNode, patch: Record<string, unknown>) => {
    const out = await runOps([{ op: 'updateNode', id: node.id, baseVersion: node.version, patch }]);
    if (out?.ok) announce('Saved.');
    return Boolean(out?.ok);
  }, [runOps, announce]);

  const onProposeCanon = useCallback(async (node: WorldNode, note: string) => {
    const out = await runOps([{ op: 'proposeCanon', target: { type: 'node', id: node.id }, baseVersion: node.version, ...(note ? { note } : {}) }]);
    if (out?.ok) announce('Proposed for canon. Canon itself changes only through a reviewed git PR.');
    return Boolean(out?.ok);
  }, [runOps, announce]);

  const onLink = useCallback(async (from: string, to: string, relation: Relation, label?: string) => {
    const out = await runOps([{ op: 'addEdge', edge: { from, to, relation, ...(label ? { label } : {}) } }]);
    if (out?.ok) {
      announce('Relation added.');
      setPendingLink(null);
      setTool('select');
    }
    return Boolean(out?.ok);
  }, [runOps, announce]);

  const titleOf = useCallback((id: string) => titles.current.get(id) ?? id, []);

  const fit = useCallback(() => {
    if (view === 'graph' && summary) void rf.fitBounds(rect(summary.bounds), { padding: 0.06, duration });
    else void rf.fitView({ padding: 0.1, duration });
  }, [view, summary, rf, duration]);

  /**
   * Focus a node's DOM element, waiting for it to mount while the camera pans
   * and its tiles load. Falls back to the stage so focus is never lost to <body>.
   */
  const focusFlowNode = useCallback((id: string, attempts = 120) => {
    // Arrow navigation is a deliberate move into the canvas: make nodes tabbable again.
    setCanvasFocus(true);
    const el = stageRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"][tabindex]`);
    // A node that just mounted stays visibility:hidden until xyflow measures it,
    // and focus() on it silently does nothing, so check that focus landed.
    el?.focus({ preventScroll: true });
    if (el && document.activeElement === el) return;
    if (attempts > 0) requestAnimationFrame(() => focusFlowNode(id, attempts - 1));
    else stageRef.current?.focus({ preventScroll: true });
  }, []);

  /** Node getting focus back after the inspector closed; focusing it must not reopen the inspector. */
  const returningFocus = useRef<string | null>(null);

  /** Close the inspector and return focus to the node it was showing. */
  const closeInspector = useCallback(() => {
    const returnTo = pendingLink?.from ?? selectedId;
    returningFocus.current = returnTo;
    // If the node never mounts (focus falls back to the stage), forget it.
    window.setTimeout(() => {
      if (returningFocus.current === returnTo) returningFocus.current = null;
    }, 2500);
    setSelectedId(null);
    setPendingLink(null);
    if (pendingLink) setTool('select');
    if (returnTo) requestAnimationFrame(() => focusFlowNode(returnTo));
    else requestAnimationFrame(() => stageRef.current?.focus({ preventScroll: true }));
  }, [pendingLink, selectedId, focusFlowNode]);

  /**
   * Arrow navigation past the rendered area: look for the nearest node in that
   * direction in the source (widening the search), then pan to it and focus it.
   */
  const navigateBeyond = useCallback(async (from: { x: number; y: number }, dir: 'left' | 'right' | 'up' | 'down') => {
    if (!source || !vp) return;
    const base = Math.max(vp.w, vp.h, TILE_SIZE / 2);
    for (const span of [base * 2, base * 6, base * 24]) {
      const bounds: Bounds =
        dir === 'right' ? { x: from.x, y: from.y - span, w: span, h: span * 2 }
        : dir === 'left' ? { x: from.x - span, y: from.y - span, w: span, h: span * 2 }
        : dir === 'down' ? { x: from.x - span, y: from.y, w: span * 2, h: span }
        : { x: from.x - span, y: from.y - span, w: span * 2, h: span };
      const batch = await source.getRegion({ bounds });
      const centers = batch.nodes.map((n) => {
        const b = boxOf(n);
        return { id: n.id, x: b.x + b.w / 2, y: b.y + b.h / 2, node: n };
      });
      const nextId = nearestInDirection(from, centers, dir);
      if (!nextId) continue;
      const next = centers.find((c) => c.id === nextId)!;
      titles.current.set(next.id, next.node.title);
      setSelectedId(next.id);
      await centerOn(boxOf(next.node), rf.getZoom(), duration, true);
      updateVp(rf.getViewport());
      requestAnimationFrame(() => focusFlowNode(next.id));
      return;
    }
    announce(`No more nodes ${dir === 'left' || dir === 'right' ? `to the ${dir}` : dir === 'up' ? 'above' : 'below'}.`);
  }, [source, vp, centerOn, rf, duration, updateVp, focusFlowNode, announce]);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    const target = (e.target instanceof HTMLElement ? e.target : document.body) as HTMLElement;
    // Keys count when focus is in the canvas page or nowhere in particular.
    if (target !== document.body && !target.closest('.wc')) return;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    if (key === '/') {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (target.closest('.wc-inspector, .wc-activity, .wc-topbar')) return;
    if (key === 'Escape') {
      if (pendingLink) setPendingLink(null);
      else if (selectedId) setSelectedId(null);
      setTool('select');
      return;
    }
    if (key === '+' || key === '=') return void rf.zoomIn({ duration });
    if (key === '-' || key === '_') return void rf.zoomOut({ duration });
    if (key === '0') return fit();
    if (key === 'v') return setTool('select');
    if (key === 'h') return setTool('pan');
    if (key === 'l') return setTool('link');
    if (key === 'n') return void addNode();
    if (key === 'Enter') {
      const focused = target.closest<HTMLElement>('.react-flow__node');
      const id = focused?.dataset.id ?? selectedId;
      if (id?.startsWith('region:')) return enterRegion(id.slice('region:'.length));
      if (id && id !== selectedId) setSelectedId(id);
      if (id) requestAnimationFrame(() => inspectorTitleRef.current?.focus());
      return;
    }
    const dir = key === 'ArrowLeft' ? 'left' : key === 'ArrowRight' ? 'right' : key === 'ArrowUp' ? 'up' : key === 'ArrowDown' ? 'down' : null;
    if (!dir) return;
    e.preventDefault();
    // Regions are the targets in Map and at cluster zoom in Graph. Timeline always
    // moves between its nodes (its lane bands use lane: ids and are not targets).
    const regionTargets = view === 'map' || (view === 'graph' && level === 'cluster');
    const candidates = rfNodes
      .filter((n) => (regionTargets ? n.id.startsWith('region:') : !n.id.startsWith('region:') && !n.id.startsWith('lane:')))
      .map((n) => ({ id: n.id, x: n.position.x + (n.measured?.width ?? n.width ?? 0) / 2, y: n.position.y + (n.measured?.height ?? n.height ?? 0) / 2 }));
    const focusedId = target.closest<HTMLElement>('.react-flow__node')?.dataset.id;
    const current = candidates.find((c) => c.id === (focusedId ?? selectedId));
    const from = current ?? (vp ? { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 } : { x: 0, y: 0 });
    const nextId = current ? nearestInDirection(from, candidates, dir) : candidates.sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0]?.id;
    if (!nextId) {
      // Graph view renders only the padded viewport; the next node may be further out.
      if (view === 'graph' && !regionTargets) void navigateBeyond(from, dir);
      return;
    }
    if (!nextId.startsWith('region:')) setSelectedId(nextId);
    const c = candidates.find((x) => x.id === nextId)!;
    if (vp && !boundsIntersect({ x: c.x - 1, y: c.y - 1, w: 2, h: 2 }, pad(vp, -Math.min(vp.w, vp.h) * 0.15))) {
      void rf.setCenter(c.x, c.y, { zoom: rf.getZoom(), duration });
    }
    requestAnimationFrame(() => focusFlowNode(nextId));
  }, [pendingLink, selectedId, rf, duration, fit, addNode, enterRegion, rfNodes, level, view, vp, focusFlowNode, navigateBeyond]);

  // Window-level so shortcuts work when focus sits on <body> (after a pane click, or on load).
  const keyHandler = useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const onStageFocus = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.react-flow__node');
    const id = el?.dataset.id;
    if (id && id === returningFocus.current) {
      returningFocus.current = null;
      return;
    }
    if (id && !id.startsWith('region:') && !id.startsWith('lane:') && id !== selectedId && tool !== 'link') setSelectedId(id);
  }, [selectedId, tool]);

  if (loadError) {
    return (
      <main className="wc wc-empty">
        <h1>World not available</h1>
        <p className="wc-muted">{loadError}</p>
      </main>
    );
  }

  const canEdit = Boolean(source);
  const showInspector = Boolean(selectedNode || pendingLink?.to);

  return (
    <main
      className={`wc ${showInspector ? 'has-inspector' : ''} ${activityOpen ? 'has-activity' : ''} wc-tool-${tool}`}
      onFocus={onStageFocus}
      data-level={level}
      data-view={view}
      data-rendered-nodes={visibleWorldNodes.length}
      data-total-nodes={summary?.counts.nodes ?? 0}
    >
      <TopBar
        ref={searchRef}
        title={summary?.world.title ?? 'Loading world'}
        version={summary?.world.version ?? 0}
        nodeCount={summary?.counts.nodes ?? 0}
        sourceKind={source?.kind ?? 'local'}
        view={view}
        onView={setView}
        depth={depth}
        onDepth={setDepth}
        canFocus={Boolean(selectedId)}
        source={source}
        onPick={onPick}
        activityOpen={activityOpen}
        onToggleActivity={() => setActivityOpen((o) => !o)}
      />
      <div className="wc-body">
        {activityOpen ? <ActivityRail entries={activity} onClose={() => setActivityOpen(false)} onJump={(id) => void jumpTo(id)} /> : null}
        <div className="wc-stage" ref={stageRef} tabIndex={-1} aria-label={`${summary?.world.title ?? 'World'} canvas. Arrow keys move between nodes, Enter edits, slash searches.`}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={worldNodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={onNodeClick}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onPaneClick={() => {
              if (tool !== 'link') setSelectedId(null);
            }}
            onMove={onMove}
            onMoveEnd={(_, v) => updateVp(v)}
            onlyRenderVisibleElements
            minZoom={0.02}
            maxZoom={3}
            nodesConnectable={tool === 'link'}
            nodesFocusable={canvasTabbable}
            nodesDraggable={view === 'graph' && tool === 'select'}
            elementsSelectable={tool !== 'pan'}
            panOnDrag
            selectionOnDrag={false}
            deleteKeyCode={null}
            disableKeyboardA11y
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
            defaultEdgeOptions={{ type: 'default' }}
          >
            <Background id="wc-dots" variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgba(255,255,255,0.09)" bgColor="#09090b" />
            <MiniMap
              className="wc-minimap"
              pannable
              zoomable
              ariaLabel="Minimap"
              nodeStrokeWidth={0}
              nodeBorderRadius={6}
              maskColor="rgba(9, 9, 11, 0.72)"
              bgColor="#121216"
              nodeColor={(n) => (n.type === 'region' ? `${(n.data as RegionNodeData).tint}55` : n.selected ? '#e7b844' : 'rgba(237,237,240,0.45)')}
            />
          </ReactFlow>

          <Toolbar
            tool={tool}
            onTool={(t) => {
              setTool(t);
              if (t !== 'link') setPendingLink(null);
            }}
            onAdd={() => void addNode()}
            onZoomIn={() => void rf.zoomIn({ duration })}
            onZoomOut={() => void rf.zoomOut({ duration })}
            onFit={fit}
            canEdit={canEdit && view === 'graph'}
          />

          {stressNodes ? (
            <p className="wc-perf" aria-live="off">
              Rendering {visibleWorldNodes.length.toLocaleString('en-US')} of {(summary?.counts.nodes ?? 0).toLocaleString('en-US')} nodes
            </p>
          ) : null}

          {!summary ? <p className="wc-loading">Loading world</p> : null}
          <div className={`wc-toast ${message ? 'is-on' : ''}`} role="status" aria-live="polite">{message}</div>
        </div>
        {source && showInspector ? (
          <Inspector
            ref={inspectorTitleRef}
            node={selectedNode}
            edges={selectedEdges}
            titleOf={titleOf}
            source={source}
            pendingLink={pendingLink}
            onClose={closeInspector}
            onSave={onSave}
            onProposeCanon={onProposeCanon}
            onLink={onLink}
            onCancelLink={() => {
              setPendingLink(null);
              setTool('select');
            }}
            onJump={(id) => void jumpTo(id)}
          />
        ) : null}
      </div>
    </main>
  );
}
