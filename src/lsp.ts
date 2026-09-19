import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter,
         type MessageConnection } from "vscode-jsonrpc/node";
import type { UpdatePathsParams } from "./clarion.js";

export const REQUEST_TIMEOUT_MS = 15_000;
export const SLOW_REQUEST_TIMEOUT_MS = 300_000;   // cold solution-wide scan measured at 60 s idle, >120 s on a busy laptop (866 files)
const SLOW_METHODS = new Set(["textDocument/references", "workspace/symbol"]);
// The server publishes twice per validation of a source file: the structural pass, then the
// combined list once its async validators finish. Measured 1.4-5.4 s apart on an idle laptop and
// up to 10 s after a change while the server is still indexing a freshly opened solution.
export const DIAGNOSTICS_TIMEOUT_MS = 20_000;
export const READY_TIMEOUT_MS = 30_000;

export interface SpawnSpec { command: string; args: string[]; cwd: string; env?: Record<string, string>; }
export interface ClientOptions { readyTimeoutMs?: number; requestTimeoutMs?: number; diagnosticsTimeoutMs?: number; }
export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }
/** Publishes received for the document version last sent; `publishes` counts them (the server
 *  sends two for a source file, one for a library file). */
/** `status` is the server's `clarion/diagnosticsStatus` for the version last sent (Clarion-Extension
 *  1.0.4+); older servers never send it and completeness falls back to counting publishes. */
/** `statusCapable`: the server has sent a status at least once, so the count is not consulted: a
 *  cross-file update while a batch of documents opens validates a document twice for one version,
 *  and its two structural publishes would satisfy the count before any combined list arrives. */
export const isComplete = (d: DiagnosticState, publishes: number, statusCapable = false): boolean =>
  d.status === "complete" || (!statusCapable && d.publishes >= publishes);
export interface DiagnosticState { diagnostics: Diagnostic[]; publishes: number; status?: DiagnosticsStatus; }
export type DiagnosticsStatus = "complete" | "deferred" | "superseded";
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
  private waiters = new Map<string, Array<(d: DiagnosticState) => void>>();
  private readyResolve?: (p: { solutionFilePath?: string } | undefined) => void;
  /** Latest accepted publish per uri (a publish for a version other than the one last sent is ignored). */
  readonly diagnostics = new Map<string, DiagnosticState>();
  readonly stderrTail: string[] = [];
  notificationCount = 0;
  /** The server sends `clarion/diagnosticsStatus` (Clarion-Extension 1.0.4+, or the v1.0.2 snapshot
   *  with the diagnostics-version patch); completeness then comes from it alone. Neither server
   *  advertises it in `initialize`, so `start` looks for the method name in the server's main file
   *  (it must be known before the first publish: the first batch of documents opened on a fresh
   *  server can produce the double structural publish before any status has been seen). */
  statusCapable = false;
  /** True from open_solution until the server reports its background file graph built
   *  (`clarion/graphStatus` status `built`). Until then the server defers or runs its semantic
   *  validators without cross-file data, so diagnostics can be structural-only or carry spurious
   *  "not declared" warnings; documents open at that point are resent so the server validates
   *  them again with the graph (see onGraphStatus). */
  indexing = false;

  constructor(private spec: SpawnSpec, private opts: ClientOptions = {}) {}

  get running() { return this._running; }
  get pid() { return this.child?.pid; }
  get openDocumentCount() { return this.openDocs.size; }

  async start(rootUri: string): Promise<void> {
    this.statusCapable = this.spec.args.some(a => existsSync(a) && readFileSync(a, "utf8").includes("clarion/diagnosticsStatus"));
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
    const dead = () => { this._running = false; this.openDocs.clear(); };
    child.on("exit", () => { dead(); this.conn?.dispose(); });
    const conn = createMessageConnection(
      new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
    // The pipes close before the child's exit event arrives; a request in that gap must see a dead
    // server (and be retried on a restarted one) rather than "Connection is closed" as an answer.
    conn.onClose(dead);
    conn.onNotification((method: string, params: unknown) => {
      this.notificationCount++;
      if (method === "textDocument/publishDiagnostics") this.onDiagnostics(params as { uri: string; version?: number; diagnostics: Diagnostic[] });
      if (method === "clarion/diagnosticsStatus") this.onDiagnosticsStatus(params as { uri: string; version: number; state: DiagnosticsStatus });
      if (method === "clarion/solutionReady") this.readyResolve?.(params as { solutionFilePath?: string });
      if (method === "clarion/graphStatus") this.onGraphStatus((params as { status?: string }).status);
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
    this.indexing = true;                    // cleared by clarion/graphStatus "built"
    await this.notify("clarion/updatePaths", params);
    return Promise.race([ready, sleep(this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS).then(() => false)]);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.conn || !this._running) return Promise.reject(new Error("Language server is not running"));
    // Solution-wide scans on large solutions can run well past 15 s while the server's
    // indexes are still warm-up cold; give them a longer budget than point lookups.
    // "initialize" is answered by a process that is still loading its module graph; on a busy
    // laptop that exceeded 15 s, so the handshake gets the same budget as solution readiness.
    const ms = this.opts.requestTimeoutMs ??
      (method === "initialize" ? READY_TIMEOUT_MS : SLOW_METHODS.has(method) ? SLOW_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    // Clear the timer once the request settles: a live timer keeps the process alive for the
    // whole budget (minutes for slow methods) after the answer has already arrived.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out after ${ms} ms`)), ms);
    });
    // sendRequest throws synchronously on a closed connection; as a rejection the timer is still cleared.
    const sent = Promise.resolve().then(() => this.conn!.sendRequest(method, params) as Promise<T>);
    return Promise.race([sent, timeout]).finally(() => clearTimeout(timer));
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
      this.diagnostics.delete(uri);          // publishes for a previous open are stale from here on
      this.versions.set(uri, 1);
      await this.notify("textDocument/didOpen",
        { textDocument: { uri, languageId: "clarion", version: 1, text } });
    } else {
      await this.sendChange(uri, text);
    }
    this.openDocs.set(uri, text);
    return { uri, changed: true };
  }

  /** Sends the text at a new version; publishes for the previous version are stale from here on. */
  private sendChange(uri: string, text: string): Promise<void> {
    this.diagnostics.delete(uri);
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    return this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  /** Once the graph is built the server revalidates the documents it had open, but it skips any it
   *  already validated after its index came up and before the graph existed, and its revalidation
   *  publishes the structural pass first, which the publish count would mistake for a fresh complete
   *  cycle. Resending every open document at a new version makes the server validate all of them
   *  with the graph, and the version check drops the publishes of the provisional passes. */
  private onGraphStatus(status?: string) {
    this.indexing = status !== "built";
    if (this.indexing) return;
    for (const [uri, text] of this.openDocs)
      void this.sendChange(uri, text).catch(() => { /* server gone; the restart re-opens documents */ });
  }

  /** Resolve once the server reports the version last sent complete, or once `publishes` publishes
   *  have arrived for it (servers without `clarion/diagnosticsStatus`), or at the deadline with
   *  whatever has arrived (undefined when nothing has). */
  waitForDiagnostics(uri: string, publishes = 1, ms = this.opts.diagnosticsTimeoutMs ?? DIAGNOSTICS_TIMEOUT_MS)
      : Promise<DiagnosticState | undefined> {
    const now = this.diagnostics.get(uri);
    if (now && isComplete(now, publishes, this.statusCapable)) return Promise.resolve(now);
    return new Promise(resolve => {
      const remove = () => this.waiters.set(uri, (this.waiters.get(uri) ?? []).filter(w => w !== fn));
      const timer = setTimeout(() => { remove(); resolve(this.diagnostics.get(uri)); }, ms);
      const fn = (d: DiagnosticState) => { if (!isComplete(d, publishes, this.statusCapable)) return; clearTimeout(timer); remove(); resolve(d); };
      this.waiters.set(uri, [...(this.waiters.get(uri) ?? []), fn]);
    });
  }

  private onDiagnosticsStatus(p: { uri: string; version: number; state: DiagnosticsStatus }) {
    this.statusCapable = true;
    if (p.version !== this.versions.get(p.uri)) return;   // a status for a superseded version
    const state = { ...(this.diagnostics.get(p.uri) ?? { diagnostics: [], publishes: 0 }), status: p.state };
    this.diagnostics.set(p.uri, state);
    for (const fn of [...(this.waiters.get(p.uri) ?? [])]) fn(state);
  }

  private onDiagnostics(p: { uri: string; version?: number; diagnostics: Diagnostic[] }) {
    // A versioned publish for anything but the version we last sent is stale (the server
    // finishes validating the previous text after we have already sent the next one).
    const sent = this.versions.get(p.uri);
    if (p.version !== undefined && sent !== undefined && p.version !== sent) return;
    const state = { diagnostics: p.diagnostics, publishes: (this.diagnostics.get(p.uri)?.publishes ?? 0) + 1 };
    this.diagnostics.set(p.uri, state);
    for (const fn of [...(this.waiters.get(p.uri) ?? [])]) fn(state);
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
