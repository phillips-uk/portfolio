#!/usr/bin/env node
/* Figma to code token check (Figma sync playbook, 24 Nov 2026; copied from Before You Pay, main 6f444df041, for
   Phillips Group on 25 Nov 2026, then for phillips-uk.com the same day: only the token file list differs, this repo has
   no family.css).
   Compares .design/figma-tokens.json (the Figma variables, exported by Claude from the group design file) with the
   token files in tokens/. Prints, per token: same, different, worked out in code (color-mix etc), or only
   on one side. Nothing is changed. A "different" line means Figma and the site disagree: decide which is right,
   then change the other (tokens/*.css + node scripts/build-tokens.js, or the Figma variable).
   Usage: node scripts/figma-tokens.cjs [--strict]   (--strict exits 1 on any difference) */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const fig = JSON.parse(fs.readFileSync(path.join(ROOT, '.design/figma-tokens.json'), 'utf8'));
const mode = fig.brandMode;

const want = {};
for (const [col, modes] of Object.entries(fig.collections)) {
  const vals = col === 'Brand' ? modes[mode] : Object.values(modes)[0];
  if (!vals) { console.error(`Figma has no "${mode}" mode in ${col}`); process.exit(2); }
  Object.assign(want, vals);
}

function rootDecls(file) {
  const css = fs.readFileSync(path.join(ROOT, 'tokens', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (css.match(/:root[^{]*\{([\s\S]*?)\}/) || [])[1] || '';
  const o = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) o[m[1]] = m[2].trim();
  return o;
}
const have = { ...rootDecls('system.css'), ...rootDecls('modes.css'), ...rootDecls('brand.css') };
const resolve = name => {
  let v = have[name];
  if (v == null) return null;
  const pin = v.match(/^var\((--[a-z0-9-]+-pin),/);
  if (pin && have[pin[1]]) return have[pin[1]];
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (ref) return resolve(ref[1]);
  return v;
};
const norm = v => String(v).trim().toUpperCase();
const lit = v => /^#[0-9A-F]{3,8}$|^-?[\d.]+PX$/i.test(String(v).trim());

const rows = { same: [], different: [], derived: [], figmaOnly: [] };
for (const [name, fv] of Object.entries(want)) {
  const cv = resolve(name);
  if (cv == null) rows.figmaOnly.push(`${name} ${fv}`);
  else if (!lit(cv)) rows.derived.push(`${name} Figma ${fv}, code ${cv}`);
  else if (norm(cv) === norm(fv)) rows.same.push(name);
  else rows.different.push(`${name} Figma ${fv}, code ${cv}`);
}
console.log(`Figma file ${fig.figmaFile}, mode "${mode}", exported ${fig.exported}`);
console.log(`same: ${rows.same.length}`);
for (const [k, label] of [['different', 'DIFFERENT'], ['derived', 'worked out in code'], ['figmaOnly', 'only in Figma']]) {
  if (rows[k].length) { console.log(`${label}: ${rows[k].length}`); rows[k].forEach(r => console.log('  ' + r)); }
}
process.exit(process.argv.includes('--strict') && rows.different.length ? 1 : 0);
