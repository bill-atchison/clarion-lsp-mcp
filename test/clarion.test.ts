import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findClarionRoot, SERVER_REL, SERVER_MAIN } from "../src/clarion.js";

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
