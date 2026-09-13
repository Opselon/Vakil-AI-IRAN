// binary-search the first line prefix of the built app worker that fails ESM parse
import vm from 'node:vm';
import fs from 'node:fs';
const lines = fs.readFileSync('server/dist/vakil-app-worker.js', 'utf8').split('\n');

function parses(n) {
  try { new vm.SourceTextModule(lines.slice(0, n).join('\n')); return true; }
  catch (e) { return String(e.message).slice(0, 120); }
}

let lo = 1, hi = lines.length;
// first ensure full file fails (known) and find minimal breaking prefix
// monotonic? A prefix ending mid-statement also fails, so instead: find first failure among prefixes ending exactly at top-level boundaries.
const TOP = /^(async function |function |class |const |let |var |export |\/\/)/;
const bounds = [];
for (let i = 0; i < lines.length; i++) if (i > 0 && TOP.test(lines[i]) && !/^\s/.test(lines[i])) bounds.push(i); // prefix = lines[0..i-1]
let lastOk = 0;
for (const b of bounds) {
  const res = parses(b);
  if (res !== true) {
    console.log('FIRST BROKEN PREFIX: lines 1..' + b, '→', res);
    console.log('last ok prefix ended at line', lastOk);
    console.log('boundary line', b + 1, ':', lines[b].slice(0, 100));
    console.log('tail of broken region (last 8 lines of prefix):');
    console.log(lines.slice(Math.max(0, b - 8), b).map(l => l.slice(0, 120)).join('\n'));
    process.exit(1);
  }
  lastOk = b;
}
console.log('ALL PREFIX BOUNDS PARSE — issue only with full-file state? last bound', lastOk);
