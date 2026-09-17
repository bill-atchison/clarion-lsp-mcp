import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
