// Patch 3 for the Clarion Assistant language server: workspace/symbol (Ctrl+T, lsp_find_symbol).
// (a) A FILE whose KEY/INDEX is *labelled* "Key" or "Index" produced a symbol whose name was the
//     rest of the file (100k+ characters): the child scan matched the label token, so the
//     parenthesis extractor started one token late and never closed.
// (b) The same file was reported twice when the cached URI and the project URI differed in case.
// Idempotent per edit; backs up to <name>.orig once (shared with earlier patches); preserves CRLF.
// Set PATCH_SRC to patch a copy instead of the install.
const fs = require("fs");
const S = process.env.PATCH_SRC || "C:/Clarion12/accessory/addins/ClarionAssistant/lsp-server/out/server/src/";
const MARK = "// PATCH clarion-lsp-mcp#workspace-symbols:";

function patch(file, edits) {
  const p = S + file;
  const raw = fs.readFileSync(p, "utf8");
  const crlf = raw.includes("\r\n");
  let t = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  let applied = 0, skipped = 0;
  for (const [anchor, replacement] of edits) {
    if (t.includes(replacement)) { skipped++; continue; }      // this edit is already in place
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

patch("providers/ClarionDocumentSymbolProvider.js", [
  // (a) Only the KEY/INDEX *keyword* is followed by "(": a label spelled Key/Index is not.
  [
`                const childToken = tokens[j];
                const childValue = childToken.value.toUpperCase();
                // Add KEY as child
                if (childValue === "KEY") {`,
`                const childToken = tokens[j];
                const childValue = childToken.value.toUpperCase();
                ${MARK} a field *labelled* "Key"/"Index" upper-cases to the same word;
                // only the keyword is followed by "(" and extractParenContent assumes we are inside it.
                const childOpensParen = j + 1 < tokens.length && tokens[j + 1].value === "(";
                // Add KEY as child
                if (childValue === "KEY" && childOpensParen) {`
  ],
  [
`                // Add INDEX as child
                else if (childValue === "INDEX") {`,
`                // Add INDEX as child
                else if (childValue === "INDEX" && childOpensParen) {`
  ],
]);

patch("providers/WorkspaceSymbolProvider.js", [
  // (b) Deduplicate by the cache's canonical (decoded, lower-cased) key, not the raw URI string.
  [
`            seenUris.add(uri);
            const tokens = this.tokenCache.getTokensByUri(uri);`,
`            seenUris.add(TokenCache_1.TokenCache.canonicalKey(uri)); ${MARK} case-insensitive dedupe
            const tokens = this.tokenCache.getTokensByUri(uri);`
  ],
  [
`                    if (seenUris.has(uri))
                        continue;
                    seenUris.add(uri);`,
`                    if (seenUris.has(TokenCache_1.TokenCache.canonicalKey(uri))) ${MARK} case-insensitive dedupe
                        continue;
                    seenUris.add(TokenCache_1.TokenCache.canonicalKey(uri));`
  ],
]);
