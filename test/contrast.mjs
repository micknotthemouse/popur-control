// Checks the real colour tokens in docs/styles.css: text pairs >= 4.5:1, graphic pairs >= 3:1, light and dark.
// Usage: node test/contrast.mjs   (exits non-zero on any failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/styles.css'), 'utf8');

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}
function blockAfter(marker) {
  const i = css.indexOf(marker);
  if (i < 0) throw new Error('missing block: ' + marker);
  const open = css.indexOf('{', i);
  return css.slice(open + 1, css.indexOf('}', open));
}

const light = tokens(blockAfter(':root {'));
const dark = tokens(blockAfter(':root[data-theme="dark"]'));
const darkMedia = tokens(blockAfter(':root:not([data-theme="light"])'));

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground token, background token, what it is used for]
const TEXT = [
  ['text', 'bg', 'body text'], ['text', 'surface', 'card text'], ['text', 'surface-2', 'text on chips and code'],
  ['text', 'seg-active', 'selected segment'],
  ['text-2', 'bg', 'secondary text'], ['text-2', 'surface', 'secondary text on cards'], ['text-2', 'surface-2', 'inactive segments, disabled button'],
  ['accent', 'surface', 'links in cards'], ['accent', 'bg', 'links in sheets and rows'], ['accent', 'surface-2', 'links on chips'],
  ['on-accent', 'accent', 'primary button label'],
  ['bg', 'text', 'toast text'],
  ['danger', 'bg', 'tracking stopped link'], ['danger', 'surface', 'sign out, error text'],
  ['warn', 'bg', 'warning text'],
  ['full-text', 'full-bg', 'bin full hero text'], ['full-text-2', 'full-bg', 'bin full hero secondary text'],
];
const GRAPHIC = [
  ['accent', 'surface', "today's bar, switch on, ring"], ['bar', 'surface', 'other bars'],
  ['danger', 'surface', 'bin-full dot, alert icon'], ['control', 'surface', 'switch off track'],
  ['ok', 'surface-2', 'hero check icon'], ['ok', 'surface', 'status dot'], ['warn', 'surface', 'warning dot'],
  ['danger', 'surface-2', 'dot on chip'], ['warn', 'surface-2', 'dot on chip'], ['accent', 'surface-2', 'dot on chip'],
  ['text-2', 'surface-2', 'neutral hero icon'], ['full-text', 'full-bg', 'hero icon on full card'],
  ['control', 'surface-2', 'neutral dot on chip'],
];

let failures = 0;
function run(mode, t) {
  for (const [list, min, kind] of [[TEXT, 4.5, 'text'], [GRAPHIC, 3, 'graphic']]) {
    for (const [fg, bg, use] of list) {
      if (!t[fg] || !t[bg]) { console.log(`FAIL  ${mode} ${kind} ${fg} on ${bg}: token missing`); failures++; continue; }
      const r = ratio(t[fg], t[bg]);
      const ok = r >= min;
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${mode.padEnd(5)} ${kind.padEnd(7)} ${r.toFixed(2).padStart(5)}:1 (need ${min})  ${fg} on ${bg}  [${use}]`);
    }
  }
}
run('light', light);
run('dark', dark);

for (const k of Object.keys(dark)) {
  if (darkMedia[k] !== dark[k]) { console.log(`FAIL  dark tokens differ between data-theme and system preference: --${k}`); failures++; }
}
// The dark-media block carries the same tokens as the explicit data-theme block.
console.log(failures ? `\n${failures} contrast check(s) failed` : '\nall contrast checks passed');
process.exit(failures ? 1 : 0);
