#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { importClaudeWhiteboard, type ImportLexicon } from '../import/claude-whiteboard.js';

const USAGE = `Usage: starlight-world-import-whiteboard --in <whiteboard.json> --out <world.json> [options]

Converts a claude.ai whiteboard export into a World Graph v1 document.

Options:
  --in <path>         Whiteboard export (claude-whiteboard v1 elements). Required.
  --out <path>        Where to write the world JSON. Omit to print to stdout.
  --world-id <id>     World id. Default: slug of the export title.
  --title <text>      World title. Default: the export title.
  --at <iso>          Timestamp for createdBy/updatedAt. Default: exportedAt.
  --lexicon <path>    JSON { "kinds": { "Title": "kind" }, "tags": { "Title": ["tag"] } }.
  --report <path>     Also write the import report JSON here.
  -h, --help          Show this help.

The import report is printed to stderr.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      'world-id': { type: 'string' },
      title: { type: 'string' },
      at: { type: 'string' },
      lexicon: { type: 'string' },
      report: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!values.in) {
    process.stderr.write(`${USAGE}\n\nerror: --in is required\n`);
    process.exitCode = 2;
    return;
  }

  const input = JSON.parse(await readFile(resolve(values.in), 'utf8')) as unknown;
  const lexicon = values.lexicon
    ? (JSON.parse(await readFile(resolve(values.lexicon), 'utf8')) as ImportLexicon)
    : undefined;

  const { graph, report } = importClaudeWhiteboard(input, {
    worldId: values['world-id'],
    title: values.title,
    at: values.at,
    lexicon,
  });

  const json = `${JSON.stringify(graph, null, 2)}\n`;
  if (values.out) await writeAtomic(resolve(values.out), json);
  else process.stdout.write(json);

  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  if (values.report) await writeAtomic(resolve(values.report), reportJson);
  process.stderr.write(reportJson);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, path);
}

main().catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
