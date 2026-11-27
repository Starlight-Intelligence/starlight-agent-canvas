'use client';

import { memo, type CSSProperties } from 'react';
import { Handle, Position, useStore, type Node, type NodeProps, type ReactFlowState } from '@xyflow/react';
import { NODE_KINDS, semanticZoomLevel } from '@starlight-agent-canvas/world';
import type { CanonStatus, NodeKind, SemanticZoomLevel, WorldNode } from '@starlight-agent-canvas/world';
import { hexToRgba } from '@/lib/world/tints';
import { KIND_META, KindGlyph } from './kinds';

export type WorldNodeData = {
  node: WorldNode;
  tint: string;
  dim: boolean;
  linkSource: boolean;
};
export type WorldFlowNode = Node<WorldNodeData>;

export type RegionNodeData = {
  title: string;
  tint: string;
  total: number;
  counts: string;
  mode: 'graph' | 'map' | 'lane';
};
export type RegionFlowNode = Node<RegionNodeData, 'region'>;

const zoomSelector = (s: ReactFlowState) => s.transform[2];
const levelSelector = (s: ReactFlowState) => semanticZoomLevel(s.transform[2] > 0 ? s.transform[2] : 1);

/** Re-renders only when the zoom crosses a semantic threshold, not on every zoom tick. */
export function useSemanticLevel(): SemanticZoomLevel {
  return useStore(levelSelector);
}

const CANON_LABEL: Record<CanonStatus, string> = { draft: 'Draft', proposed: 'Proposed', canon: 'Canon' };

export function CanonBadge({ status, quiet = false }: { status: CanonStatus; quiet?: boolean }) {
  if (quiet && status === 'draft') return null;
  return (
    <span className={`wc-canon wc-canon--${status}`} title={`Canon status: ${CANON_LABEL[status].toLowerCase()}`}>
      {CANON_LABEL[status]}
    </span>
  );
}

function excerpt(markdown: string, max = 260): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

function widthFor(node: WorldNode): number {
  const w = node.size?.w ?? 240;
  return node.kind === 'image' ? Math.min(Math.max(w, 200), 520) : Math.min(Math.max(w, 168), 520);
}

function Thumb({ node, tint, level, fill }: { node: WorldNode; tint: string; level: SemanticZoomLevel; fill: boolean }) {
  const media = node.media[0];
  const ratio = media?.width && media?.height ? media.height / media.width : node.size ? node.size.h / node.size.w : 0.62;
  const style: CSSProperties = {
    aspectRatio: fill ? undefined : `${1} / ${Math.min(Math.max(ratio, 0.4), 1.4)}`,
    flex: fill ? '1 1 auto' : undefined,
    background: `radial-gradient(120% 90% at 30% 20%, ${hexToRgba(tint, 0.34)}, ${hexToRgba(tint, 0.08)} 60%, #0c0c0f)`,
  };
  return (
    <div className="wn-thumb" style={style}>
      {media?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.url} alt={media.alt || node.title} loading="lazy" decoding="async" />
      ) : (
        <span className="wn-thumb-glyph">
          <KindGlyph kind={node.kind} size={level === 'full' ? 28 : 22} />
        </span>
      )}
    </div>
  );
}

function makeNodeComponent(kind: NodeKind) {
  const variant =
    kind === 'image' ? 'image'
    : kind === 'character' || kind === 'god' || kind === 'godbeast' ? 'portrait'
    : kind === 'story' || kind === 'book' || kind === 'chapter' || kind === 'scene' ? 'book'
    : kind === 'note' ? 'note'
    : kind === 'gate' ? 'gate'
    : kind === 'region' || kind === 'world' ? 'heading'
    : 'plain';

  function WorldNodeComponent({ data, selected }: NodeProps<WorldFlowNode>) {
    const level = useSemanticLevel();
    const { node, tint, dim, linkSource } = data;
    const meta = KIND_META[node.kind];
    const hasImage = variant === 'image' || node.media.some((m) => m.role === 'portrait' || m.role === 'cover' || m.role === 'plate');
    const needsReupload = node.media.length > 0 && node.media.every((m) => !m.url && m.needsReupload);
    const width = level === 'cluster' ? 56 : widthFor(node);
    // Images and gates keep their authored height: the whiteboard places captions,
    // gods and godbeasts relative to those boxes, so growing them causes overlaps.
    const fixedHeight =
      level !== 'cluster' && node.size && (variant === 'image' || variant === 'gate') ? Math.round(node.size.h * (width / node.size.w)) : undefined;
    const style: CSSProperties = {
      width,
      height: fixedHeight,
      ['--tint' as string]: tint,
      ['--tint-soft' as string]: hexToRgba(tint, 0.1),
    };
    const className = [
      'wn',
      `wn--${variant}`,
      `wn--${level}`,
      fixedHeight !== undefined ? 'is-fixed' : '',
      selected ? 'is-selected' : '',
      dim ? 'is-dim' : '',
      linkSource ? 'is-link-source' : '',
    ].join(' ');

    return (
      <article className={className} style={style} aria-label={`${meta.label}: ${node.title}. ${CANON_LABEL[node.canon.status]}.`}>
        <Handle type="target" position={Position.Left} className="wn-handle" />
        {level === 'cluster' ? (
          <div className="wn-dot"><KindGlyph kind={node.kind} size={18} /></div>
        ) : (
          <>
            {hasImage && variant === 'image' ? <Thumb node={node} tint={tint} level={level} fill={fixedHeight !== undefined} /> : null}
            <div className="wn-body">
              {variant === 'gate' || variant === 'image' ? (
                <header className="wn-head wn-head--inline">
                  <span className="wn-glyph"><KindGlyph kind={node.kind} size={13} /></span>
                  <h3 className="wn-title">{node.title}</h3>
                  <CanonBadge status={node.canon.status} quiet={level !== 'full'} />
                </header>
              ) : (
                <>
                  <header className="wn-head">
                    <span className={variant === 'portrait' ? 'wn-avatar' : 'wn-glyph'}><KindGlyph kind={node.kind} size={variant === 'portrait' ? 16 : 13} /></span>
                    <span className="wn-kind">{meta.label}</span>
                    <CanonBadge status={node.canon.status} quiet={level !== 'full'} />
                  </header>
                  <h3 className="wn-title">{node.title}</h3>
                </>
              )}
              {level === 'full' ? (
                <>
                  {node.summary ? <p className="wn-summary">{node.summary}</p> : null}
                  {node.body ? <p className="wn-excerpt">{excerpt(node.body)}</p> : null}
                  {node.tags.length ? (
                    <ul className="wn-tags" aria-label="Tags">
                      {node.tags.slice(0, 6).map((t) => <li key={t}>{t}</li>)}
                    </ul>
                  ) : null}
                </>
              ) : null}
              {needsReupload && level === 'full' ? <p className="wn-note">Image needs re-upload</p> : null}
            </div>
          </>
        )}
        <Handle type="source" position={Position.Right} className="wn-handle" />
      </article>
    );
  }
  WorldNodeComponent.displayName = `WorldNode(${kind})`;
  return memo(WorldNodeComponent);
}

function RegionNodeComponent({ data, width, height }: NodeProps<RegionFlowNode>) {
  const zoom = useStore(zoomSelector);
  const level = semanticZoomLevel(zoom > 0 ? zoom : 1);
  const showCluster = data.mode === 'map' || level === 'cluster';
  // Labels hold a steady on-screen size while the region scales with zoom, but
  // shrink to fit narrow regions so neighbouring labels never collide.
  const screenW = (width ?? 0) * zoom;
  const fit = screenW / (Math.max(data.title.length, 6) * 0.62);
  const labelPx = showCluster ? Math.max(10, Math.min(22, fit)) : Math.max(9, Math.min(13, fit));
  const showCounts = showCluster && screenW > 150;
  const style: CSSProperties = {
    width,
    height,
    ['--tint' as string]: data.tint,
    background: hexToRgba(data.tint, data.mode === 'lane' ? 0.06 : 0.08),
    borderColor: hexToRgba(data.tint, 0.28),
  };
  return (
    <section className={`wr wr--${data.mode} ${showCluster ? 'is-cluster' : ''}`} style={style} aria-label={`Region: ${data.title}, ${data.total} nodes`}>
      <div className="wr-label" style={{ fontSize: labelPx / zoom, padding: `${(showCluster ? 12 : 8) / zoom}px ${(showCluster ? 16 : 12) / zoom}px` }}>
        <span className="wr-title" style={{ textShadow: showCluster ? `0 0 ${20 / zoom}px ${hexToRgba(data.tint, 0.45)}` : 'none' }}>{data.title}</span>
        {showCounts ? (
          <span className="wr-counts" style={{ fontSize: (labelPx * 0.58) / zoom }}>
            {data.total.toLocaleString('en-US')} nodes{data.counts ? ` · ${data.counts}` : ''}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export const RegionNode = memo(RegionNodeComponent);

export const worldNodeTypes = {
  ...Object.fromEntries(NODE_KINDS.map((kind) => [kind, makeNodeComponent(kind)])),
  region: RegionNode,
} as Record<string, ReturnType<typeof makeNodeComponent> | typeof RegionNode>;

/** Region nodes and world `region` kind nodes share the name; world nodes get a prefixed type. */
export function flowTypeForKind(kind: NodeKind): string {
  return kind === 'region' ? 'kind-region' : kind;
}
worldNodeTypes['kind-region'] = makeNodeComponent('region');
