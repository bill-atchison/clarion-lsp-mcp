// Patch 4 for the Clarion Assistant language server: stamp publishDiagnostics with the document
// version (LSP 3.15 `PublishDiagnosticsParams.version`), and send Clarion-Extension 1.0.4's
// `clarion/diagnosticsStatus` { uri, version, state } after each validation outcome (upstream #460:
// complete, deferred, superseded). The server publishes twice per validation (structural pass, then
// the combined list once the async validators finish) and never says which document version a
// publish belongs to or when the answer is whole; a cross-file update can even validate a document
// twice for one version, so counting publishes cannot tell a structural-only answer from the
// complete one. Idempotent per edit (upgrades an install carrying edits a-c); .orig backup; CRLF kept.
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
  // (d) libsrc files: the structural publish is the whole answer.
  [
`                caller
            });
            return;
        }
        // Send sync diagnostics immediately for fast feedback`,
`                caller
            });
            connection.sendNotification('clarion/diagnosticsStatus', { uri: document.uri, version: startVersion, state: 'complete' }); ${MARK} status (#460 backport)
            return;
        }
        // Send sync diagnostics immediately for fast feedback`
  ],
  // (e) async validators deferred until the pipelines are ready: the sdiReady pass validates again.
  [
`                sdi_ready: String(sdiPipelineReady),
                token_count: tokens.length,
                diag_count: diagnostics.length,
                uri: document.uri,
                caller
            });
            return;`,
`                sdi_ready: String(sdiPipelineReady),
                token_count: tokens.length,
                diag_count: diagnostics.length,
                uri: document.uri,
                caller
            });
            connection.sendNotification('clarion/diagnosticsStatus', { uri: document.uri, version: startVersion, state: 'deferred' }); ${MARK} status (#460 backport)
            return;`
  ],
  // (f) the document changed during the async pass: this version's answer is discarded.
  [
`            perfLogger.perf("validateTextDocument stale-skip", {
                total_ms: Date.now() - validateStart,
                token_count: tokens.length,
                uri: document.uri,
                caller
            });
            return;`,
`            perfLogger.perf("validateTextDocument stale-skip", {
                total_ms: Date.now() - validateStart,
                token_count: tokens.length,
                uri: document.uri,
                caller
            });
            connection.sendNotification('clarion/diagnosticsStatus', { uri: document.uri, version: startVersion, state: 'superseded' }); ${MARK} status (#460 backport)
            return;`
  ],
  // (g) the combined list is out: the whole answer for this version.
  [
`            async_ms: asyncMs,
            token_count: tokens.length,
            diag_count: diagnostics.length,
            uri: document.uri,
            caller
        });
    }
    catch (error) {`,
`            async_ms: asyncMs,
            token_count: tokens.length,
            diag_count: diagnostics.length,
            uri: document.uri,
            caller
        });
        connection.sendNotification('clarion/diagnosticsStatus', { uri: document.uri, version: startVersion, state: 'complete' }); ${MARK} status (#460 backport)
    }
    catch (error) {`
  ],
]);
