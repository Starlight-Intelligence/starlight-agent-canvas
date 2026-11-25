import { WorldClientValidationError } from './errors.js';
import { WORLD_TOOLS, type WorldToolInput, type WorldToolName, type WorldToolOutput } from './tools.js';

/**
 * Moves one tool call to the server. Returns the tool's JSON payload, or
 * throws (WorldToolError for tool failures).
 */
export interface WorldTransport {
  callTool(name: WorldToolName, args: Record<string, unknown>): Promise<unknown>;
}

/** Tool arguments; `worldId` becomes optional when the client has a default world. */
export type WorldToolArgs<N extends WorldToolName, HasWorld extends boolean> = HasWorld extends true
  ? Omit<WorldToolInput<N>, 'worldId'> & { worldId?: string }
  : WorldToolInput<N>;

export interface WorldClient<HasWorld extends boolean = boolean> {
  readonly worldId: HasWorld extends true ? string : undefined;
  getWorld(args: WorldToolArgs<'get_world', HasWorld>): Promise<WorldToolOutput<'get_world'>>;
  getRegion(args: WorldToolArgs<'get_region', HasWorld>): Promise<WorldToolOutput<'get_region'>>;
  search(args: WorldToolArgs<'search', HasWorld>): Promise<WorldToolOutput<'search'>>;
  addNode(args: WorldToolArgs<'add_node', HasWorld>): Promise<WorldToolOutput<'add_node'>>;
  updateNode(args: WorldToolArgs<'update_node', HasWorld>): Promise<WorldToolOutput<'update_node'>>;
  link(args: WorldToolArgs<'link', HasWorld>): Promise<WorldToolOutput<'link'>>;
  move(args: WorldToolArgs<'move', HasWorld>): Promise<WorldToolOutput<'move'>>;
  proposeCanon(args: WorldToolArgs<'propose_canon', HasWorld>): Promise<WorldToolOutput<'propose_canon'>>;
  layoutRegion(args: WorldToolArgs<'layout_region', HasWorld>): Promise<WorldToolOutput<'layout_region'>>;
  /** Never takes the default world: omitting worldId means "create a new world". */
  importWhiteboard(args: WorldToolInput<'import_whiteboard'>): Promise<WorldToolOutput<'import_whiteboard'>>;
}

export interface WorldClientOptions {
  transport: WorldTransport;
  /** Default world for every tool except import_whiteboard. */
  worldId?: string;
}

export function createWorldClient(options: WorldClientOptions & { worldId: string }): WorldClient<true>;
export function createWorldClient(options: WorldClientOptions & { worldId?: undefined }): WorldClient<false>;
export function createWorldClient(options: WorldClientOptions): WorldClient;
export function createWorldClient(options: WorldClientOptions): WorldClient {
  const { transport, worldId: defaultWorldId } = options;

  async function call<N extends WorldToolName>(name: N, args: object, useDefaultWorld: boolean): Promise<WorldToolOutput<N>> {
    const raw = args as Record<string, unknown>;
    const withWorld = useDefaultWorld && raw.worldId === undefined && defaultWorldId !== undefined
      ? { ...raw, worldId: defaultWorldId }
      : raw;
    const { input, output } = WORLD_TOOLS[name];
    const parsedInput = input.safeParse(withWorld);
    if (!parsedInput.success) throw new WorldClientValidationError(name, 'input', parsedInput.error.issues);
    const payload = await transport.callTool(name, parsedInput.data as Record<string, unknown>);
    const parsedOutput = output.safeParse(payload);
    if (!parsedOutput.success) throw new WorldClientValidationError(name, 'output', parsedOutput.error.issues);
    return parsedOutput.data as WorldToolOutput<N>;
  }

  return {
    worldId: defaultWorldId,
    getWorld: (args) => call('get_world', args, true),
    getRegion: (args) => call('get_region', args, true),
    search: (args) => call('search', args, true),
    addNode: (args) => call('add_node', args, true),
    updateNode: (args) => call('update_node', args, true),
    link: (args) => call('link', args, true),
    move: (args) => call('move', args, true),
    proposeCanon: (args) => call('propose_canon', args, true),
    layoutRegion: (args) => call('layout_region', args, true),
    importWhiteboard: (args) => call('import_whiteboard', args, false),
  };
}
