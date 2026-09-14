// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Marketplace artifact-drift check: verifies that every embedded
//             `══ marketplace part: <file> ══` region inside the SHIPPED
//             dist/vakil-app-worker.js is byte-identical to the source part on
//             disk (and that no source part is missing from the artifact).
//             Closes the CI hole the legacy rebuild-hash could not: rebuilding
//             needs the private pristine bot worker, which CI never has — but
//             the marketplace parts ARE public and self-contained.
// OWNER     — coordinator (CI gate; Agent 9 may extend, not rewrite).
// CONSUMES  — server/dist/vakil-app-worker.js + server/tools/parts/app_module_
//             {common,schema,auth,google,lawyers,consultations,payments,admin}.js
//             (the same list build_app_worker.cjs concatenates).
// PROVIDES  — exit 0 "MARKETPLACE ARTIFACT IN SYNC (N parts)" or exit 1 with
//             the exact drifting/missing parts.
// INVARIANTS— read-only; never rewrites dist; failures must be fixed by
//             `cd server && npm run build` locally (needs bot source) or by
//             committing regenerated parts, NEVER by editing dist by hand.
// EXTEND    — keep MARKETPLACE_PARTS aligned with build_app_worker.cjs.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, '..', 'dist', 'vakil-app-worker.js');
const PARTS_DIR = path.join(HERE, 'parts');
// ORDER + set must mirror V1_ORDER in build_app_worker.cjs.
const MARKETPLACE_PARTS = [
  'app_module_common.js', 'app_module_schema.js', 'app_module_auth.js', 'app_module_google.js',
  'app_module_lawyers.js', 'app_module_consultations.js', 'app_module_payments.js', 'app_module_admin.js'
];

const artifact = fs.readFileSync(ARTIFACT, 'utf8');
let fail = 0;
for (const name of MARKETPLACE_PARTS) {
  const srcPath = path.join(PARTS_DIR, name);
  if (!fs.existsSync(srcPath)) continue; // part not written yet — absence is fine, mismatch is not
  const src = fs.readFileSync(srcPath, 'utf8');
  const marker = `// ══ marketplace part: ${name} ══\n`;
  const at = artifact.indexOf(marker);
  if (at === -1) {
    console.log(`DRIFT: ${name} exists in tools/parts/ but is NOT embedded in dist (rebuild needed)`);
    fail++; continue;
  }
  const start = at + marker.length;
  let end = artifact.length;
  for (const other of MARKETPLACE_PARTS) {
    const m2 = artifact.indexOf(`// ══ marketplace part: ${other} ══`, start);
    if (m2 !== -1 && m2 < end) end = m2;
  }
  // the builder joins parts with "\n" and the tail section follows; trim to the
  // exact source length first, then compare ignoring the joiner/next-header gap.
  let embedded = artifact.slice(start, end);
  embedded = embedded.replace(/\n+$/, '');
  const srcTrim = src.replace(/\s+$/, '');
  if (embedded.slice(0, srcTrim.length).trimEnd() !== srcTrim) {
    // locate first differing line for a useful message
    const a = srcTrim.split('\n'), b = embedded.split('\n');
    let d = 0; while (d < Math.min(a.length, b.length) && a[d] === b[d]) d++;
    console.log(`DRIFT: ${name} differs from the embedded copy at source line ${d + 1}:`);
    console.log(`  disk:     ${String(a[d] ?? '<eof>').slice(0, 120)}`);
    console.log(`  artifact: ${String(b[d] ?? '<eof>').slice(0, 120)}`);
    fail++;
  }
}
console.log(fail === 0
  ? `MARKETPLACE ARTIFACT IN SYNC (${MARKETPLACE_PARTS.length} part slots checked)`
  : `MARKETPLACE ARTIFACT DRIFT: ${fail} problem(s) — run "cd server && npm run build" and commit dist`);
process.exit(fail === 0 ? 0 : 1);
