// Patch 4 for the Clarion Assistant language server: stamp publishDiagnostics with the document
// version (LSP 3.15 `PublishDiagnosticsParams.version`). The server publishes twice per validation
// (structural pass, then the combined list once the async validators finish) and never says which
// document version a publish belongs to, so a client cannot tell a stale publish from a fresh one,
// or a structural-only answer from the complete one. Idempotent per edit; .orig backup; CRLF kept.
// Set PATCH_SRC to patch a copy instead of the install.
const fs = require("fs");
const S = process.env.PATCH_SRC || "C:/Clarion12/accessory/addins/ClarionAssistant/lsp-server/out/server/src/";
const MARK = "// PATCH clarion-lsp-mcp#diagnostics-version:";

function patch(file, edits) {
  const p = S + file;
  const raw = fs.readFileSync(p, "utf8");
  const crlf = raw.includes("\r\n");
  let t = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  let applied = 0, skipped = 0;
  for (const [anchor, replacement] of edits) {
    if (t.includes(replacement)) { skipped++; continue; }
    const n = t.split(anchor).length - 1;
    if (n !== 1) throw new Error(`${file}: anchor found ${n} times (expected 1):\n${anchor.slice(0, 160)}`);
    t = t.replace(anchor, replacement);
    applied++;
  }
  if (applied === 0) { console.log(`${file}: all ${skipped} edits already applied, skipping`); return; }
  if (!fs.existsSync(p + ".orig")) fs.copyFileSync(p, p + ".orig");
  fs.writeFileSync(p, crlf ? t.replace(/\n/g, "\r\n") : t);
  console.log(`${file}: patched (${applied} new edit(s), ${skipped} already present), backup at ${file}.orig`);
}

patch("server.js", [
  // (a) libsrc files: the only publish.
  [
`            // Send only sync diagnostics; skip the async Promise.all entirely.
            connection.sendDiagnostics({ uri: document.uri, diagnostics });`,
`            // Send only sync diagnostics; skip the async Promise.all entirely.
            connection.sendDiagnostics({ uri: document.uri, diagnostics, version: document.version }); ${MARK} stamp version`
  ],
  // (b) structural pass, published first.
  [
`        // Send sync diagnostics immediately for fast feedback
        connection.sendDiagnostics({ uri: document.uri, diagnostics });`,
`        // Send sync diagnostics immediately for fast feedback
        connection.sendDiagnostics({ uri: document.uri, diagnostics, version: document.version }); ${MARK} stamp version`
  ],
  // (c) combined list after the async validators (guarded above against a newer version).
  [
`        diagnostics.push(...asyncDiags);
        connection.sendDiagnostics({ uri: document.uri, diagnostics });`,
`        diagnostics.push(...asyncDiags);
        connection.sendDiagnostics({ uri: document.uri, diagnostics, version: startVersion }); ${MARK} stamp version`
  ],
]);
