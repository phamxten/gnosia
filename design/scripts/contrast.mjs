#!/usr/bin/env node
// WCAG contrast check for GNOSIA token pairs. Run: node scripts/contrast.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'tokens.css'), 'utf8');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function block(selector) {
  const m = new RegExp(`^${esc(selector)}[^{]*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  return Object.fromEntries(Array.from(m[1].matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g), x => [x[1], x[2]]));
}

function lum(h) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [la, lb] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}

const TEXT = 4.5, UI = 3.0;
const PAIRS = [
  ['text', 'bg', TEXT], ['text', 'surface', TEXT], ['text', 'surface-sunken', TEXT],
  ['text-muted', 'bg', TEXT], ['text-muted', 'surface', TEXT], ['text-muted', 'surface-sunken', TEXT],
  ['text-faint', 'surface', UI], ['text-faint', 'bg', UI],
  ['accent', 'surface', TEXT], ['accent', 'bg', TEXT], ['accent', 'accent-soft', TEXT],
  ['on-accent', 'accent', TEXT],
  ['success', 'surface', TEXT], ['success', 'success-soft', TEXT],
  ['warning', 'surface', TEXT], ['warning', 'warning-soft', TEXT],
  ['danger', 'surface', TEXT], ['danger', 'danger-soft', TEXT],
  ['border-strong', 'surface', 1.4],
  ['syn-keyword', 'editor-bg', TEXT], ['syn-string', 'editor-bg', TEXT], ['syn-number', 'editor-bg', TEXT],
  ['syn-function', 'editor-bg', TEXT], ['syn-comment', 'editor-bg', UI], ['syn-text', 'editor-bg', TEXT],
  ['syn-property', 'editor-bg', TEXT], ['text-faint', 'editor-bg', UI],
];
for (const ph of ['pahami', 'perkuat', 'kuis', 'uji'])
  PAIRS.push([`${ph}-ink`, 'surface', TEXT], [`${ph}-ink`, `${ph}-soft`, TEXT], [`${ph}-ink`, 'bg', TEXT], [`${ph}-fill`, 'surface', UI], [`${ph}-fill`, 'bg', UI]);

let fail = 0;
for (const [name, sel] of [['Paper', ':root'], ['Ink', ':root[data-theme="ink"]']]) {
  const t = block(sel);
  console.log(`\n${name}`);
  for (const [fg, bg, need] of PAIRS) {
    const r = ratio(t[fg], t[bg]);
    const ok = r >= need;
    if (!ok) fail++;
    console.log(`  ${ok ? 'ok ' : 'FAIL'} ${fg.padEnd(14)} on ${bg.padEnd(15)} ${r.toFixed(2).padStart(5)}  (need ${need.toFixed(1)})`);
  }
}
process.exit(fail ? 1 : 0);
