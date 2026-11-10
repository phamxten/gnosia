#!/usr/bin/env node
// Regenerate tokens.json from tokens.css (single source of truth). Run: node scripts/build-tokens-json.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'tokens.css'), 'utf8');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function block(sel) {
  const m = new RegExp(`^${esc(sel)}[^{]*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  return Object.fromEntries(Array.from(m[1].matchAll(/--([\w-]+):\s*([^;]+);/g), x => [x[1], x[2]]));
}

const paper = block(':root'), ink = block(':root[data-theme="ink"]');
const scalePrefix = ['font-', 'fs-', 'lh-', 'fw-', 'tracking-', 'measure', 'space-', 'radius-', 'control-', 'rail-', 'sidebar-', 'topbar-', 'contextbar-', 'tabs-', 'statusbar-', 'panel-', 'dur-', 'ease-', 'spring-', 'z-'];
const isScale = k => scalePrefix.some(p => k.startsWith(p));
const pick = (d, keep) => Object.fromEntries(Object.entries(d).filter(([k]) => keep(k)).map(([k, v]) => [k, v.trim()]));
const out = {
  $schema: 'GNOSIA design tokens v2 — generated from tokens.css; do not edit by hand',
  theme: { paper: pick(paper, k => !isScale(k)), ink: pick(ink, k => !isScale(k)) },
  scale: pick(paper, isScale),
  phases: Object.fromEntries(['pahami', 'perkuat', 'kuis', 'uji'].map(ph => [ph, Object.fromEntries(['ink', 'fill', 'soft', 'line'].map(t => [t, { paper: paper[`${ph}-${t}`], ink: ink[`${ph}-${t}`] }]))])),
  component: {
    'button.press.lip': '3px (color-mix of button bg 62% with black)',
    'choice.radius': '14px', 'choice.border-bottom': '4px',
    'scene.radius': 'var(--radius-2xl)', 'scene.padding': '40px 44px (24px 20px on mobile)',
    'codecard.radius': 'var(--radius-xl)', 'codecard.font': 'JetBrains Mono 14–15 / 1.75, ligatures off',
    'phase-ring.gap': '3.5% of circumference between arcs', 'phase-ring.linecap': 'round',
    'player-foot.min-height': '88px (76px mobile)',
    'nosi.sizes': { sm: '40px', md: '64px', lg: '120px', xl: '180px' },
  },
};
writeFileSync(join(root, 'tokens.json'), JSON.stringify(out, null, 2) + '\n');
console.log('tokens.json:', Object.keys(out.theme.paper).length, 'paper,', Object.keys(out.theme.ink).length, 'ink,', Object.keys(out.scale).length, 'scale tokens');
