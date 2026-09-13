#!/usr/bin/env node
/* Slice-locator for the app-worker builder: finds top-level declarations in
   the pristine bot worker and returns VERBATIM [start,end] line ranges.

   End = last line before the next REAL boundary (a column-0 declaration, a
   column-0 `}` block close, or EOF). The candidate slice is verified with
   `node --check`; on "Unexpected end of input" the region is extended to the
   next boundary until it parses — which safely absorbs stray column-0 lines
   inside function bodies (the bot source has a few). */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

function createLocator(workerPath) {
  const lines = fs.readFileSync(workerPath, "utf8").replace(/\r\n/g, "\n").split("\n");
  const isDecl = (L) => !/^\s/.test(L) && /^(async function |function |class |const |let |var |import |export )/.test(L);
  const isClose = (L) => /^\}/.test(L);
  const TOPS = [];
  for (let i = 0; i < lines.length; i++) if (isDecl(lines[i])) TOPS.push(i + 1);
  const BOUNDS = [];
  for (let i = 0; i < lines.length; i++) if (isDecl(lines[i]) || (isClose(lines[i]) && !/^\s/.test(lines[i]))) BOUNDS.push(i + 1);

  function checkSlice(s, e) {
    const tmp = path.join(os.tmpdir(), `slice_check_${process.pid}_${s}_${e}.js`);
    fs.writeFileSync(tmp, lines.slice(s - 1, e).join("\n"), "utf8");
    try {
      const r = cp.spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
      return r.status === 0 ? "ok" : (r.stderr.includes("Unexpected end of input") || r.stderr.includes("Unexpected token '}'") ? "truncated" : "error");
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }

  function nextBound(after) { for (const b of BOUNDS) if (b > after) return b; return lines.length + 1; }

  function boundaryEnd(start) {
    let end = nextBound(start) - 1;
    while (end > start && lines[end - 1].trim().length === 0) end--;
    return end;
  }

  function findFn(name, opts = {}) {
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (/^\s/.test(L)) continue;
      if (opts.kind === "const") { if (L.startsWith(`const ${name} =`)) { start = i + 1; break; } continue; }
      if (opts.kind === "class") { if (L.startsWith(`class ${name}`) && !/[A-Za-z0-9_$]/.test(L[name.length + 6] || "x")) { start = i + 1; break; } continue; }
      if (opts.kind === "function") {
        if ((L.startsWith("function ") || L.startsWith("async function ")) && L.includes(`function ${name}(`)) { start = i + 1; break; }
        continue;
      }
      if (L.startsWith(`class ${name}`) && !/[A-Za-z0-9_$]/.test(L[name.length + 6] || "x")) { start = i + 1; break; }
      if ((L.startsWith("function ") || L.startsWith("async function ")) && L.includes(`function ${name}(`)) { start = i + 1; break; }
      if (L.startsWith(`const ${name} =`)) { start = i + 1; break; }
    }
    if (start === -1) return null;
    // walk successive boundaries; first candidate end (before-decl or the `}`
    // close line itself) whose slice parses cleanly wins.
    for (let b = nextBound(start), guard = 0; b <= lines.length && guard < 80; b = nextBound(b + 1), guard++) {
      for (const cand of [b - 1, b]) {
        if (cand < start) continue;
        let e = cand;
        while (e > start && lines[e - 1].trim().length === 0) e--;
        const st = checkSlice(start, e);
        if (st === "ok") return [start, e, "ok"];
        if (st === "error") break; // this candidate hopeless; try next boundary
      }
    }
    return [start, boundaryEnd(start), "unresolved"];
  }

  function findBlockLiteral(hintLine, marker) { // e.g. const SYSTEM_PROMPT = `...`;
    let start = -1;
    for (let i = Math.max(0, (hintLine || 1) - 3); i < lines.length; i++) {
      if (lines[i].startsWith("const") && lines[i].includes(marker)) { start = i + 1; break; }
    }
    if (start === -1) return null;
    let inTpl = false, esc = false;
    for (let i = start - 1; i < lines.length; i++) {
      const L = lines[i];
      const from = i === start - 1 ? L.indexOf("`") + 1 : 0;
      for (let j = from; j < L.length; j++) {
        const ch = L[j];
        if (!inTpl) { if (ch === "`") inTpl = true; continue; }
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === "`") return [start, i + 1];
      }
    }
    return null;
  }

  return { lines, findFn, findBlockLiteral, checkSlice, isDecl };
}

module.exports = { createLocator };
