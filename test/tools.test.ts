import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "./harness.js";

let dir: string; let h: Awaited<ReturnType<typeof connect>> | undefined;
function solution() {
  dir = mkdtempSync(path.join(tmpdir(), "sln-"));
  const sln = path.join(dir, "App.sln"); writeFileSync(sln, "");
  return sln;
}
afterEach(async () => { await h?.close(); h = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("session tools", () => {
  it("refuses every LSP tool before open_solution", async () => {
    h = await connect();
    const r = await h.call("get_solution_info");
    expect(r.data).toEqual({ solution: null });
    const d = await h.call("lsp_debug_status");
    expect(d.data.running).toBe(false);
  });

  it("opens a solution and reports it", async () => {
    h = await connect();
    const sln = solution();
    const r = await h.call("open_solution", { solution_path: sln });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ solution: sln, clarionRoot: "C:\\FakeClarion",
      clarionVersion: "12.0.0", ready: true });
    expect(r.data.stderrTail).toBeUndefined();
    const info = await h.call("get_solution_info");
    expect(info.data).toMatchObject({ solution: sln, ready: true });
    const d = await h.call("lsp_debug_status");
    expect(d.data.running).toBe(true);
    expect(typeof d.data.pid).toBe("number");
  });

  it("lsp_start opens the single .sln in cwd", async () => {
    const sln = solution();
    h = await connect({}, { cwd: dir });
    const r = await h.call("lsp_start");
    expect(r.data.solution).toBe(sln);
  });

  it("returns stderrTail when the server never becomes ready", async () => {
    h = await connect({ FAKE_SLOW: "1" });
    const r = await h.call("open_solution", { solution_path: solution() });
    expect(r.isError).toBe(false);
    expect(r.data.ready).toBe(false);
    expect(Array.isArray(r.data.stderrTail)).toBe(true);
  });

  it("returns isError results for bad input instead of throwing", async () => {
    h = await connect();
    const r = await h.call("open_solution", { solution_path: "C:\\nope\\Missing.sln" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/not found/);
  });
});

describe("position tools", () => {
  async function opened() {
    h = await connect();
    const sln = solution();
    const file = path.join(dir, "main.clw"); writeFileSync(file, "  PROGRAM\n  CODE\n");
    await h.call("open_solution", { solution_path: sln });
    return file;
  }
  const at = (file_path: string) => ({ file_path, line: 1, character: 2 });

  it("refuses when no solution is open", async () => {
    h = await connect();
    const r = await h.call("lsp_hover", { file_path: "C:\\x.clw", line: 0, character: 0 });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/open_solution/);
  });

  it("refuses a file that does not exist without touching the server", async () => {
    await opened();
    const before = (await h!.call("lsp_debug_status")).data.openDocuments;
    const r = await h!.call("lsp_hover", { file_path: path.join(dir, "missing.clw"), line: 0, character: 0 });
    expect(r.isError).toBe(true);
    expect((await h!.call("lsp_debug_status")).data.openDocuments).toBe(before);
  });

  it("resolves a relative file_path against the solution folder, not the process cwd", async () => {
    const file = await opened();
    const r = await h!.call("lsp_hover", { file_path: path.basename(file), line: 1, character: 2 });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ contents: "hover 1:2" });
  });

  it("maps definition, references and hover to paths", async () => {
    const file = await opened();
    expect((await h!.call("lsp_definition", at(file))).data)
      .toEqual([{ file_path: file, line: 3, character: 2 }]);
    expect((await h!.call("lsp_references", at(file))).data)
      .toEqual([{ file_path: file, line: 3, character: 2 }, { file_path: file, line: 7, character: 4 }]);
    expect((await h!.call("lsp_hover", at(file))).data).toEqual({ contents: "hover 1:2" });
  });

  it("flattens document symbols and finds workspace symbols", async () => {
    const file = await opened();
    expect((await h!.call("lsp_document_symbols", { file_path: file })).data).toEqual([
      { name: "Main", kind: 12, line: 1, character: 0, container: null },
      { name: "Counter", kind: 13, line: 2, character: 2, container: "Main" },
    ]);
    expect((await h!.call("lsp_find_symbol", { query: "Greet" })).data)
      .toEqual([{ name: "Greet", kind: 12, file_path: "C:\\fake\\main.clw", line: 1 }]);
  });

  it("returns rename edits without applying them, and an error when impossible", async () => {
    const file = await opened();
    const before = readFileSync(file, "utf8");
    const r = await h!.call("lsp_rename", { ...at(file), new_name: "Greeting" });
    expect(r.data).toEqual({ edits: [
      { file_path: file, line: 3, character: 2, endLine: 3, endCharacter: 6, newText: "Greeting" } ] });
    expect(readFileSync(file, "utf8")).toBe(before);
    const bad = await h!.call("lsp_rename", { ...at(file), new_name: "!" });
    expect(bad.data.error).toMatch(/cannot be renamed/);
  });
});

describe("diagnostics and project files", () => {
  it("returns cached diagnostics for an unchanged file and fresh ones after an edit", async () => {
    h = await connect();
    const sln = solution();
    const file = path.join(dir, "main.clw"); writeFileSync(file, "  PROGRAM\n");
    await h.call("open_solution", { solution_path: sln });
    expect((await h.call("lsp_diagnostics", { file_path: file })).data)
      .toEqual({ pending: false, complete: true, count: 0, diagnostics: [] });
    expect((await h.call("lsp_diagnostics", { file_path: file })).data.pending).toBe(false);
    writeFileSync(file, "  BAD\n");
    const r = (await h.call("lsp_diagnostics", { file_path: file })).data;
    expect(r).toEqual({ pending: false, complete: true, count: 1,
      diagnostics: [{ severity: 1, line: 0, character: 0, message: "Unknown identifier BAD" }] });
  });

  it("reports complete:false when only the structural publish has arrived", async () => {
    h = await connect({ FAKE_ONE_PHASE: "1" });   // a source file whose second publish never comes
    const sln = solution();
    const file = path.join(dir, "main.clw"); writeFileSync(file, "  BAD\n");
    await h.call("open_solution", { solution_path: sln });
    const r = (await h.call("lsp_diagnostics", { file_path: file })).data;
    expect(r).toEqual({ pending: false, complete: false, count: 1,
      diagnostics: [{ severity: 1, line: 0, character: 0, message: "Unknown identifier BAD" }] });
  });

  it("trusts clarion/diagnosticsStatus complete over the publish count", async () => {
    h = await connect({ FAKE_ONE_PHASE: "1", FAKE_STATUS: "1" });   // one publish, then status complete
    const sln = solution();
    const file = path.join(dir, "main.clw"); writeFileSync(file, "  BAD\n");
    await h.call("open_solution", { solution_path: sln });
    const r = (await h.call("lsp_diagnostics", { file_path: file })).data;
    expect(r).toEqual({ pending: false, complete: true, count: 1,
      diagnostics: [{ severity: 1, line: 0, character: 0, message: "Unknown identifier BAD" }] });
  });

  it("reports pending:true when no diagnostics arrive in time", async () => {
    h = await connect({ FAKE_NO_DIAGNOSTICS: "1" });   // harness sets diagnosticsTimeoutMs to 1000
    const sln = solution();
    const file = path.join(dir, "main.clw"); writeFileSync(file, "  PROGRAM\n");
    await h.call("open_solution", { solution_path: sln });
    const r = (await h.call("lsp_diagnostics", { file_path: file })).data;
    expect(r).toEqual({ pending: true, complete: false, count: 0, diagnostics: [] });
  });

  it("lists absolute .clw/.inc paths per project, resolves redirected files, and reports unresolved ones", async () => {
    const sln = solution();
    writeFileSync(path.join(dir, "main.clw"), "");
    const redirDir = mkdtempSync(path.join(tmpdir(), "redir-"));
    const redir = path.join(redirDir, "redir.inc"); writeFileSync(redir, "");
    h = await connect({ FAKE_PROJECT_DIR: dir, FAKE_REDIR_PATH: redir });
    await h.call("open_solution", { solution_path: sln });
    const r = (await h.call("get_project_source_files")).data;
    expect(r).toEqual([{ project: "Fake", files: [path.join(dir, "main.clw"), redir], unresolved: ["ghost.inc"] }]);
    rmSync(redirDir, { recursive: true, force: true });
  });
});

describe("crash recovery", () => {
  it("restarts the server after a crash and retries once, surfacing stderr on a second failure", async () => {
    h = await connect();
    const sln = solution();
    const file = path.join(dir, "main.clw"); writeFileSync(file, "  PROGRAM\n");
    await h.call("open_solution", { solution_path: sln });
    const pid1 = (await h.call("lsp_debug_status")).data.pid;
    process.kill(pid1);                                     // simulate a crash
    await new Promise(r => setTimeout(r, 300));
    expect((await h.call("lsp_debug_status")).data.running).toBe(false);
    const r = await h.call("lsp_hover", { file_path: file, line: 0, character: 0 });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ contents: "hover 0:0" });
    const pid2 = (await h.call("lsp_debug_status")).data.pid;
    expect(pid2).not.toBe(pid1);
    expect((await h.call("get_solution_info")).data.ready).toBe(true);
  });

  it("gives up after the retry and includes stderr", async () => {
    h = await connect({ FAKE_CRASH_ON_HOVER: "1" });
    const sln = solution();
    const file = path.join(dir, "main.clw"); writeFileSync(file, "  PROGRAM\n");
    await h.call("open_solution", { solution_path: sln });
    const r = await h.call("lsp_hover", { file_path: file, line: 0, character: 0 });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/after restart/);
    expect(Array.isArray(r.data.stderrTail)).toBe(true);
  });
});
