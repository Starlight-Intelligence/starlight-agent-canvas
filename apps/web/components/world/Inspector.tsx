'use client';

import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Link2, X } from 'lucide-react';
import { NODE_KINDS, RELATIONS } from '@starlight-agent-canvas/world';
import type { NodeKind, Relation, WorldEdge, WorldNode } from '@starlight-agent-canvas/world';
import type { CanonProposal } from '@starlight-agent-canvas/world';
import type { SearchHit, WorldSource } from '@/lib/world/source';

type DraftField = 'title' | 'kind' | 'summary' | 'body' | 'tags';
import { CanonBadge } from './nodes';
import { KIND_META, KindGlyph } from './kinds';

export interface PendingLink {
  from: string;
  to?: string;
}

interface InspectorProps {
  node: WorldNode | null;
  edges: WorldEdge[];
  titleOf: (id: string) => string;
  source: WorldSource;
  pendingLink: PendingLink | null;
  onClose: () => void;
  onSave: (node: WorldNode, patch: Record<string, unknown>) => Promise<boolean>;
  onProposeCanon: (node: WorldNode, note: string) => Promise<boolean>;
  onLink: (from: string, to: string, relation: Relation, label?: string) => Promise<boolean>;
  onCancelLink: () => void;
  onJump: (id: string) => void;
}

const RELATION_LABEL: Record<Relation, string> = {
  'appears-in': 'Appears in',
  'located-at': 'Located at',
  precedes: 'Precedes',
  follows: 'Follows',
  'member-of': 'Member of',
  'bonded-to': 'Bonded to',
  rules: 'Rules',
  'part-of': 'Part of',
  references: 'References',
  'canon-of': 'Canon of',
  contradicts: 'Contradicts',
};

export const Inspector = forwardRef<HTMLInputElement, InspectorProps>(function Inspector(props, titleRef) {
  const { node, edges, titleOf, source, pendingLink, onClose, onSave, onProposeCanon, onLink, onCancelLink, onJump } = props;
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<NodeKind>('note');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Current field values, readable after an await in the submit handler.
  const latest = useRef<Record<DraftField, string>>({ title, kind, summary, body, tags });
  latest.current = { title, kind, summary, body, tags };

  // Fields the user has typed in since the last successful save. A new node
  // version (a move, an optimistic save, a rollback or an edit elsewhere)
  // refreshes only the other fields, so neither a drag nor a rejected save
  // discards a draft. Selecting another node resets everything.
  const edited = useRef(new Set<DraftField>());
  const shownId = useRef<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  // Bumped after a successful save so the fields that were just saved resync
  // from the node as stored (trimmed title, cleaned tags, any server
  // normalization), even when the node version changed while they were still
  // marked edited and does not change again.
  const [resync, setResync] = useState(0);
  useEffect(() => {
    if (!node) return;
    if (shownId.current !== node.id) {
      edited.current.clear();
      setNote('');
      setSaveFailed(false);
      shownId.current = node.id;
    }
    const kept = edited.current;
    if (!kept.has('title')) setTitle(node.title);
    if (!kept.has('kind')) setKind(node.kind);
    if (!kept.has('summary')) setSummary(node.summary);
    if (!kept.has('body')) setBody(node.body);
    if (!kept.has('tags')) setTags(node.tags.join(', '));
  }, [node?.id, node?.version, resync]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = <T,>(field: DraftField, set: (v: T) => void) => (value: T) => {
    edited.current.add(field);
    set(value);
  };

  const patch = useMemo(() => {
    if (!node) return {};
    const out: Record<string, unknown> = {};
    const nextTags = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (title.trim() && title.trim() !== node.title) out.title = title.trim();
    if (kind !== node.kind) out.kind = kind;
    if (summary !== node.summary) out.summary = summary;
    if (body !== node.body) out.body = body;
    if (nextTags.join('\u0000') !== node.tags.join('\u0000')) out.tags = nextTags;
    return out;
  }, [node, title, kind, summary, body, tags]);

  const dirty = Object.keys(patch).length > 0;
  const proposal = node && source.kind === 'local' && 'proposals' in source
    ? (source as WorldSource & { proposals(): CanonProposal[] }).proposals().find((p) => p.targetType === 'node' && p.id === node.id)
    : undefined;
  const locked = node?.canon.status === 'canon';

  if (!node && !pendingLink) return null;

  return (
    <aside
      className="wc-inspector"
      aria-label="Inspector"
      onKeyDown={(e) => {
        // Escape closes from anywhere inside, including form fields.
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        if (pendingLink?.to) onCancelLink();
        else onClose();
      }}
    >
      {pendingLink && pendingLink.to ? (
        <RelationPicker
          from={pendingLink.from}
          to={pendingLink.to}
          titleOf={titleOf}
          source={source}
          onCancel={onCancelLink}
          onLink={onLink}
        />
      ) : null}
      {node ? (
        <form
          className="wc-inspector-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!dirty || locked) return;
            setBusy(true);
            const submitted = { ...latest.current };
            const ok = await onSave(node, patch);
            setBusy(false);
            setSaveFailed(!ok);
            if (ok) {
              // Fields typed in again while saving stay a draft.
              for (const f of [...edited.current]) if (latest.current[f] === submitted[f]) edited.current.delete(f);
              setResync((n) => n + 1);
            }
          }}
        >
          <header className="wc-inspector-head">
            <span className="wc-inspector-kind"><KindGlyph kind={node.kind} /> {KIND_META[node.kind].label}</span>
            <CanonBadge status={node.canon.status} />
            <span className="wc-inspector-version" title="Node version, used as baseVersion for edits">v{node.version}</span>
            <button type="button" className="wc-icon-btn" onClick={onClose} aria-label="Close inspector">
              <X size={16} aria-hidden="true" />
            </button>
          </header>

          <label className="wc-field">
            <span>Title</span>
            <input ref={titleRef} value={title} onChange={(e) => edit('title', setTitle)(e.target.value)} disabled={locked} maxLength={300} required />
          </label>
          <label className="wc-field">
            <span>Kind</span>
            <select value={kind} onChange={(e) => edit('kind', setKind)(e.target.value as NodeKind)} disabled={locked}>
              {NODE_KINDS.map((k) => <option key={k} value={k}>{KIND_META[k].label}</option>)}
            </select>
          </label>
          <label className="wc-field">
            <span>Summary</span>
            <textarea value={summary} onChange={(e) => edit('summary', setSummary)(e.target.value)} rows={3} disabled={locked} maxLength={2000} />
          </label>
          <label className="wc-field">
            <span>Body</span>
            <textarea value={body} onChange={(e) => edit('body', setBody)(e.target.value)} rows={6} disabled={locked} placeholder="Markdown" />
          </label>
          <label className="wc-field">
            <span>Tags</span>
            <input value={tags} onChange={(e) => edit('tags', setTags)(e.target.value)} disabled={locked} placeholder="Comma separated" />
          </label>

          <div className="wc-inspector-actions">
            <button type="submit" className="wc-btn wc-btn--primary" disabled={!dirty || busy || locked}>
              {busy ? 'Saving' : 'Save changes'}
            </button>
            {dirty ? <span className="wc-muted" role="status">{saveFailed ? 'Not saved. Your draft is kept; save again to retry.' : 'Unsaved changes'}</span> : null}
          </div>

          <section className="wc-section" aria-labelledby="canon-heading">
            <h4 id="canon-heading">Canon</h4>
            {node.canon.status === 'draft' ? (
              <>
                <p className="wc-muted">Canon lives in git. Proposing marks this node proposed and queues it for a canon PR, which a separate git flow opens for human review; it never sets canon here.</p>
                <label className="wc-field">
                  <span>Why it belongs in canon</span>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
                </label>
                <button
                  type="button"
                  className="wc-btn"
                  disabled={busy || dirty}
                  title={dirty ? 'Save changes first' : undefined}
                  onClick={async () => {
                    setBusy(true);
                    await onProposeCanon(node, note.trim());
                    setBusy(false);
                  }}
                >
                  Propose canon
                </button>
              </>
            ) : node.canon.status === 'proposed' ? (
              <p className="wc-muted">
                {source.kind === 'local'
                  ? `Proposed in this local world${proposal ? ` at v${proposal.version}` : ''}. Local mode has no canon PR queue, so nothing is queued; open the canon PR through the git flow. `
                  : 'Proposed. '}
                {node.canon.ref ? <a href={node.canon.ref} target="_blank" rel="noreferrer">Open the canon PR</a> : 'Waiting for the canon PR.'} Editing content moves it back to draft.
              </p>
            ) : (
              <p className="wc-muted">
                Canon. Locked from edits here. {node.canon.ref ? <a href={node.canon.ref} target="_blank" rel="noreferrer">Canon source</a> : null}
              </p>
            )}
          </section>

          <section className="wc-section" aria-labelledby="rel-heading">
            <h4 id="rel-heading">Relations</h4>
            {edges.length ? (
              <ul className="wc-rel-list">
                {edges.slice(0, 40).map((edge) => {
                  const outgoing = edge.from === node.id;
                  const other = outgoing ? edge.to : edge.from;
                  return (
                    <li key={edge.id}>
                      <button type="button" className="wc-rel" onClick={() => onJump(other)}>
                        <span className="wc-muted">{outgoing ? RELATION_LABEL[edge.relation] : `${RELATION_LABEL[edge.relation]} (from)`}</span>
                        <span className="wc-rel-title">{titleOf(other)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="wc-muted">No relations loaded.</p>
            )}
            {!pendingLink ? <RelationPicker from={node.id} titleOf={titleOf} source={source} onLink={onLink} /> : null}
          </section>
        </form>
      ) : null}
    </aside>
  );
});

function RelationPicker({
  from,
  to: initialTo,
  titleOf,
  source,
  onLink,
  onCancel,
}: {
  from: string;
  to?: string;
  titleOf: (id: string) => string;
  source: WorldSource;
  onLink: (from: string, to: string, relation: Relation, label?: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [relation, setRelation] = useState<Relation>('references');
  const [label, setLabel] = useState('');
  const [to, setTo] = useState<string | undefined>(initialTo);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => setTo(initialTo), [initialTo]);
  useEffect(() => {
    let live = true;
    if (!query.trim()) {
      setHits([]);
      return;
    }
    source.search(query, 6).then((h) => live && setHits(h.filter((x) => x.id !== from)));
    return () => {
      live = false;
    };
  }, [query, source, from]);

  return (
    <div className="wc-relpicker" role="group" aria-label="New relation">
      <p className="wc-relpicker-title"><Link2 size={14} aria-hidden="true" /> New relation</p>
      <div className="wc-relpicker-row">
        <span className="wc-chip">{titleOf(from)}</span>
        <select aria-label="Relation" value={relation} onChange={(e) => setRelation(e.target.value as Relation)}>
          {RELATIONS.filter((r) => r !== 'canon-of').map((r) => <option key={r} value={r}>{RELATION_LABEL[r]}</option>)}
        </select>
        <ArrowRight size={14} aria-hidden="true" />
        {to ? (
          <span className="wc-chip">
            {titleOf(to)}
            {!initialTo ? (
              <button type="button" className="wc-chip-x" aria-label="Clear target" onClick={() => setTo(undefined)}><X size={12} aria-hidden="true" /></button>
            ) : null}
          </span>
        ) : (
          <div className="wc-combo">
            <input aria-label="Target node" placeholder="Find a node" value={query} onChange={(e) => setQuery(e.target.value)} />
            {hits.length ? (
              <ul className="wc-combo-list" role="listbox">
                {hits.map((h) => (
                  <li key={h.id} role="option" aria-selected="false">
                    <button type="button" onClick={() => { setTo(h.id); setQuery(''); }}>
                      <KindGlyph kind={h.kind} size={12} /> {h.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>
      <label className="wc-field">
        <span>Label (optional)</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
      </label>
      <div className="wc-inspector-actions">
        <button
          type="button"
          className="wc-btn wc-btn--primary"
          disabled={!to || busy}
          onClick={async () => {
            if (!to) return;
            setBusy(true);
            const ok = await onLink(from, to, relation, label.trim() || undefined);
            setBusy(false);
            if (ok && !initialTo) {
              setTo(undefined);
              setLabel('');
            }
          }}
        >
          Add relation
        </button>
        {onCancel ? <button type="button" className="wc-btn wc-btn--ghost" onClick={onCancel}>Cancel</button> : null}
      </div>
    </div>
  );
}
