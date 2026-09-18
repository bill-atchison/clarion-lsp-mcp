import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter,
         type MessageConnection } from "vscode-jsonrpc/node";
import type { UpdatePathsParams } from "./clarion.js";

export const REQUEST_TIMEOUT_MS = 15_000;
export const SLOW_REQUEST_TIMEOUT_MS = 300_000;   // cold solution-wide scan measured at 60 s idle, >120 s on a busy laptop (866 files)
const SLOW_METHODS = new Set(["textDocument/references", "workspace/symbol"]);
export const DIAGNOSTICS_TIMEOUT_MS = 3_000;
// The server publishes twice per validation: the fast structural list about 1 s after a
// change, then the combined list once its async validators finish (measured 1.4-5.4 s later).
export const DIAGNOSTICS_SETTLE_MS = 8_000;
export const READY_TIMEOUT_MS = 30_000;

export interface SpawnSpec { command: string; args: string[]; cwd: string; env?: Record<string, string>; }
export interface ClientOptions {
  readyTimeoutMs?: number; requestTimeoutMs?: number; diagnosticsTimeoutMs?: number; diagnosticsSettleMs?: number;
}
export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }
export interface Diagnostic { severity?: number; range: Range; message: string; }

/** The server's canonical form is VS Code's: lower-case drive, encoded colon (file:///c%3A/...). */
export const toUri = (p: string) =>
  pathToFileURL(p).href.replace(/^file:\/\/\/([A-Za-z]):/, (_, d: string) => `file:///${d.toLowerCase()}%3A`);
export const fromUri = (u: string) => {
  const p = fileURLToPath(u.replace(/^file:\/\/\/([A-Za-z])%3A/i, "file:///$1:"));
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
};
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class LspClient {
  private child?: ChildProcess;
  private conn?: MessageConnection;
  private _running = false;
  private openDocs = new Map<string, string>();      // uri -> last text sent
  private versions = new Map<string, number>();
  private waiters = new Map<string, Array<(d: Diagnostic[]) => void>>();
  private readyResolve?: (p: { solutionFilePath?: string } | undefined) => void;
  readonly diagnostics = new Map<string, Diagnostic[]>();
  readonly stderrTail: string[] = [];
  notificationCount = 0;

  constructor(private spec: SpawnSpec, private opts: ClientOptions = {}) {}

  get running() { return this._running; }
  get pid() { return this.child?.pid; }
  get openDocumentCount() { return this.openDocs.size; }

  async start(rootUri: string): Promise<void> {
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd, env: { ...process.env, ...this.spec.env },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.child = child;
    child.stderr!.on("data", (b: Buffer) => {
      for (const line of b.toString().split(/\r?\n/)) {
        if (!line) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      }
    });
    child.on("exit", () => { this._running = false; this.openDocs.clear(); this.conn?.dispose(); });
    const conn = createMessageConnection(
      new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
    conn.onNotification((method: string, params: unknown) => {
      this.notificationCount++;
      if (method === "textDocument/publishDiagnostics") this.onDiagnostics(params as { uri: string; diagnostics: Diagnostic[] });
      if (method === "clarion/solutionReady") this.readyResolve?.(params as { solutionFilePath?: string });
    });
    conn.onRequest(() => null);            // server-to-client requests we do not implement
    conn.onError(e => this.stderrTail.push(`jsonrpc error: ${String(e[0])}`));
    conn.listen();
    this.conn = conn;
    this._running = true;
    await this.request("initialize", { processId: process.pid, rootUri, capabilities: {}, initializationOptions: {} });
    await this.notify("initialized", {});
  }

  async openSolution(params: UpdatePathsParams): Promise<boolean> {
    // solutionReady is a notification, not a reply: match it to this call by solution path so a
    // stale notification from an earlier open_solution cannot resolve this one.
    const want = params.solutionFilePath.toLowerCase();
    const ready = new Promise<boolean>(r => {
      this.readyResolve = p => { if ((p?.solutionFilePath ?? "").toLowerCase() === want) r(true); };
    });
    await this.notify("clarion/updatePaths", params);
    return Promise.race([ready, sleep(this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS).then(() => false)]);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.conn || !this._running) return Promise.reject(new Error("Language server is not running"));
    // Solution-wide scans on large solutions can run well past 15 s while the server's
    // indexes are still warm-up cold; give them a longer budget than point lookups.
    const ms = this.opts.requestTimeoutMs ?? (SLOW_METHODS.has(method) ? SLOW_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    // Clear the timer once the request settles: a live timer keeps the process alive for the
    // whole budget (minutes for slow methods) after the answer has already arrived.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out after ${ms} ms`)), ms);
    });
    return Promise.race([this.conn.sendRequest(method, params) as Promise<T>, timeout])
      .finally(() => clearTimeout(timer));
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (!this.conn || !this._running) return Promise.reject(new Error("Language server is not running"));
    return this.conn.sendNotification(method, params);
  }

  async openDocument(filePath: string): Promise<{ uri: string; changed: boolean }> {
    const uri = toUri(filePath);
    const text = readFileSync(filePath, "utf8");
    const last = this.openDocs.get(uri);
    if (last === text) return { uri, changed: false };
    if (last === undefined) {
      this.versions.set(uri, 1);
      await this.notify("textDocument/didOpen",
        { textDocument: { uri, languageId: "clarion", version: 1, text } });
    } else {
      const version = (this.versions.get(uri) ?? 1) + 1;
      this.versions.set(uri, version);
      await this.notify("textDocument/didChange",
        { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    this.openDocs.set(uri, text);
    return { uri, changed: true };
  }

  waitForDiagnostics(uri: string, ms = this.opts.diagnosticsTimeoutMs ?? DIAGNOSTICS_TIMEOUT_MS)
      : Promise<Diagnostic[] | undefined> {
    return new Promise(resolve => {
      const remove = () => this.waiters.set(uri, (this.waiters.get(uri) ?? []).filter(w => w !== fn));
      const timer = setTimeout(() => { remove(); resolve(undefined); }, ms);
      const fn = (d: Diagnostic[]) => { clearTimeout(timer); remove(); resolve(d); };
      this.waiters.set(uri, [...(this.waiters.get(uri) ?? []), fn]);
    });
  }

  private onDiagnostics(p: { uri: string; diagnostics: Diagnostic[] }) {
    this.diagnostics.set(p.uri, p.diagnostics);
    const list = this.waiters.get(p.uri) ?? [];
    this.waiters.delete(p.uri);
    for (const fn of list) fn(p.diagnostics);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try { if (this._running) { await this.request("shutdown"); await this.notify("exit"); } } catch { /* dying anyway */ }
    await Promise.race([new Promise<void>(r => child.once("exit", () => r())), sleep(2000)]);
    if (child.exitCode === null) child.kill();
    this._running = false; this.child = undefined; this.conn = undefined;
  }
}
