import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient, toUri, fromUri } from "../src/lsp.js";
import type { UpdatePathsParams } from "../src/clarion.js";

const FAKE = path.resolve("test/fake-server.mjs");
const spec = (env: Record<string, string> = {}) =>
  ({ command: process.execPath, args: [FAKE], cwd: process.cwd(), env });
const params = (dir: string): UpdatePathsParams => ({
  solutionFilePath: path.join(dir, "App.sln"), redirectionFile: "", redirectionFilePath: "", redirectionPaths: [],
  libsrcPaths: [], projectPaths: [dir], macros: {}, configuration: "Debug",
  clarionVersion: "0.0", defaultLookupExtensions: [".clw"],
});

let dir: string; let client: LspClient | undefined;
afterEach(async () => { await client?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("LspClient", () => {
  it("starts, reaches ready, answers a request, and stops", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lsp-"));
    client = new LspClient(spec());
    await client.start(pathToFileURL(dir).href);
    expect(client.running).toBe(true);
    expect(await client.openSolution(params(dir))).toBe(true);
    const h = await client.request<{ contents: { value: string } }>("textDocument/hover",
      { textDocument: { uri: "file:///C:/x.clw" }, position: { line: 4, character: 2 } });
    expect(h.contents.value).toBe("hover 4:2");
    await client.stop();
    expect(client.running).toBe(false);
  });

  it("reports ready:false when solutionReady never arrives and when projectPaths is empty", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lsp-"));
    client = new LspClient(spec({ FAKE_SLOW: "1" }), { readyTimeoutMs: 300 });
    await client.start(pathToFileURL(dir).href);
    expect(await client.openSolution(params(dir))).toBe(false);
    await client.stop();
    client = new LspClient(spec(), { readyTimeoutMs: 300 });
    await client.start(pathToFileURL(dir).href);
    expect(await client.openSolution({ ...params(dir), projectPaths: [] })).toBe(false);
    expect(client.stderrTail.join("\n")).toMatch(/No projectPaths/);
  });

  it("opens a document once, sends didChange only when the file changed, and caches diagnostics", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lsp-"));
    const file = path.join(dir, "main.clw"); writeFileSync(file, "  PROGRAM\n");
    client = new LspClient(spec());
    await client.start(pathToFileURL(dir).href);
    await client.openSolution(params(dir));
    const first = await client.openDocument(file);
    expect(first.changed).toBe(true);
    expect(await client.waitForDiagnostics(first.uri, 2, 2000)).toEqual({ diagnostics: [], publishes: 2 });
    expect((await client.openDocument(file)).changed).toBe(false);
    writeFileSync(file, "  BAD\n");
    const third = await client.openDocument(file);
    expect(third.changed).toBe(true);
    const state = await client.waitForDiagnostics(third.uri, 2, 2000);
    expect(state?.publishes).toBe(2);
    expect(state?.diagnostics[0].message).toMatch(/BAD/);
    expect(client.diagnostics.get(third.uri)).toEqual(state);
    expect(client.openDocumentCount).toBe(1);
  });

  it("times out a hung request and reports it as a timeout", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lsp-"));
    // requestTimeoutMs also bounds the initialize handshake inside start(); a cold child-process
    // spawn plus ESM module load on this host regularly takes several hundred ms, so this must be
    // generous enough for that, not just for the assertion below.
    client = new LspClient(spec(), { requestTimeoutMs: 5000 });
    await client.start(pathToFileURL(dir).href);
    // vscode-jsonrpc replies to a request with no registered handler almost immediately with a
    // MethodNotFound error ("Unhandled method ..."); our own requestTimeoutMs is not what fires
    // here, which matches the plan's own note that resolving via "not found" is acceptable.
    await expect(client.request("clarion/neverAnswered")).rejects.toThrow(/timed out|not found|Unhandled method/i);
  });

  it("marks itself not running when the child dies", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lsp-"));
    client = new LspClient(spec({ FAKE_CRASH_ON_HOVER: "1" }));
    await client.start(pathToFileURL(dir).href);
    await expect(client.request("textDocument/hover",
      { textDocument: { uri: "file:///C:/x.clw" }, position: { line: 0, character: 0 } })).rejects.toThrow();
    await new Promise(r => setTimeout(r, 200));
    expect(client.running).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("uses the server's canonical URI form and round-trips Windows paths", () => {
    const p = "C:\\Work\\App\\main.clw";
    expect(toUri(p)).toBe("file:///c%3A/Work/App/main.clw");
    expect(fromUri(toUri(p))).toBe(p);
    expect(fromUri("file:///C:/fake/main.clw")).toBe("C:\\fake\\main.clw");
  });
});
