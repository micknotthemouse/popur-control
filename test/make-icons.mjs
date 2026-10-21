// Renders the PNG icons from docs/icons/*.svg with headless Edge (playwright).
// Usage: node test/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './shoot.mjs';

const ICONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/icons');

// [output file, source svg, size, transparent corners]
const JOBS = [
  ['icon-192.png', 'icon.svg', 192, true],
  ['icon-512.png', 'icon.svg', 512, true],
  ['icon-maskable-512.png', 'icon-maskable.svg', 512, false],
  ['apple-touch-icon-180.png', 'icon-maskable.svg', 180, false], // iOS rounds the corners itself
];

const { browser, context, page } = await launch({ w: 512, h: 512, scale: 1 });
try {
  for (const [out, src, size, transparent] of JOBS) {
    const svg = fs.readFileSync(path.join(ICONS, src), 'utf8');
    const b64 = Buffer.from(svg).toString('base64');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:transparent">` +
      `<img src="data:image/svg+xml;base64,${b64}" width="${size}" height="${size}" style="display:block"></body>`);
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({ path: path.join(ICONS, out), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', out, `${size}x${size}`);
  }
} finally {
  await context.close();
  await browser.close();
}
