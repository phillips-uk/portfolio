'use strict';
// Design Spec v3, Part B9 step 7: moves the Phillips. pages' old palette onto the v3 token names, the way Before You Pay's
// colour audit did (Obsidian "Design Spec v3 - Colour Audit"). Run once per file; it rewrites <style> blocks and style=""
// attributes in HTML, or a whole .css file, choosing the token by what the colour is used for (text, fill or line).
//   node scripts/map-colours.cjs <file> [file...]       rewrite in place, then list anything it didn't know
// Kept for the record and for pages added later in the old palette; it is idempotent.
const fs = require('fs');

const isText = p => /^(color|caret-color|-webkit-text-fill-color)$/.test(p);
const isDeco = p => /^text-decoration/.test(p);
const isFill = p => /^(background|background-color|fill)$/.test(p);
const isLine = p => /^(border|outline|stroke)/.test(p) || p === 'box-shadow';

// old hex -> token, by property
const HEX = {
  '#1A1A1A': p => (isFill(p) || isLine(p)) ? 'var(--ink)' : 'var(--text)',
  '#985830': p => (isText(p) ? 'var(--brand-text)' : 'var(--brand)'),
  '#7A3F1F': () => 'var(--brand-hover)',
  '#F5EBD9': () => 'var(--brand-wash)',
  '#6B6B6B': () => 'var(--muted)',
  '#3A3A3A': p => isText(p) ? 'var(--text-2)' : 'var(--ink-line)',
  '#4A4A4A': () => 'var(--text-2)',
  '#2A2A2A': p => isText(p) ? 'var(--text-2)' : 'var(--ink-line)',
  '#FDF6EE': () => 'var(--bg)',
  '#FAFAF8': () => 'var(--surface-2)',
  '#FFFCF8': () => 'var(--surface-2)',
  '#FFFBF5': () => 'var(--surface-2)',
  '#E8D8C4': p => isText(p) ? 'var(--line-2)' : 'var(--line)',
  '#F0E6D5': () => 'var(--line-soft)',
  '#F0E5D2': () => 'var(--line-soft)',
  '#D9C6AE': () => 'var(--line-2)',
  '#241408': () => 'var(--ink)',
  '#D9A57E': () => 'var(--brand-on-ink)',
  '#D9925E': () => 'var(--brand-on-ink)',
  '#B87040': () => 'var(--brand-on-ink)',
  '#F2E6D7': () => 'var(--ink-text)',
  '#A0998E': () => 'var(--ink-muted)',
  '#8A8580': () => 'var(--muted)',
  '#8A6A4A': () => 'var(--brand-hover)',
  // status colours onto the spec's six tones (section 2)
  '#2E5F5C': p => isText(p) ? 'var(--ok)' : isFill(p) ? 'var(--ok-dot)' : 'var(--ok)',
  '#DCEAE8': () => 'var(--ok-wash)',
  '#BFD6D2': () => 'var(--ok-line)',
  '#4F7A4A': p => isText(p) ? 'var(--ok)' : 'var(--ok-dot)',
  '#9B3D3D': p => isText(p) ? 'var(--bad)' : isFill(p) ? 'var(--bad-dot)' : 'var(--bad)',
  '#B83A1F': p => isText(p) ? 'var(--bad)' : 'var(--bad-dot)',
  '#F5E3E3': () => 'var(--bad-wash)',
  '#E0BFBF': () => 'var(--bad-line)',
  '#4F5760': p => isText(p) ? 'var(--info)' : isFill(p) ? 'var(--info-dot)' : 'var(--info)',
  '#E4E7EB': () => 'var(--info-wash)',
  '#CFD4DA': p => isText(p) ? 'var(--line-2)' : 'var(--info-line)',
  '#F0F0F0': () => 'var(--off-wash)',
  '#F0EEEB': () => 'var(--off-wash)',
  '#D8D8D8': () => 'var(--line-2)',
  '#FFF': p => isText(p) ? '#fff' : 'var(--surface)',
  '#FFFFFF': p => isText(p) ? '#fff' : 'var(--surface)',
};
const pct = a => Math.round(parseFloat(a) * 100);
function rgba(p, r, g, b, a) {
  const k = `${r},${g},${b}`;
  if (k === '152,88,48') return `color-mix(in oklab, var(--brand) ${pct(a)}%, transparent)`;
  if (k === '217,165,126' || k === '217,146,94') return `color-mix(in oklab, var(--brand-on-ink) ${pct(a)}%, transparent)`;
  if (k === '122,63,31') return `color-mix(in oklab, var(--brand-hover) ${pct(a)}%, transparent)`;
  if (k === '26,26,26') return `rgba(20, 25, 31, ${a})`;
  if (k === '0,0,0' && isFill(p) && parseFloat(a) >= 0.3) return 'var(--scrim)';
  if (k === '255,255,255' && isText(p)) return parseFloat(a) >= 0.7 ? 'var(--ink-text)' : 'var(--ink-muted)';
  if (k === '255,255,255' && isFill(p) && parseFloat(a) >= 0.9) return `color-mix(in oklab, var(--surface) 88%, transparent)`;
  return null;   // leave it (white or black mixes for light and shade are fine)
}

function mapDecl(prop, value) {
  const p = prop.toLowerCase();
  let v = value;
  // the old dark gradient becomes the ink panel (ink with the brand's light)
  v = v.replace(/linear-gradient\(\s*135deg\s*,\s*#1A1A1A\s+0%\s*,\s*#241408\s+100%\s*\)/gi, 'var(--ink-panel)');
  v = v.replace(/linear-gradient\(\s*180deg\s*,\s*#fff(?:fff)?\s+0%\s*,\s*#FDF6EE\s+100%\s*\)/gi, 'linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%)');
  // amber-tinted shadows become the depth levels
  if (p === 'box-shadow' && /rgba\(\s*152\s*,\s*88\s*,\s*48/.test(v) && !/inset/.test(v)) v = /0\s+1px\s+4px/.test(v) ? 'var(--e1)' : 'var(--e2)';
  v = v.replace(/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b/g, h => { const f = HEX[h.toUpperCase()]; return f ? f(p) : h; });
  v = v.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g, (m, r, g, b, a) => rgba(p, r, g, b, a) || m);
  return v;
}

function mapCss(css) {
  return css.replace(/([\w-]+)(\s*:\s*)([^;{}]*)/g, (m, prop, sep, value) => {
    if (prop.startsWith('--')) return m;   // custom properties are dealt with by hand
    return prop + sep + mapDecl(prop, value);
  });
}

function mapFile(f) {
  const src = fs.readFileSync(f, 'utf8');
  let out;
  if (f.endsWith('.css')) out = mapCss(src);
  else {
    out = src.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (m, a, css, b) => {
      // leave the generated token block alone
      const i = css.indexOf('/* tokens:start'), j = css.indexOf('/* tokens:end */');
      if (i !== -1 && j !== -1) return a + mapCss(css.slice(0, i)) + css.slice(i, j) + mapCss(css.slice(j)) + b;
      return a + mapCss(css) + b;
    });
    out = out.replace(/(\sstyle=")([^"]*)(")/g, (m, a, css, b) => a + mapCss(css) + b);
  }
  if (out !== src) fs.writeFileSync(f, out);
  const left = new Set([...out.replace(/\/\* tokens:start[\s\S]*?tokens:end \*\//, '').matchAll(/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b/g)].map(m => m[0].toUpperCase()));
  return [...left];
}

if (require.main === module) {
  for (const f of process.argv.slice(2)) console.log(f, 'left:', mapFile(f).join(' ') || 'none');
}
module.exports = { mapCss, mapDecl };
