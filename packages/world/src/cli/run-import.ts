import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { importClaudeWhiteboard, type ImportLexicon } from '../import/claude-whiteboard.js';
import { findPathOverlaps } from './paths.js';

export const USAGE = `Usage: starlight-world-import-whiteboard --in <whiteboard.json> --out <world.json> [options]

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

--in, --lexicon, --out and --report must all be different files.
The import report is printed to stderr.`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  platform?: NodeJS.Platform;
}

/** Runs the import CLI. Returns the process exit code. */
export async function runImportWhiteboard(argv: string[], io: CliIo): Promise<number> {
  let values: ReturnType<typeof parse>['values'];
  try {
    values = parse(argv).values;
  } catch (error) {
    io.stderr(`${USAGE}\n\nerror: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (!values.in) {
    io.stderr(`${USAGE}\n\nerror: --in is required\n`);
    return 2;
  }

  const overlaps = findPathOverlaps(
    { '--in': values.in, '--lexicon': values.lexicon, '--out': values.out, '--report': values.report },
    io.platform,
  );
  if (overlaps.length > 0) {
    io.stderr(`error: ${overlaps.map(([a, b]) => `${a} and ${b} are the same file`).join('; ')}. Refusing to overwrite.\n`);
    return 2;
  }

  try {
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
    else io.stdout(json);

    const reportJson = `${JSON.stringify(report, null, 2)}\n`;
    if (values.report) await writeAtomic(resolve(values.report), reportJson);
    io.stderr(reportJson);
    return 0;
  } catch (error) {
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
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
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, path);
}
