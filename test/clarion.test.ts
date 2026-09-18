import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findClarionRoot, findSolution, buildPaths, SERVER_REL, SERVER_MAIN } from "../src/clarion.js";

let drive: string;
const versions: Record<string, string> = {};
const readVersion = (root: string) => versions[path.basename(root)] ?? "0.0";

function makeInstall(name: string, version: string, withServer = true) {
  const root = path.join(drive, name);
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(path.join(root, "bin", "Clarion.exe"), "");
  if (withServer) {
    const serverDir = path.join(root, SERVER_REL);
    mkdirSync(path.dirname(path.join(serverDir, SERVER_MAIN)), { recursive: true });
    writeFileSync(path.join(serverDir, SERVER_MAIN), "");
    writeFileSync(path.join(serverDir, "node.exe"), "");
  }
  versions[name] = version;
  return root;
}

beforeEach(() => {
  drive = mkdtempSync(path.join(tmpdir(), "clarion-")) + path.sep;
  delete process.env.CLARION_ROOT; // this host may have a real Clarion install; tests must be hermetic
});
afterEach(() => { rmSync(drive, { recursive: true, force: true }); delete process.env.CLARION_ROOT; });

describe("findClarionRoot", () => {
  it("picks the highest version that has the addin server", () => {
    makeInstall("Clarion11.1", "11.1.13855");
    const c12 = makeInstall("Clarion12", "12.0.14625");
    makeInstall("Clarion13", "13.0.1", false);          // newer but no addin
    const found = findClarionRoot({ drive, readVersion });
    expect(found.root).toBe(c12);
    expect(found.version).toBe("12.0.14625");
    expect(found.nodeExe).toBe(path.join(c12, SERVER_REL, "node.exe"));
    expect(found.serverMain).toBe(path.join(c12, SERVER_REL, SERVER_MAIN));
  });

  it("honours CLARION_ROOT over auto-detection", () => {
    makeInstall("Clarion12", "12.0.14625");
    const c11 = makeInstall("Clarion11.1", "11.1.13855");
    process.env.CLARION_ROOT = c11;
    expect(findClarionRoot({ drive, readVersion }).root).toBe(c11);
  });

  it("rejects an override that lacks the addin server", () => {
    const bare = makeInstall("Clarion13", "13.0.1", false);
    expect(() => findClarionRoot({ override: bare, drive, readVersion }))
      .toThrow(/Clarion Assistant/);
  });

  it("explains itself when nothing is installed", () => {
    expect(() => findClarionRoot({ drive, readVersion })).toThrow(/CLARION_ROOT/);
  });
});

describe("findSolution", () => {
  it("uses an explicit .sln that exists", () => {
    const sln = path.join(drive, "App.sln"); writeFileSync(sln, "");
    expect(findSolution(sln, drive)).toBe(sln);
  });
  it("rejects an explicit path that is not a .sln or does not exist", () => {
    expect(() => findSolution(path.join(drive, "App.cwproj"), drive)).toThrow(/\.sln/);
    expect(() => findSolution(path.join(drive, "Nope.sln"), drive)).toThrow(/not found/);
  });
  it("finds exactly one .sln in cwd", () => {
    const sln = path.join(drive, "Only.sln"); writeFileSync(sln, "");
    expect(findSolution(undefined, drive)).toBe(sln);
  });
  it("lists candidates when there are several, and asks for a path when none", () => {
    expect(() => findSolution(undefined, drive)).toThrow(/solution_path/);
    writeFileSync(path.join(drive, "A.sln"), ""); writeFileSync(path.join(drive, "B.sln"), "");
    expect(() => findSolution(undefined, drive)).toThrow(/A\.sln.*B\.sln/);
  });
});

describe("buildPaths", () => {
  it("prefers a .red beside the .sln and fills every field", () => {
    const root = makeInstall("Clarion12", "12.0.14625");
    writeFileSync(path.join(root, "bin", "ClarionNet40.red"), "");
    const slnDir = path.join(drive, "Work"); mkdirSync(slnDir);
    const sln = path.join(slnDir, "App.sln"); writeFileSync(sln, "");
    writeFileSync(path.join(slnDir, "App.red"), "");
    const clarion = findClarionRoot({ override: root, readVersion });
    const p = buildPaths(clarion, sln, "Release");
    expect(p).toEqual({
      solutionFilePath: sln,
      // The server joins redirectionFile onto each project dir, then onto redirectionPaths[0]:
      // it must be the bare file name. The full path is kept separately for reporting.
      redirectionFile: "App.red",
      redirectionFilePath: path.join(slnDir, "App.red"),
      redirectionPaths: [path.join(root, "bin")],
      libsrcPaths: [path.join(root, "libsrc", "win"), path.join(root, "libsrc")],
      projectPaths: [slnDir],
      macros: { ClarionRoot: root, bin: path.join(root, "bin"), redname: "App.red" },
      configuration: "Release",
      clarionVersion: "12.0.14625",
      defaultLookupExtensions: [".clw", ".inc", ".equ", ".eq", ".int"],
    });
  });
  it("falls back to the first .red in bin, and to empty when there is none", () => {
    const root = makeInstall("Clarion12", "12.0.14625");
    const sln = path.join(drive, "App.sln"); writeFileSync(sln, "");
    const clarion = findClarionRoot({ override: root, readVersion });
    expect(buildPaths(clarion, sln).redirectionFile).toBe("");
    expect(buildPaths(clarion, sln).redirectionFilePath).toBe("");
    writeFileSync(path.join(root, "bin", "ClarionNet40.red"), "");
    const p = buildPaths(clarion, sln);
    expect(p.redirectionFile).toBe("ClarionNet40.red");
    expect(p.redirectionFilePath).toBe(path.join(root, "bin", "ClarionNet40.red"));
    expect(p.configuration).toBe("Debug");
    expect(p.macros.redname).toBe("ClarionNet40.red");
  });
});
