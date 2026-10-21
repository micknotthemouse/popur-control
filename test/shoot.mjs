// Screenshot tool: node test/shoot.mjs --url <url> --out <png> [--w 390] [--h 844] [--dark] [--full] [--wait ms] [--click css]...
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// Launch headless Edge and return {browser, context, page, issues}. issues collects console errors, page errors, CSP violations, failed requests.
export async function launch({ w = 390, h = 844, dark = false, scale = 2 } = {}) {
  const browser = await chromium.launch(fs.existsSync(EDGE) ? { channel: 'msedge', headless: true } : { executablePath: EDGE, headless: true });
  const context = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: scale,
    colorScheme: dark ? 'dark' : 'light', hasTouch: true, isMobile: true,
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error('CSP_VIOLATION ' + e.violatedDirective + ' blocked=' + e.blockedURI);
    });
  });
  const page = await context.newPage();
  const issues = [];
  page.on('console', (m) => { if (m.type() === 'error') issues.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => issues.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => issues.push(`requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`));
  return { browser, context, page, issues };
}

function parseArgs(argv) {
  const o = { w: 390, h: 844, dark: false, full: false, wait: 1500, click: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dark') o.dark = true;
    else if (a === '--full') o.full = true;
    else if (a === '--click') o.click.push(argv[++i]);
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  o.w = Number(o.w); o.h = Number(o.h); o.wait = Number(o.wait);
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.url || !o.out) { console.error('usage: --url <url> --out <png> [--w --h --dark --full --wait --click]'); process.exit(2); }
  const { browser, page, issues } = await launch(o);
  try {
    await page.goto(o.url, { waitUntil: 'load' });
    await page.waitForTimeout(o.wait);
    for (const sel of o.click) { await page.click(sel); await page.waitForTimeout(500); }
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    await page.screenshot({ path: o.out, fullPage: o.full });
    console.log(`saved ${o.out}`);
    console.log(issues.length ? `ISSUES (${issues.length}):\n` + issues.join('\n') : 'no console errors, page errors, CSP violations or failed requests');
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
