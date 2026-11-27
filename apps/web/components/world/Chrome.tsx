'use client';

import { forwardRef, useEffect, useState } from 'react';
import { Activity, Hand, Link2, Maximize2, MousePointer2, Plus, Search, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useStore } from '@xyflow/react';
import type { SemanticZoomLevel } from '@starlight-agent-canvas/world';
import type { ActivityEntry, SearchHit, WorldSource } from '@/lib/world/source';
import { KindGlyph } from './kinds';
import { useSemanticLevel } from './nodes';

export type WorldView = 'graph' | 'timeline' | 'map';
export type Tool = 'select' | 'pan' | 'link';

const VIEWS: { id: WorldView; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'map', label: 'Map' },
];

interface TopBarProps {
  title: string;
  version: number;
  nodeCount: number;
  sourceKind: 'local' | 'remote';
  view: WorldView;
  onView: (view: WorldView) => void;
  depth: number;
  onDepth: (depth: number) => void;
  canFocus: boolean;
  source: WorldSource | null;
  onPick: (hit: SearchHit) => void;
  activityOpen: boolean;
  onToggleActivity: () => void;
}

export const TopBar = forwardRef<HTMLInputElement, TopBarProps>(function TopBar(props, searchRef) {
  const { title, version, nodeCount, sourceKind, view, onView, depth, onDepth, canFocus, source, onPick, activityOpen, onToggleActivity } = props;
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let live = true;
    if (!source || !query.trim()) {
      setHits([]);
      return;
    }
    source.search(query, 8).then((h) => {
      if (!live) return;
      setHits(h);
      setActive(0);
    });
    return () => {
      live = false;
    };
  }, [query, source]);

  const pick = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onPick(hit);
    setQuery('');
    setHits([]);
  };

  return (
    <header className="wc-topbar">
      <div className="wc-topbar-title">
        <h1>{title}</h1>
        <span className="wc-muted wc-hide-sm">
          {nodeCount.toLocaleString('en-US')} nodes · v{version}{sourceKind === 'remote' ? ' · live' : ''}
        </span>
      </div>

      <div className="wc-topbar-center">
        <div className="wc-segment" role="radiogroup" aria-label="View">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={view === v.id}
              className={view === v.id ? 'is-on' : ''}
              onClick={() => onView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === 'graph' ? (
          <div className="wc-segment wc-depth" role="radiogroup" aria-label="Focus depth" title={canFocus ? 'Neighborhood focus around the selected node' : 'Select a node to focus its neighborhood'}>
            <span className="wc-segment-label wc-hide-sm">Depth</span>
            {[0, 1, 2, 3].map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={depth === d}
                aria-label={d === 0 ? 'Focus off' : `Focus depth ${d}`}
                className={depth === d ? 'is-on' : ''}
                disabled={!canFocus && d > 0}
                onClick={() => onDepth(d)}
              >
                {d === 0 ? 'All' : d}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="wc-topbar-right">
        <div className="wc-search" role="combobox" aria-expanded={hits.length > 0} aria-haspopup="listbox" aria-owns="wc-search-list">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search nodes"
            aria-label="Search nodes"
            aria-controls="wc-search-list"
            aria-activedescendant={hits[active] ? `wc-hit-${hits[active].id}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, hits.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(hits[active]);
              } else if (e.key === 'Escape') {
                setQuery('');
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <kbd className="wc-hide-sm" aria-hidden="true">/</kbd>
          {hits.length ? (
            <ul id="wc-search-list" className="wc-search-list" role="listbox" aria-label="Search results">
              {hits.map((h, i) => (
                <li key={h.id} id={`wc-hit-${h.id}`} role="option" aria-selected={i === active}>
                  <button type="button" className={i === active ? 'is-active' : ''} onMouseEnter={() => setActive(i)} onClick={() => pick(h)}>
                    <KindGlyph kind={h.kind} size={13} />
                    <span>{h.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          className={`wc-icon-btn ${activityOpen ? 'is-on' : ''}`}
          aria-pressed={activityOpen}
          aria-label="Activity"
          title="Activity"
          onClick={onToggleActivity}
        >
          <Activity size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
});

interface ToolbarProps {
  tool: Tool;
  onTool: (tool: Tool) => void;
  onAdd: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  canEdit: boolean;
}

const LEVEL_LABEL: Record<SemanticZoomLevel, string> = { cluster: 'Cluster', card: 'Card', full: 'Full' };

export function Toolbar({ tool, onTool, onAdd, onZoomIn, onZoomOut, onFit, canEdit }: ToolbarProps) {
  const level = useSemanticLevel();
  // Rounded so the readout re-renders per percent, not per zoom event.
  const zoom = useStore((s) => Math.round(s.transform[2] * 100) / 100);
  const toolBtn = (id: Tool, label: string, key: string, icon: React.ReactNode) => (
    <button
      type="button"
      className={`wc-tool ${tool === id ? 'is-on' : ''}`}
      aria-pressed={tool === id}
      aria-label={`${label} (${key})`}
      title={`${label} (${key})`}
      onClick={() => onTool(id)}
      disabled={id === 'link' && !canEdit}
    >
      {icon}
    </button>
  );
  return (
    <div className="wc-toolbar" role="toolbar" aria-label="Canvas tools">
      {toolBtn('select', 'Select', 'V', <MousePointer2 size={16} aria-hidden="true" />)}
      {toolBtn('pan', 'Pan', 'H', <Hand size={16} aria-hidden="true" />)}
      <button type="button" className="wc-tool" aria-label="Add node (N)" title="Add node (N)" onClick={onAdd} disabled={!canEdit}>
        <Plus size={16} aria-hidden="true" />
      </button>
      {toolBtn('link', 'Link', 'L', <Link2 size={16} aria-hidden="true" />)}
      <span className="wc-toolbar-sep" aria-hidden="true" />
      <button type="button" className="wc-tool" aria-label="Zoom out (minus)" title="Zoom out (-)" onClick={onZoomOut}>
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <span className="wc-zoom-readout" aria-live="polite">
        {LEVEL_LABEL[level]} <span className="wc-muted">{Math.round(zoom * 100)}%</span>
      </span>
      <button type="button" className="wc-tool" aria-label="Zoom in (plus)" title="Zoom in (+)" onClick={onZoomIn}>
        <ZoomIn size={16} aria-hidden="true" />
      </button>
      <button type="button" className="wc-tool" aria-label="Fit view (0)" title="Fit view (0)" onClick={onFit}>
        <Maximize2 size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function relTime(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ActivityRail({ entries, onClose, onJump }: { entries: ActivityEntry[]; onClose: () => void; onJump: (id: string) => void }) {
  return (
    <aside className="wc-activity" aria-label="Activity">
      <header className="wc-activity-head">
        <h2>Activity</h2>
        <button type="button" className="wc-icon-btn" onClick={onClose} aria-label="Close activity">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <p className="wc-muted wc-activity-hint">Which harness made each change.</p>
      <ol className="wc-activity-list">
        {entries.map((e) => (
          <li key={e.id} className={`wc-act wc-act--${e.status}`}>
            <button type="button" onClick={() => e.targetIds[0] && onJump(e.targetIds[0])} disabled={!e.targetIds.length}>
              <span className="wc-harness">{e.harness}</span>
              <span className="wc-act-summary">{e.summary}</span>
              <span className="wc-act-meta">
                {e.status === 'pending' ? 'Sending · ' : e.status === 'rejected' ? 'Rejected · ' : ''}
                {relTime(e.at)}
              </span>
              {e.error ? <span className="wc-act-error">{e.error}</span> : null}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}
