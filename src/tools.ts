import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findClarionRoot, findSolution, buildPaths,
         type ClarionRoot, type UpdatePathsParams } from "./clarion.js";
import { LspClient, type SpawnSpec, type ClientOptions } from "./lsp.js";

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
}
