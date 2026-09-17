import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const SERVER_REL = path.join("accessory", "addins", "ClarionAssistant", "lsp-server");
export const SERVER_MAIN = path.join("out", "server", "src", "server.js");

export interface ClarionRoot {
  root: string;
  version: string;
  serverDir: string;
  nodeExe: string;
  serverMain: string;
}

export interface FindRootOptions {
  override?: string;                       // beats CLARION_ROOT; used by the tool argument
  drive?: string;                          // default "C:\\"; tests point it at a temp dir
  readVersion?: (root: string) => string;  // tests inject; default shells out to PowerShell
}

export function hasServer(root: string): boolean {
  const serverDir = path.join(root, SERVER_REL);
  return existsSync(path.join(root, "bin", "Clarion.exe")) &&
    existsSync(path.join(serverDir, SERVER_MAIN)) &&
    existsSync(path.join(serverDir, "node.exe"));
}

export function readVersion(root: string): string {
  const exe = path.join(root, "bin", "Clarion.exe");
  try {
    const out = execFileSync("powershell.exe",
      ["-NoProfile", "-Command", `(Get-Item '${exe}').VersionInfo.FileVersion`],
      { encoding: "utf8", windowsHide: true });
    return out.trim() || "0.0";
  } catch {
    return "0.0";
  }
}

export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function describe(root: string, version: string): ClarionRoot {
  const serverDir = path.join(root, SERVER_REL);
  return { root, version, serverDir,
    nodeExe: path.join(serverDir, "node.exe"),
    serverMain: path.join(serverDir, SERVER_MAIN) };
}

export function findClarionRoot(opts: FindRootOptions = {}): ClarionRoot {
  const rv = opts.readVersion ?? readVersion;
  const override = opts.override ?? process.env.CLARION_ROOT;
  if (override) {
    if (!hasServer(override)) {
      throw new Error(`${override} is not a Clarion install with the Clarion Assistant addin ` +
        `(expected bin\\Clarion.exe and ${SERVER_REL}\\node.exe).`);
    }
    return describe(override, rv(override));
  }
  const drive = opts.drive ?? "C:\\";
  const found = readdirSync(drive, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^clarion/i.test(d.name))
    .map(d => path.join(drive, d.name))
    .filter(hasServer)
    .map(root => ({ root, version: rv(root) }))
    .sort((a, b) => compareVersion(b.version, a.version));
  if (!found.length) {
    throw new Error(`No Clarion install with the Clarion Assistant addin found under ` +
      `${drive}Clarion*. Set CLARION_ROOT to the install folder.`);
  }
  return describe(found[0].root, found[0].version);
}

export function findSolution(explicit: string | undefined, cwd: string): string {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!p.toLowerCase().endsWith(".sln")) throw new Error(`solution_path must be a .sln file: ${p}`);
    if (!existsSync(p)) throw new Error(`Solution not found: ${p}`);
    return p;
  }
  const found = readdirSync(cwd)
    .filter(f => f.toLowerCase().endsWith(".sln"))
    .map(f => path.join(cwd, f));
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error(`No .sln file in ${cwd}. Pass solution_path.`);
  throw new Error(`Several .sln files in ${cwd}: ${found.join(", ")}. Pass solution_path.`);
}

export interface UpdatePathsParams {
  solutionFilePath: string;
  redirectionFile: string;
  redirectionPaths: string[];
  libsrcPaths: string[];
  projectPaths: string[];          // [0] MUST be the solution directory
  macros: Record<string, string>;
  configuration: string;
  clarionVersion: string;
  defaultLookupExtensions: string[];
}

function firstRed(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir).find(n => n.toLowerCase().endsWith(".red"));
  return f ? path.join(dir, f) : undefined;
}

export function buildPaths(clarion: ClarionRoot, solutionFile: string,
                           configuration = "Debug"): UpdatePathsParams {
  const solutionDir = path.dirname(solutionFile);
  const bin = path.join(clarion.root, "bin");
  const redirectionFile = firstRed(solutionDir) ?? firstRed(bin) ?? "";
  return {
    solutionFilePath: solutionFile,
    redirectionFile,
    redirectionPaths: [bin],
    libsrcPaths: [path.join(clarion.root, "libsrc", "win"), path.join(clarion.root, "libsrc")],
    projectPaths: [solutionDir],
    macros: { ClarionRoot: clarion.root, bin, redname: path.basename(redirectionFile) },
    configuration,
    clarionVersion: clarion.version,
    defaultLookupExtensions: [".clw", ".inc", ".equ", ".eq", ".int"],
  };
}
