// Minimal stand-in for the Clarion language server. Speaks LSP over stdio.
// Env: FAKE_PROJECT_DIR (project path), FAKE_REDIR_PATH (findFile answer for redir.inc),
//      FAKE_SLOW=1 (never send solutionReady), FAKE_CRASH_ON_HOVER=1 (exit(3) on hover),
//      FAKE_NO_DIAGNOSTICS=1 (never publish diagnostics), FAKE_ONE_PHASE=1 (single publish, like a libsrc file),
//      FAKE_INDEXING=1 (graphStatus never reaches "built").
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const conn = createMessageConnection(
  new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const r = (l, c, el = l, ec = c + 4) =>
  ({ start: { line: l, character: c }, end: { line: el, character: ec } });

conn.onRequest("initialize", () => ({ capabilities: {} }));
conn.onNotification("initialized", () => {});
conn.onNotification("clarion/updatePaths", p => {
  if (!p.projectPaths?.[0]) { process.stderr.write("No projectPaths provided\n"); return; }
  if (process.env.FAKE_SLOW) return;
  conn.sendNotification("clarion/solutionReady",
    { solutionFilePath: p.solutionFilePath, projectCount: 1 });
  // Like the real server: the background file graph is announced after solutionReady.
  // FAKE_INDEXING=1 never finishes it.
  conn.sendNotification("clarion/graphStatus", { status: "building", fileCount: 1 });
  if (!process.env.FAKE_INDEXING) conn.sendNotification("clarion/graphStatus", { status: "built", fileCount: 1, edgeCount: 0 });
});
// Like the real (patched) server: a structural publish first, the complete list 150 ms later,
// both stamped with the document version. FAKE_ONE_PHASE=1 publishes only once (a libsrc file).
// FAKE_STATUS=1 also sends clarion/diagnosticsStatus complete after the last publish (1.0.4+ servers).
function publish(uri, version, text) {
  if (process.env.FAKE_NO_DIAGNOSTICS) return;
  const diagnostics = text.includes("BAD")
    ? [{ severity: 1, range: r(0, 0, 0, 3), message: "Unknown identifier BAD" }] : [];
  const last = () => {
    conn.sendNotification("textDocument/publishDiagnostics", { uri, version, diagnostics });
    if (process.env.FAKE_STATUS) conn.sendNotification("clarion/diagnosticsStatus", { uri, version, state: "complete" });
  };
  if (process.env.FAKE_ONE_PHASE) { last(); return; }
  conn.sendNotification("textDocument/publishDiagnostics", { uri, version, diagnostics: [] });
  setTimeout(last, 150);
}
conn.onNotification("textDocument/didOpen", ({ textDocument }) =>
  publish(textDocument.uri, textDocument.version, textDocument.text));
conn.onNotification("textDocument/didChange", ({ textDocument, contentChanges }) =>
  publish(textDocument.uri, textDocument.version, contentChanges[0].text));
conn.onRequest("textDocument/hover", ({ position }) => {
  if (process.env.FAKE_CRASH_ON_HOVER) process.exit(3);
  return { contents: { kind: "markdown", value: `hover ${position.line}:${position.character}` } };
});
conn.onRequest("textDocument/definition", ({ textDocument }) =>
  [{ uri: textDocument.uri, range: r(3, 2) }]);
conn.onRequest("textDocument/references", ({ textDocument }) =>
  [{ uri: textDocument.uri, range: r(3, 2) }, { uri: textDocument.uri, range: r(7, 4) }]);
conn.onRequest("textDocument/documentSymbol", () => [
  { name: "Main", kind: 12, range: r(1, 0), selectionRange: r(1, 0),
    children: [{ name: "Counter", kind: 13, range: r(2, 2), selectionRange: r(2, 2) }] },
]);
conn.onRequest("workspace/symbol", ({ query }) => [
  { name: query, kind: 12, location: { uri: "file:///C:/fake/main.clw", range: r(1, 0) } },
]);
conn.onRequest("textDocument/rename", ({ textDocument, newName }) =>
  newName === "!" ? null : { changes: { [textDocument.uri]: [{ range: r(3, 2, 3, 6), newText: newName }] } });
conn.onRequest("clarion/getSolutionTree", () => ({
  name: "Fake", path: "C:\\fake\\Fake.sln",
  projects: [{ name: "Fake", path: process.env.FAKE_PROJECT_DIR ?? "C:\\fake",
               guid: "{ABC}", filename: "Fake.cwproj", sourceFiles: [] }],
}));
conn.onRequest("clarion/getProjectFiles", ({ projectGuid }) => ({
  files: projectGuid === "{ABC}" ? [
    { name: "main.clw", relativePath: "main.clw" },
    { name: "redir.inc", relativePath: "redir.inc" },
    { name: "ghost.inc", relativePath: "ghost.inc" },
    { name: "notes.txa", relativePath: "notes.txa" },
  ] : [],
}));
// Real server returns { path: "", source: "" } on a miss, never null.
conn.onRequest("clarion/findFile", ({ filename }) =>
  filename === "redir.inc" && process.env.FAKE_REDIR_PATH
    ? { path: process.env.FAKE_REDIR_PATH, source: "redirection" } : { path: "", source: "" });
conn.onRequest("shutdown", () => null);
conn.onNotification("exit", () => process.exit(0));
conn.listen();
