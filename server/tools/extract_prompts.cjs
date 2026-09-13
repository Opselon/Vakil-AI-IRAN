#!/usr/bin/env node
/* Generates app_api.prompts.js for the Vakil worker by EXTRACTING exact prompt/page
   expressions from worker.js so the mobile API is a verbatim copy of bot behavior. */
const fs = require("fs");
const path = require("path");

const WORKER = process.argv[2] || "C:/Users/Capsizer/Desktop/VAKILAI/worker.js";
const OUT = process.argv[3] || path.join(__dirname, "app_api.prompts.js");

const src = fs.readFileSync(WORKER, "utf8");
const lines = src.split(/\r?\n/);

// Extract the JS expression assigned on line `declLine` (1-based) up to the
// terminating top-level ';'. Everything from the '=' of the declaration onward.
function extractExpression(declLine, mustContain) {
  const idx = declLine - 1;
  const line = lines[idx];
  if (!line.includes(mustContain)) {
    throw new Error(`Line ${declLine} does not contain "${mustContain}": ${JSON.stringify(line.slice(0, 90))}`);
  }
  // find the '=' that assigns (last '=' before expression start that's not ==/=>)
  const eq = line.indexOf("=");
  let i = idx, j = eq + 1;
  let buf = "", depth = 0, inS = null, esc = false, started = false;
  for (; i < lines.length; i++) {
    if (i > idx) j = 0;
    for (; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (!started) {
        if (/\s/.test(ch)) continue;
        started = true;
      }
      if (inS) {
        buf += ch;
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === inS) inS = null;
        continue;
      }
      if (ch === "/" && lines[i][j + 1] === "/") { buf += " "; break; } // skip rest line
      if (ch === '"' || ch === "'" || ch === "`") { inS = ch; buf += ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      if (ch === ")" || ch === "]" || ch === "}") depth--;
      if (ch === ";" && depth === 0) { return buf.trim(); }
      buf += ch;
    }
    buf += "\n";
  }
  throw new Error(`unterminated expression from line ${declLine}`);
}

function wrap(name, expr, params) {
  return `function ${name}(${params.join(", ")}) {\n  return (${expr});\n}\n\n`;
}

// [funcName, workerLine, marker, params]
const jobs = [
  // ---- AI action prompts (engine inputs) ----
  ["APP_PROMPT_DEEP",           10937, "const deepPrompt = ",    ["cleanOriginal"]],
  ["APP_PROMPT_DOS_DONTS",      11505, "const actionPrompt = ",  ["cleanOriginal"]],
  ["APP_PROMPT_COURT",          11640, "const actionPrompt = ",  ["cleanOriginal"]],
  ["APP_PROMPT_FINANCIAL",      11822, "const actionPrompt = ",  ["cleanOriginal"]],
  ["APP_PROMPT_LEGAL_OPP",      11966, "const actionPrompt =",   ["cleanOriginal"]],
  ["APP_PROMPT_OPPONENT",       12212, "const actionPrompt =",   ["cleanOriginal"]],
  ["APP_PROMPT_INTERROGATION",  12465, "const actionPrompt =",   ["cleanOriginal"]],
  ["APP_PROMPT_DYNAMIC_ACTION", 11231, "const actionPrompt = ",  ["actionTitle", "originalContext"]],
  // ---- static page texts ----
  ["APP_PAGE_MAIN_MENU",         9536, "const txt = ",  []],
  ["APP_PAGE_DRAFT_INTRO",       9560, "const txt =",   []],
  ["APP_PAGE_EXIT_DRAFT",        9596, "const txt =",   []],
  ["APP_PAGE_LIMIT",             9628, "const txt = ",  ["bar", "percent", "used", "status", "limit", "statusIcon"]],
  ["APP_PAYMENT_BLOCK",          9661, "const paymentBlock =", ["CARD_OWNER", "CARD_NUMBER", "SUPPORT_ID"]],
  ["APP_PAGE_CONTACT",           9703, "const txt =",   ["paymentBlock", "DIRECT_PHONE", "SUPPORT_ID"]],
  ["APP_PAGE_BUY_CONSULT",       9748, "const txt =",   ["paymentBlock", "DIRECT_PHONE", "SUPPORT_ID"]],
  ["APP_PAGE_BUY_DOCS",          9768, "const txt =",   ["paymentBlock", "SUPPORT_ID"]],
  ["APP_PAGE_BUY_DRAFT",         9788, "const txt =",   ["paymentBlock"]],
  ["APP_PAGE_BUY_SUB",           9809, "const txt =",   ["DIRECT_PHONE", "SUPPORT_ID"]],
  ["APP_PAGE_SUPPORT",           9831, "const txt =",   ["DIRECT_PHONE", "SUPPORT_ID"]],
  ["APP_PAGE_FAQ",               9848, "const txt =",   ["SUPPORT_ID", "DIRECT_PHONE"]],
  ["APP_PAGE_HELP",              9877, "const txt =",   []],
  ["APP_PAGE_TERMS",             9938, "const txt = ",  []],
  ["APP_PAGE_ABOUT",             9977, "const txt =",   []],
  ["APP_PAGE_WELCOME",           9479, "const txt = ",  []],
  ["APP_PAGE_START",             7639, "const txt = ",  ["greeting"]],
];

let out = "// AUTO-GENERATED from worker.js — verbatim prompt/page extraction. DO NOT EDIT BY HAND.\n";
out += "/* eslint-disable */\n\n";

for (const [name, line, marker, params] of jobs) {
  const expr = extractExpression(line, marker);
  out += wrap(name, expr, params);
  console.log(`ok ${name} (${expr.length} chars)`);
}

fs.writeFileSync(OUT, out, "utf8");
new Function(out); // syntax check
console.log("\nSYNTAX OK ->", OUT);
