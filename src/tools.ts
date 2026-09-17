import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findClarionRoot, findSolution, buildPaths,
         type ClarionRoot, type UpdatePathsParams } from "./clarion.js";
import { LspClient, toUri, fromUri, type SpawnSpec, type ClientOptions, type Range } from "./lsp.js";

export interface SessionOptions {
  cwd: string;
  findRoot: (override?: string) => ClarionRoot;
  spawnSpec: (c: ClarionRoot) => SpawnSpec;
  clientOpts: ClientOptions;
}
export interface Session {
  opts: SessionOptions;
  clarion?: ClarionRoot;
  solution?: string;
  params?: UpdatePathsParams;
  ready: boolean;
  client?: LspClient;
}

export function createSession(overrides: Partial<SessionOptions> = {}): Session {
  return {
    ready: false,
    opts: {
      cwd: process.cwd(),
      findRoot: override => findClarionRoot({ override }),
      spawnSpec: c => ({ command: c.nodeExe, args: [c.serverMain, "--stdio"], cwd: c.serverDir }),
      clientOpts: {},
      ...overrides,
    },
  };
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
export const ok = (data: unknown): ToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
export const fail = (message: string): ToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function startClient(s: Session): Promise<void> {
  await s.client?.stop();
  const client = new LspClient(s.opts.spawnSpec(s.clarion!), s.opts.clientOpts);
  s.client = client;
  await client.start(pathToFileURL(path.dirname(s.solution!)).href);
  s.ready = await client.openSolution(s.params!);
}

async function openSolution(s: Session, args: { solution_path?: string; configuration?: string; clarion_root?: string }) {
  const solution = findSolution(args.solution_path, s.opts.cwd);
  const clarion = s.opts.findRoot(args.clarion_root);
  const params = buildPaths(clarion, solution, args.configuration ?? "Debug");
  const sameSolution = s.client?.running && s.solution === solution && s.clarion?.root === clarion.root;
  s.solution = solution; s.clarion = clarion; s.params = params;
  if (sameSolution) s.ready = await s.client!.openSolution(params);
  else await startClient(s);
  return {
    solution, clarionRoot: clarion.root, clarionVersion: clarion.version,
    redirectionFile: params.redirectionFile, ready: s.ready,
    ...(s.ready ? {} : { stderrTail: [...s.client!.stderrTail] }),
  };
}

export async function withClient<T>(s: Session, fn: (c: LspClient) => Promise<T>): Promise<T> {
  if (!s.solution || !s.params || !s.client) throw new Error("No solution open. Call open_solution first.");
  return fn(s.client);
}

function checkFile(file_path: string): string {
  const p = path.resolve(file_path);
  if (!existsSync(p)) throw new Error(`File not found: ${p}`);
  return p;
}

const pos = { file_path: z.string(), line: z.number().int().min(0), character: z.number().int().min(0) };
type Loc = { uri: string; range: Range } | { targetUri: string; targetRange: Range };
const locToPath = (l: Loc) => "targetUri" in l
  ? { file_path: fromUri(l.targetUri), line: l.targetRange.start.line, character: l.targetRange.start.character }
  : { file_path: fromUri(l.uri), line: l.range.start.line, character: l.range.start.character };
const asArray = <T,>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

interface DocSymbol { name: string; kind: number; selectionRange?: Range; range?: Range; children?: DocSymbol[];
                      location?: { uri: string; range: Range }; containerName?: string; }
function flatten(symbols: DocSymbol[], container: string | null = null): Array<Record<string, unknown>> {
  return symbols.flatMap(sym => {
    const r = sym.selectionRange ?? sym.range ?? sym.location?.range;
    const row = { name: sym.name, kind: sym.kind, line: r?.start.line ?? 0, character: r?.start.character ?? 0,
                  container: sym.containerName ?? container };
    return [row, ...flatten(sym.children ?? [], sym.name)];
  });
}

function hoverText(h: { contents: unknown } | null): string {
  if (!h) return "";
  const c = h.contents as string | { value: string } | Array<string | { value: string }>;
  const one = (x: string | { value: string }) => (typeof x === "string" ? x : x.value);
  return Array.isArray(c) ? c.map(one).join("\n") : one(c);
}

/**
 * Position request against a file: opens the document first, then sends the request.
 * withClient's "no solution open" check runs before checkFile's "file not found" check (both are
 * synchronous guards inside the callback withClient invokes), so calling a position tool with a
 * missing file before open_solution reports the solution precondition, not the file, matching the
 * spec's error table where "Any tool before open_solution" is the first thing checked.
 */
async function positional<T>(s: Session, method: string,
    a: { file_path: string; line: number; character: number }, extra: Record<string, unknown> = {}) {
  return withClient(s, async c => {
    const file = checkFile(a.file_path);
    const { uri } = await c.openDocument(file);
    return c.request<T>(method, { textDocument: { uri }, position: { line: a.line, character: a.character }, ...extra });
  });
}

export function registerTools(server: McpServer, s: Session): void {
  server.registerTool("open_solution", {
    description: "Open a Clarion solution and start the language server. Call this first. " +
      "With no solution_path, uses the single .sln in the working directory.",
    inputSchema: {
      solution_path: z.string().optional().describe("Absolute path to the .sln"),
      configuration: z.string().optional().describe("Debug (default) or Release"),
      clarion_root: z.string().optional().describe("Clarion install folder; overrides auto-detection"),
    },
  }, async args => { try { return ok(await openSolution(s, args)); } catch (e) { return fail(msg(e)); } });

  server.registerTool("lsp_start", {
    description: "Start the Clarion Language Server for the solution in the working directory. " +
      "Same as open_solution with no arguments.",
  }, async () => { try { return ok(await openSolution(s, {})); } catch (e) { return fail(msg(e)); } });

  server.registerTool("get_solution_info", {
    description: "Get the currently open solution, Clarion version, and redirection file.",
  }, async () => ok(s.solution
    ? { solution: s.solution, clarionVersion: s.clarion!.version,
        redirectionFile: s.params!.redirectionFile, ready: s.ready }
    : { solution: null }));

  server.registerTool("lsp_debug_status", {
    description: "Debug tool: language server process state, notification counts, open documents, " +
      "cached diagnostics, and the last server stderr lines.",
  }, async () => ok({
    running: s.client?.running ?? false, pid: s.client?.pid ?? null, solution: s.solution ?? null,
    ready: s.ready, notifications: s.client?.notificationCount ?? 0,
    openDocuments: s.client?.openDocumentCount ?? 0, diagnosticsCached: s.client?.diagnostics.size ?? 0,
    stderrTail: s.client ? [...s.client.stderrTail] : [],
  }));

  const guard = (fn: () => Promise<unknown>) => async () => {
    try { return ok(await fn()); } catch (e) { return fail(msg(e)); }
  };

  server.registerTool("lsp_definition", {
    description: "Go to definition: where the symbol at a position is defined (cross-file). Zero-based line/character.",
    inputSchema: pos,
  }, async a => guard(async () => asArray(await positional<Loc | Loc[]>(s, "textDocument/definition", a)).map(locToPath))());

  server.registerTool("lsp_references", {
    description: "Find all references to the symbol at a position across the workspace.",
    inputSchema: pos,
  }, async a => guard(async () => asArray(await positional<Loc[]>(s, "textDocument/references", a,
      { context: { includeDeclaration: true } })).map(locToPath))());

  server.registerTool("lsp_hover", {
    description: "Type info, signature, and documentation for the symbol at a position.",
    inputSchema: pos,
  }, async a => guard(async () =>
      ({ contents: hoverText(await positional<{ contents: unknown } | null>(s, "textDocument/hover", a)) }))());

  server.registerTool("lsp_document_symbols", {
    description: "All symbols in a file: procedures, classes, variables. Flattened with a container name.",
    inputSchema: { file_path: z.string() },
  }, async a => guard(async () => withClient(s, async c => {
    const file = checkFile(a.file_path);
    const { uri } = await c.openDocument(file);
    return flatten(asArray(await c.request<DocSymbol[]>("textDocument/documentSymbol", { textDocument: { uri } })));
  }))());

  server.registerTool("lsp_find_symbol", {
    description: "Search symbols across the workspace by name.",
    inputSchema: { query: z.string() },
  }, async a => guard(async () => withClient(s, async c =>
    asArray(await c.request<DocSymbol[]>("workspace/symbol", { query: a.query })).map(sym => ({
      name: sym.name, kind: sym.kind, file_path: fromUri(sym.location!.uri),
      line: sym.location!.range.start.line }))))());

  server.registerTool("lsp_rename", {
    description: "Propose renaming the symbol at a position. Returns the edit list and does NOT apply it.",
    inputSchema: { ...pos, new_name: z.string().min(1) },
  }, async a => guard(async () => {
    type Edit = { range: Range; newText: string };
    type WsEdit = { changes?: Record<string, Edit[]>;
                    documentChanges?: Array<{ textDocument: { uri: string }; edits: Edit[] }> } | null;
    const we = await positional<WsEdit>(s, "textDocument/rename", a, { newName: a.new_name });
    if (!we) return { error: "Symbol at this position cannot be renamed." };
    const rows: Array<Record<string, unknown>> = [];
    const push = (uri: string, edits: Edit[]) => edits.forEach(e => rows.push({
      file_path: fromUri(uri), line: e.range.start.line, character: e.range.start.character,
      endLine: e.range.end.line, endCharacter: e.range.end.character, newText: e.newText }));
    for (const [uri, edits] of Object.entries(we.changes ?? {})) push(uri, edits);
    for (const dc of we.documentChanges ?? []) if ("edits" in dc) push(dc.textDocument.uri, dc.edits);
    return { edits: rows };
  })());
}
