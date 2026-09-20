import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findClarionRoot, findSolution, buildPaths,
         type ClarionRoot, type UpdatePathsParams } from "./clarion.js";
import { LspClient, toUri, fromUri, isComplete, DIAGNOSTICS_TIMEOUT_MS,
         type SpawnSpec, type ClientOptions, type Range, type Diagnostic } from "./lsp.js";

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
  sweep?: Sweep;
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
export const fail = (message: string): ToolResult => {
  const [error, tail] = message.split("\nstderrTail:\n");
  const body = tail === undefined ? { error } : { error, stderrTail: tail.split("\n") };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const guard = (fn: () => Promise<unknown>) => async () => {
  try { return ok(await fn()); } catch (e) { return fail(msg(e)); }
};

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
    redirectionFile: params.redirectionFilePath, ready: s.ready,
    ...(s.ready ? {} : { stderrTail: [...s.client!.stderrTail] }),
  };
}

export async function withClient<T>(s: Session, fn: (c: LspClient) => Promise<T>): Promise<T> {
  if (!s.solution || !s.params || !s.client) throw new Error("No solution open. Call open_solution first.");
  if (!s.client.running) await startClient(s);
  try {
    return await fn(s.client);
  } catch (e) {
    if (s.client.running) throw e;                 // a real answer from a live server
    await startClient(s);                          // full handshake + updatePaths
    try {
      return await fn(s.client);
    } catch (e2) {
      const tail = s.client.stderrTail.join("\n");
      throw new Error(`Language server failed again after restart: ${msg(e2)}\nstderrTail:\n${tail}`);
    }
  }
}

function checkFile(s: Session, file_path: string): string {
  // Relative paths resolve against the solution folder, not the MCP process cwd.
  const p = path.resolve(path.dirname(s.solution!), file_path);
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

type Diag = { severity: number; line: number; character: number; message: string };
const toDiag = (d: Diagnostic): Diag => ({ severity: d.severity ?? 1, line: d.range.start.line,
  character: d.range.start.character, message: d.message });

/** Validates the path exists, then opens it on the (already-live) client. */
function openChecked(s: Session, c: LspClient, file_path: string) {
  return c.openDocument(checkFile(s, file_path));
}

/** The server skips its async validators for files under a libsrc path, so they get one publish. */
function isLibsrcFile(s: Session, file: string): boolean {
  const f = file.toLowerCase();
  return (s.params?.libsrcPaths ?? []).some(dir => {
    const d = dir.toLowerCase().replace(/[\\/]+$/, "");
    return f.startsWith(d + "\\") || f.startsWith(d + "/");
  });
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
    const { uri } = await openChecked(s, c, a.file_path);
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
  }, async args => guard(() => openSolution(s, args))());

  server.registerTool("lsp_start", {
    description: "Start the Clarion Language Server for the solution in the working directory. " +
      "Same as open_solution with no arguments.",
  }, async () => guard(() => openSolution(s, {}))());

  server.registerTool("get_solution_info", {
    description: "Get the currently open solution, Clarion version, and redirection file.",
  }, async () => ok(s.solution
    ? { solution: s.solution, clarionVersion: s.clarion!.version,
        redirectionFile: s.params!.redirectionFilePath, ready: s.ready }
    : { solution: null }));

  server.registerTool("lsp_debug_status", {
    description: "Debug tool: language server process state, notification counts, open documents, " +
      "cached diagnostics, and the last server stderr lines.",
  }, async () => ok({
    running: s.client?.running ?? false, pid: s.client?.pid ?? null, solution: s.solution ?? null,
    ready: s.ready, indexing: s.client?.indexing ?? false, notifications: s.client?.notificationCount ?? 0,
    openDocuments: s.client?.openDocumentCount ?? 0, diagnosticsCached: s.client?.diagnostics.size ?? 0,
    stderrTail: s.client ? [...s.client.stderrTail] : [],
  }));

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
    const { uri } = await openChecked(s, c, a.file_path);
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

  server.registerTool("lsp_diagnostics", {
    description: "Current errors and warnings for a file. pending:true means the server has not answered " +
      "within 20 seconds; treat that as unknown, not clean. complete:false means only the server's fast " +
      "structural pass has arrived, or the server is still building its background index (indexing:true) " +
      "so semantic warnings may be missing or spurious; call again later for the final list.",
    inputSchema: { file_path: z.string() },
  }, async a => guard(async () => withClient(s, async c => {
    const file = checkFile(s, a.file_path);
    const { uri } = await c.openDocument(file);
    // The server publishes a structural pass first and the combined list once its async
    // validators finish; library files get the structural pass only. Reporting the first
    // publish as final made a freshly opened or edited file look clean.
    const expected = isLibsrcFile(s, file) ? 1 : 2;
    const state = await c.waitForDiagnostics(uri, expected);
    // While the background index builds, the server defers its semantic validators or runs them
    // without cross-file data, and republishes once it is done; the answer is provisional.
    const indexing = c.indexing;
    if (state === undefined) return { pending: true, complete: false, indexing, count: 0, diagnostics: [] };
    const diagnostics = state.diagnostics.map(toDiag);
    return { pending: false, complete: isComplete(state, expected, c.statusCapable) && !indexing, indexing, count: diagnostics.length, diagnostics };
  }))());

  server.registerTool("get_project_source_files", {
    description: "All .clw and .inc files in the open solution, absolute paths grouped by project.",
  }, async () => guard(async () => withClient(s, listSourceFiles))());

  server.registerTool("lsp_solution_diagnostics", {
    description: "Errors and warnings for every .clw and .inc file in the open solution, collected inside the " +
      "MCP process (no per-file calls to copy). The first call starts a background sweep and returns at once " +
      "with status:\"running\"; call again every 30 seconds or so until status:\"done\". files lists only " +
      "the files with diagnostics; unknown lists files that gave no complete answer within 60 seconds (treat " +
      "as unknown, not clean). The finished report is kept until a call with restart:true.",
    inputSchema: { restart: z.boolean().optional() },
  }, async a => guard(async () => {
    if (a.restart && s.sweep?.status === "done") s.sweep = undefined;
    if (!s.sweep) {
      // The file list is quick and gives the first answer its total; the sweep itself runs on.
      const { client, projects } = await withClient(s, async c => ({ client: c, projects: await listSourceFiles(c) }));
      // A file shared by several projects is validated once.
      const files = [...new Map(projects.flatMap(p => p.files).map(f => [f.toLowerCase(), f])).values()];
      const sweep: Sweep = { status: "running", startedAt: new Date().toISOString(), total: files.length, done: 0,
        errors: 0, warnings: 0, info: 0, unknown: [], unresolved: projects.flatMap(p => p.unresolved), files: [] };
      s.sweep = sweep;
      void runSweep(s, client, files, sweep);
    }
    return s.sweep;
  })());
}

type ProjectFiles = { project: string; files: string[]; unresolved: string[] };
async function listSourceFiles(c: LspClient): Promise<ProjectFiles[]> {
  type Project = { name: string; path: string; guid: string };
  type ProjFile = { name: string; relativePath: string };
  const tree = await c.request<{ projects: Project[] }>("clarion/getSolutionTree");
  const out: ProjectFiles[] = [];
  for (const p of tree.projects) {
    const { files } = await c.request<{ files: ProjFile[] }>("clarion/getProjectFiles", { projectGuid: p.guid });
    const resolved: string[] = [], unresolved: string[] = [];
    for (const f of files) {
      if (!/\.(clw|inc)$/i.test(f.name)) continue;
      const direct = path.join(p.path, f.relativePath);
      if (existsSync(direct)) { resolved.push(direct); continue; }
      const hit = await c.request<{ path?: string } | null>("clarion/findFile", { filename: f.name });
      if (hit?.path && existsSync(hit.path)) resolved.push(hit.path); else unresolved.push(f.name);
    }
    out.push({ project: p.name, files: resolved, unresolved });
  }
  return out;
}

interface Sweep {
  status: "running" | "done"; startedAt: string; finishedAt?: string; error?: string;
  total: number; done: number; errors: number; warnings: number; info: number;
  unknown: string[]; unresolved: string[];
  files: Array<{ file_path: string; count: number; diagnostics: Diag[] }>;
}
// ponytail: fixed concurrency; the server is single-threaded, so more in flight only expires waits.
const SWEEP_CONCURRENCY = 4;

/** Runs in the background; the tool returns the same object while it fills in. */
async function runSweep(s: Session, c: LspClient, files: string[], sweep: Sweep): Promise<void> {
  try {
    // Answers given while the background graph builds are provisional; wait for it (bounded).
    for (let i = 0; c.indexing && c.running && i < 180; i++) await new Promise(r => setTimeout(r, 1000));
    const waitMs = (s.opts.clientOpts.diagnosticsTimeoutMs ?? DIAGNOSTICS_TIMEOUT_MS) * 3;
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++];
        if (c.running) await sweepFile(s, c, file, waitMs, sweep); else sweep.unknown.push(file);
        sweep.done++;
      }
    };
    await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));
    if (!c.running) sweep.error = "Language server stopped during the sweep; the next tool call restarts it.";
  } catch (e) {
    sweep.error = msg(e);
  }
  sweep.status = "done";
  sweep.finishedAt = new Date().toISOString();
}

async function sweepFile(s: Session, c: LspClient, file: string, waitMs: number, sweep: Sweep): Promise<void> {
  try {
    const { uri } = await c.openDocument(file);
    const expected = isLibsrcFile(s, file) ? 1 : 2;
    const state = await c.waitForDiagnostics(uri, expected, waitMs);
    const complete = state !== undefined && isComplete(state, expected, c.statusCapable) && !c.indexing;
    await c.closeDocument(uri);
    if (!complete) { sweep.unknown.push(file); return; }
    const diagnostics = state.diagnostics.map(toDiag);
    for (const d of diagnostics) {
      if (d.severity === 1) sweep.errors++; else if (d.severity === 2) sweep.warnings++; else sweep.info++;
    }
    if (diagnostics.length) sweep.files.push({ file_path: file, count: diagnostics.length, diagnostics });
  } catch {
    sweep.unknown.push(file);     // server gone or file unreadable: unknown, never clean
  }
}
