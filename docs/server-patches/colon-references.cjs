// Patch 2 for the Clarion Assistant language server: find-references for colon-prefixed
// procedure labels (reg:ITEM:CashOutExists, reg:WIN:ShowExits).
// Backs up to <name>.orig once (shared with patch 1 if already present); refuses to double-apply.
// Preserves CRLF. Set PATCH_SRC to patch a copy instead of the install.
const fs = require("fs");
const S = process.env.PATCH_SRC || "C:/Clarion12/accessory/addins/ClarionAssistant/lsp-server/out/server/src/";
const MARK = "// PATCH clarion-lsp-mcp#colon-references:";

function patch(file, edits) {
  const p = S + file;
  const raw = fs.readFileSync(p, "utf8");
  if (raw.includes(MARK)) { console.log(`${file}: already patched, skipping`); return; }
  const crlf = raw.includes("\r\n");
  let t = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  for (const [anchor, replacement] of edits) {
    const n = t.split(anchor).length - 1;
    if (n !== 1) throw new Error(`${file}: anchor found ${n} times (expected 1):\n${anchor.slice(0, 160)}`);
    t = t.replace(anchor, replacement);
  }
  if (!fs.existsSync(p + ".orig")) fs.copyFileSync(p, p + ".orig");
  fs.writeFileSync(p, crlf ? t.replace(/\n/g, "\r\n") : t);
  console.log(`${file}: patched (${edits.length} edits), backup at ${file}.orig`);
}

patch("providers/ReferencesProvider.js", [
  // (a) A colon-prefixed word that the symbol finder resolved to a *partial* field match
  //     (e.g. "reg:WIN:ShowExits" -> field "WIN:ShowExits" of a FILE with PRE(REG)) is not a
  //     field reference. Send it down the procedure-hunt route instead.
  [
`        const symbolInfo = await this.symbolFinder.findSymbol(word, document, position);
        if (!symbolInfo) {`,
`        let symbolInfo = await this.symbolFinder.findSymbol(word, document, position);
        ${MARK} a prefixed label that only partially matched a structure field is a
        // procedure (or global) label, not that field. Fall through to the procedure hunt.
        if (symbolInfo && word.includes(':') && symbolInfo.scope && symbolInfo.scope.type === 'field' &&
            String(symbolInfo.token && symbolInfo.token.value).toLowerCase() !== word.toLowerCase()) {
            symbolInfo = null;
        }
        if (!symbolInfo) {`
  ],
  // (b) Call sites of "pre:fix:name(" tokenize as StructurePrefix ':' Function. No single token
  //     equals the search word, so match the rejoined chain and report the whole label range.
  [
`                    matchLength = token.label.length;
                }
                else {
                    continue;
                }
                if (!includeDeclaration && fileUri === declarationUri && token.line === declarationLine)`,
`                    matchLength = token.label.length;
                }
                else if (searchWordLower.includes(':') &&
                    (token.type === ClarionTokenizer_1.TokenType.Function ||
                     token.type === ClarionTokenizer_1.TokenType.Label ||
                     token.type === ClarionTokenizer_1.TokenType.Variable) &&
                    searchWordLower.endsWith(':' + token.value.toLowerCase())) {
                    ${MARK} rejoin the "StructurePrefix ':'" chain that precedes this token
                    // on the same line and compare the whole label.
                    let joined = token.value;
                    let firstStart = token.start;
                    let j = i - 1;
                    while (j >= 1 && tokens[j].line === token.line && tokens[j].value === ':' &&
                           tokens[j - 1].line === token.line &&
                           tokens[j - 1].type === ClarionTokenizer_1.TokenType.StructurePrefix) {
                        joined = tokens[j - 1].value + ':' + joined;
                        firstStart = tokens[j - 1].start;
                        j -= 2;
                    }
                    if (joined.toLowerCase() !== searchWordLower) {
                        continue;
                    }
                    matchStart = firstStart;
                    matchLength = joined.length;
                }
                else {
                    continue;
                }
                if (!includeDeclaration && fileUri === declarationUri && token.line === declarationLine)`
  ],
]);
// (c) The per-file reference-count index is built from a word regex that splits identifiers at
//     colons, so it never holds "reg:item:cashoutexists" and prunes every file before the scan.
//     A prefixed name may be present when its last segment is.
patch("services/ReferenceCountIndex.js", [
  [
`        if (((_a = counts.get(nameLower)) !== null && _a !== void 0 ? _a : 0) > 0)
            return true;`,
`        if (((_a = counts.get(nameLower)) !== null && _a !== void 0 ? _a : 0) > 0)
            return true;
        ${MARK} the index splits identifiers at ':'; test the last segment of a prefixed name.
        if (nameLower.includes(':')) {
            const tail = nameLower.split(':').pop();
            if (tail && (counts.get(tail) || 0) > 0)
                return true;
        }`
  ],
]);
console.log("done");
