import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findClarionRoot } from "../src/clarion.js";
import { connect } from "./harness.js";

let clarion: ReturnType<typeof findClarionRoot> | undefined;
try { clarion = findClarionRoot(); } catch { clarion = undefined; }

describe.skipIf(!clarion)("real Clarion language server", () => {
  let dir: string; let h: Awaited<ReturnType<typeof connect>>; let main: string;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hello-"));
    cpSync(path.resolve("test/fixtures/HelloLsp"), dir, { recursive: true });
    // main.clw lives in _Source, reached only through HelloLsp.red ([Common] *.clw = .\_Source),
    // so this exercises the redirection path the way real solutions do.
    main = path.join(dir, "_Source", "main.clw");
    h = await connect({}, {
      findRoot: () => clarion!,
      spawnSpec: c => ({ command: c.nodeExe, args: [c.serverMain, "--stdio"], cwd: c.serverDir }),
      clientOpts: {},
    });
    const r = await h.call("open_solution", { solution_path: path.join(dir, "HelloLsp.sln") });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.ready, JSON.stringify(r.data.stderrTail)).toBe(true);
  });
  afterAll(async () => { await h?.close(); rmSync(dir, { recursive: true, force: true }); });

  it("lists the fixture's source file", async () => {
    const r = (await h.call("get_project_source_files")).data;
    expect(r[0].files.map((f: string) => f.toLowerCase())).toContain(main.toLowerCase());
  });

  it("returns document symbols including Greet", async () => {
    const r = (await h.call("lsp_document_symbols", { file_path: main })).data;
    expect(r.map((s: { name: string }) => s.name.toLowerCase())).toContain("greet");
  });

  it("resolves a definition across the MAP", async () => {
    const r = (await h.call("lsp_definition", { file_path: main, line: 10, character: 11 })).data;
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].file_path.toLowerCase()).toBe(main.toLowerCase());
  });

  // The plan's original version of this test edited in an INCLUDE of a nonexistent file and
  // expected a diagnostic. Against the real server that never fires: see the implementation
  // notes (Task 9) for why, with the server's own source as evidence. An unterminated structure
  // is a real, sync-validator diagnostic that always fires regardless of the server's async
  // indexing state, so it is what this test asserts instead.
  it("reports an error for an unterminated structure after an edit", async () => {
    const clean = (await h.call("lsp_diagnostics", { file_path: main })).data;
    expect(clean.pending).toBe(false);
    writeFileSync(main, readFileSync(main, "utf8")
      .replace("  MESSAGE(Greet('World'))", "  CASE Counter\n  OF 1\n    MESSAGE(Greet('World'))"));
    let r = (await h.call("lsp_diagnostics", { file_path: main })).data;
    if (r.pending) r = (await h.call("lsp_diagnostics", { file_path: main })).data;   // one retry, as the skill does
    expect(r.count).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/CASE statement is not terminated/);
  });

  it("survives a kill", async () => {
    process.kill((await h.call("lsp_debug_status")).data.pid);
    await new Promise(r => setTimeout(r, 500));
    const r = await h.call("lsp_hover", { file_path: main, line: 6, character: 0 });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
  });
});
