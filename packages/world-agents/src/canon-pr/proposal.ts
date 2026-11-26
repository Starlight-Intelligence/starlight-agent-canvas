import { z } from 'zod';
import { worldNodeSchema, type WorldNode } from '@starlight-agent-canvas/world';
import { CanonProposalError } from './errors.js';
import { assertProposalPathAllowed, PROPOSALS_DIR } from './guard.js';
import { CANON_PROPOSAL_LIMITS, canonProposalRequestSchema, type CanonProposalRequestInput } from './request.js';

export const GENERATOR = '@starlight-agent-canvas/world-agents';
const PR_TITLE_MAX = 250;

/** Everything needed to open the canon PR. Pure data; deterministic for the same inputs and clock. */
export interface CanonProposalFile {
  slug: string;
  date: string;
  path: string;
  branch: string;
  markdown: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export interface BuildCanonProposalOptions {
  /** Clock used when the request has no `date`. Defaults to `() => new Date()`. The UTC date is used. */
  now?: () => Date;
}

/**
 * Lowercase ASCII slug of `[a-z0-9-]`, dashes collapsed and trimmed, at most
 * 60 characters. Accents are folded (é to e); anything else becomes a dash.
 * Falls back to `proposal` when nothing is left.
 */
export function slugify(input: string): string {
  const folded = input.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, CANON_PROPOSAL_LIMITS.slugMax).replace(/-+$/, '');
  return slug || 'proposal';
}

/** Collapses all whitespace, including newlines, to single spaces. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Things GitHub turns live even after backslash escaping, because it links
 * them in the rendered text: anything shaped like `scheme://...` (http, https,
 * ftp and others), `www.` hosts, email addresses and `mailto:`/`xmpp:` links,
 * @mentions, #123 and owner/repo#123 references, GH-123. These go into code
 * spans, where GitHub links nothing. None of the patterns can contain a
 * backtick or a pipe. The scheme and email local-part quantifiers are bounded
 * (32 and 64 characters) so a long alphanumeric run is not rescanned from
 * every position; a longer prefix stays outside the code span as plain text.
 */
const LIVE_TOKEN = new RegExp([
  /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s`|()<>[\]"']+/.source,
  /www\.[^\s`|()<>[\]"']+/.source,
  /(?:mailto|xmpp):[^\s`|()<>[\]"']+/.source,
  /[\w.+-]{1,64}@[\w-]+(?:\.[\w-]+)+/.source,
  /[@#][A-Za-z0-9][\w./-]*/.source,
  /\bGH-\d+\b/.source,
].join('|'), 'gi');
/** Markdown punctuation that can start links, images, emphasis, HTML, entities, math or table cells. */
const MARKDOWN_PUNCTUATION = /[\\`*_[\]()!#@&~<>|$]/g;

/**
 * Longest inline value rendered, in UTF-16 code units. Longer values are cut
 * and end in an ellipsis. Besides keeping the document readable, this bounds
 * the cost of LIVE_TOKEN, which can rescan long alphanumeric runs
 * (canon.ref, for one, has no length limit in L1).
 */
export const INLINE_TEXT_MAX = 2_000;

function capInline(line: string): string {
  if (line.length <= INLINE_TEXT_MAX) return line;
  let cut = line.slice(0, INLINE_TEXT_MAX);
  // Do not leave half of a surrogate pair at the cut.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Untrusted text placed inline (table cells, list items, headings): one line,
 * at most INLINE_TEXT_MAX characters, Markdown punctuation backslash-escaped
 * so it renders literally, and URLs, mentions and issue references in code
 * spans so they cannot link, ping or close issues.
 */
export function inlineMarkdown(text: string): string {
  const line = capInline(oneLine(text));
  let out = '';
  let last = 0;
  for (const match of line.matchAll(LIVE_TOKEN)) {
    out += line.slice(last, match.index).replace(MARKDOWN_PUNCTUATION, '\\$&');
    out += `\`${match[0]}\``;
    last = match.index + match[0].length;
  }
  return out + line.slice(last).replace(MARKDOWN_PUNCTUATION, '\\$&');
}
const inline = inlineMarkdown;

/**
 * Untrusted multi-line text as a fenced code block. The fence is longer than
 * any backtick run in the text, so the text cannot close it and cannot add
 * headings, tables or approval rows to the surrounding document.
 */
function fenced(text: string, info: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  let longest = 0;
  for (const run of normalized.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${normalized}${normalized.endsWith('\n') ? '' : '\n'}${fence}`;
}

function utcDate(now: () => Date): string {
  return now().toISOString().slice(0, 10);
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`;
}

function resolveNodes(worldId: string, nodeIds: readonly string[], nodes: readonly WorldNode[]): WorldNode[] {
  return nodeIds.map((id) => {
    const matches = nodes.filter((node) => node.id === id && node.worldId === worldId);
    if (matches.length === 0) {
      const elsewhere = nodes.find((node) => node.id === id);
      if (elsewhere) {
        throw new CanonProposalError('WRONG_WORLD', `Node ${id} belongs to world ${elsewhere.worldId}, not ${worldId}.`, id);
      }
      throw new CanonProposalError('NODE_NOT_FOUND', `Node ${id} was not supplied.`, id);
    }
    if (matches.length > 1) {
      throw new CanonProposalError('DUPLICATE_NODE', `Node ${id} was supplied ${matches.length} times for world ${worldId}.`, id);
    }
    const node = matches[0]!;
    if (node.canon.status === 'canon') {
      throw new CanonProposalError('ALREADY_CANON', `Node ${id} is already canon; there is nothing to propose.`, id);
    }
    return node;
  });
}

function canonStatusText(node: WorldNode): string {
  return node.canon.ref ? `${node.canon.status} (ref: ${inline(node.canon.ref)})` : node.canon.status;
}

function proposerText(harness: string, actor: string | undefined): string {
  return actor ? `${harness} (actor: ${inline(actor)})` : harness;
}

function renderMarkdown(input: {
  title: string;
  date: string;
  worldId: string;
  harness: string;
  actor?: string;
  rationale: string;
  nodes: WorldNode[];
}): string {
  const { title, date, worldId, harness, actor, rationale, nodes } = input;
  const lines: string[] = [];
  const push = (...more: string[]) => lines.push(...more);

  push(
    `# CANON PROPOSAL - ${inline(title.toUpperCase())}`,
    '> **This document PROPOSES canon. It is not canon, and nothing in it takes effect until the Creator (Frank) approves it.**',
    '>',
    `> *Last Updated: ${date}*`,
    '> *Status: STAGING ⏳ (proposal, not canon)*',
    `> *Proposed By: ${proposerText(harness, actor)}*`,
    '',
    '---',
    '',
    '## PURPOSE',
    '',
    `This file proposes ${nodes.length === 1 ? 'one entry' : `${nodes.length} entries`} from the world \`${worldId}\` for canon. It changes nothing: \`CANON_LOCKED.md\` and every existing lore file stay exactly as they are until the Creator (Frank) gives explicit approval.`,
    '',
    '**How to use:**',
    '- ✅ **LOCKED** = Canon, do not modify',
    '- ⏳ **STAGING** = Proposed, awaiting approval',
    '- 🔧 **EVOLVING** = Approved concept, details flexible',
    '',
    'Every entry in this file is ⏳ **STAGING**.',
    '',
    '---',
    '',
    '## PROPOSED ENTRIES',
    '',
    '| Entity | Kind | Node Id | Version | Summary |',
    '|--------|------|---------|---------|---------|',
  );
  for (const node of nodes) {
    push(`| **${inline(node.title)}** | ${node.kind} | \`${node.id}\` | ${node.version} | ${inline(node.summary) || '—'} |`);
  }
  for (const node of nodes) {
    push(
      '',
      `### ${inline(node.title)}`,
      '',
      `- **Node Id:** \`${node.id}\``,
      `- **Kind:** ${node.kind}`,
      `- **Tags:** ${node.tags.length > 0 ? node.tags.map(inline).join(', ') : '—'}`,
      `- **Current Canon Status:** ${canonStatusText(node)}`,
      `- **Summary:** ${inline(node.summary) || '—'}`,
      '',
      '**Body** (verbatim from the canvas, shown as a code block so nothing in it is read as part of this proposal):',
      '',
      node.body.length > 0 ? fenced(node.body, 'markdown') : '*(no body)*',
    );
  }
  push(
    '',
    '---',
    '',
    '## RATIONALE',
    '',
    fenced(rationale, 'text'),
    '',
    '---',
    '',
    '## PROVENANCE',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| World Id | \`${worldId}\` |`,
    `| Nodes | ${nodes.map((node) => `\`${node.id}\` v${node.version}`).join(', ')} |`,
    `| Proposer Harness | \`${harness}\` |`,
    `| Proposer Actor | ${actor ? inline(actor) : '—'} |`,
    `| Proposal Date | ${date} |`,
    `| Generated By | \`${GENERATOR}\` |`,
    '',
    '---',
    '',
    '## APPROVAL LOG',
    '',
    '| Date | Change | Status | Approved By |',
    '|------|--------|--------|-------------|',
    `| ${date} | ${inline(title)} | ⏳ STAGING | — |`,
    '',
    '---',
    '',
    '## HOW TO MODIFY CANON',
    '',
    'This proposal follows the process in `.arcanea/lore/CANON_LOCKED.md`:',
    '',
    '1. **Propose change** in STAGING. This file is that proposal.',
    '2. **Get explicit approval** from the Creator (Frank) on its pull request.',
    '3. **Move to LOCKED** only through `/lock-decision`, which adds the approval log entry to `CANON_LOCKED.md`.',
    '4. **Update all dependent files** once the decision is locked.',
    '',
    `The pull request that adds this file never edits \`CANON_LOCKED.md\` or any existing lore file. It adds exactly one new file under \`${PROPOSALS_DIR}\`.`,
    '',
  );
  return lines.join('\n');
}

function renderPrBody(input: {
  title: string;
  path: string;
  worldId: string;
  harness: string;
  actor?: string;
  rationale: string;
  nodes: WorldNode[];
}): string {
  const { title, path, worldId, harness, actor, rationale, nodes } = input;
  return [
    `## Canon proposal: ${inline(title)}`,
    '',
    'This draft PR adds one STAGING proposal file. It is not canon and changes nothing until the Creator (Frank) approves it.',
    '',
    `- **File:** \`${path}\``,
    `- **World:** \`${worldId}\``,
    `- **Proposed by harness:** \`${harness}\`${actor ? ` (actor: ${inline(actor)})` : ''}`,
    '',
    '### Rationale',
    '',
    fenced(rationale, 'text'),
    '',
    '### Proposed nodes',
    '',
    ...nodes.map((node) => `- **${inline(node.title)}** (\`${node.id}\`, ${node.kind}, v${node.version}, currently ${node.canon.status})`),
    '',
    '### Review checklist',
    '',
    `- [ ] This PR only adds one new file under \`${PROPOSALS_DIR}\`.`,
    '- [ ] It does not edit `CANON_LOCKED.md` or any existing lore file.',
    '- [ ] The proposed entries are consistent with `.arcanea/lore/CANON_LOCKED.md`.',
    '- [ ] Promotion to LOCKED happens only through `/lock-decision`, after explicit approval by the Creator (Frank).',
    '',
    `*Generated by \`${GENERATOR}\`.*`,
    '',
  ].join('\n');
}

/**
 * Builds the proposal file and PR text for `request.nodeIds`. Validates the
 * request (strict) and every node, and throws CanonProposalError when a node is
 * missing, in another world, supplied twice or already canon. Nodes not named
 * in `nodeIds` are ignored.
 */
export function buildCanonProposal(
  request: CanonProposalRequestInput,
  nodes: readonly WorldNode[],
  options: BuildCanonProposalOptions = {},
): CanonProposalFile {
  const parsedRequest = canonProposalRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new CanonProposalError('INVALID_REQUEST', `Invalid canon proposal request at ${firstIssue(parsedRequest.error)}`);
  }
  const parsedNodes = z.array(worldNodeSchema).safeParse(nodes);
  if (!parsedNodes.success) {
    throw new CanonProposalError('INVALID_NODE', `Invalid node at nodes.${firstIssue(parsedNodes.error)}`);
  }
  const req = parsedRequest.data;
  const selected = resolveNodes(req.worldId, req.nodeIds, parsedNodes.data);

  const date = req.date ?? utcDate(options.now ?? (() => new Date()));
  const slug = slugify(req.slug ?? req.title);
  const path = `${PROPOSALS_DIR}${date}-${slug}.md`;
  assertProposalPathAllowed(path);
  const branch = `canon/${slug}`;
  const title = oneLine(req.title);
  const { harness, actor } = req.proposer;

  const markdown = renderMarkdown({ title, date, worldId: req.worldId, harness, actor, rationale: req.rationale, nodes: selected });
  const prBody = renderPrBody({ title, path, worldId: req.worldId, harness, actor, rationale: req.rationale, nodes: selected });
  const fullPrTitle = `Canon proposal: ${title}`;
  const titleChars = Array.from(fullPrTitle);
  const prTitle = titleChars.length > PR_TITLE_MAX ? `${titleChars.slice(0, PR_TITLE_MAX - 1).join('')}…` : fullPrTitle;
  const commitMessage = [
    `docs(lore): add canon proposal ${slug}`,
    '',
    `Proposes ${selected.length === 1 ? '1 node' : `${selected.length} nodes`} from world ${req.worldId} as STAGING canon.`,
    'Changes nothing until the Creator (Frank) approves it.',
    '',
    `Proposed-by: ${harness}`,
  ].join('\n');

  return { slug, date, path, branch, markdown, commitMessage, prTitle, prBody };
}
