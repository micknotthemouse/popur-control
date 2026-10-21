// End-to-end tests: headless Edge at phone size against the local mock (never the real Popur cloud).
// Usage: node test/e2e.mjs [filter]   (exits non-zero on any failure)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-server.mjs';
import { makeHistory } from './fixtures/make-history.mjs';
import { launch } from './shoot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'test/.tmp');
const filter = process.argv[2] || '';
const MD5 = crypto.createHash('md5').update('meow123').digest('hex');
const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://cloud.popur.com.cn wss://cloud.popur.com.cn https://raw.githubusercontent.com; base-uri 'none'; form-action 'none'";

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`);
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

const fixtures = {};
for (const mode of ['full', 'notsetup', 'stale']) {
  fixtures[mode] = path.join(TMP, 'e2e-' + mode);
  makeHistory({ out: fixtures[mode], mode, days: 30 });
}
const mocks = {
  full: await startMock({ port: 0, dataDir: fixtures.full, cleanMs: 3000 }),
  notsetup: await startMock({ port: 0, dataDir: fixtures.notsetup }),
  stale: await startMock({ port: 0, dataDir: fixtures.stale }),
};

const urlFor = (m) => `${m.url}/?api=${m.url}&wss=ws://localhost:${m.port}/mqtt&data=${m.url}/data/`;

// Opens a page against a mock, tracks problems, runs fn(ctx), then checks for violations.
async function scenario(name, { mock = 'full', scen = 'normal', dark = false, signedIn = true, keep = true, setup }, fn) {
  if (filter && !name.includes(filter)) return;
  const m = mocks[mock];
  m.setScenario(scen);
  const logBase = m.log().length;
  const { browser, context, page, issues } = await launch({ dark });
  const badHosts = new Set();
  let alerted = false;
  const allowed = new Set([`localhost:${m.port}`]);
  page.on('request', (r) => {
    const u = new URL(r.url());
    if ((u.protocol.startsWith('http') || u.protocol.startsWith('ws')) && !allowed.has(u.host)) badHosts.add(u.host);
  });
  page.on('dialog', async (d) => { alerted = true; await d.dismiss(); });
  const ctx = { page, context, mock: m, logSince: () => m.log().slice(logBase), url: urlFor(m) };
  try {
    if (setup) await setup(ctx);
    await page.goto(ctx.url, { waitUntil: 'load' });
    if (signedIn) await login(page, keep);
    else await page.waitForSelector('#bin-hero:not([data-state="loading"])', { timeout: 8000 });
    await fn(ctx);
    const bad = issues.filter((i) => !/Failed to load resource/.test(i) && !/ERR_ABORTED/.test(i));
    expect(bad.length === 0, 'page issues: ' + bad.join(' | '));
    expect(badHosts.size === 0, 'requests to non-allowlisted hosts: ' + [...badHosts].join(', '));
    expect(!alerted, 'an alert dialog fired (script injection)');
    record(name, true);
  } catch (e) {
    record(name, false, String(e.message || e).split('\n')[0]);
  } finally {
    await browser.close();
  }
}

async function login(page, keep = true) {
  await page.fill('#login-email', 'cat@example.com');
  await page.fill('#login-password', 'meow123');
  if (!keep) await page.click('#keep-signed-in');
  await page.click('#login-submit');
  await page.waitForSelector('#login-card', { state: 'hidden', timeout: 8000 });
  await page.waitForSelector('#bin-hero:not([data-state="loading"])', { timeout: 8000 });
}

const text = (page, sel) => page.locator(sel).first().innerText();
const publishes = (ctx) => ctx.logSince().filter((e) => e.kind === 'mqtt' && e.dir === 'publish');

// ---------------------------------------------------------------- tests
await scenario('signed-out hero comes from collector data', { signedIn: false }, async ({ page }) => {
  expect(await page.isVisible('#login-card'), 'login card should show');
  expect(await text(page, '#hero-title') === 'Bin has room', 'hero title: ' + await text(page, '#hero-title'));
  expect(/From tracking/.test(await text(page, '#hero-sub')), 'hero should say it comes from tracking');
  const before = await page.evaluate(() => !!(document.getElementById('login-card').compareDocumentPosition(document.getElementById('bin-hero')) & Node.DOCUMENT_POSITION_FOLLOWING));
  expect(before, 'login card must come above the hero');
  expect(await page.locator('#clean-btn').isDisabled(), 'clean must be disabled when signed out');
  expect(/Sign in/.test(await text(page, '#clean-reason')), 'disabled reason missing');
});

await scenario('login stores the hash only when keep-signed-in is on (on)', { keep: true }, async ({ page }) => {
  const dump = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(dump.includes(MD5), 'hash should be stored when keep is on');
  expect(!dump.includes('meow123'), 'plain password must never be stored');
});
await scenario('login stores the hash only when keep-signed-in is on (off)', { keep: false }, async ({ page }) => {
  const dump = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(!dump.includes(MD5), 'hash must not be stored when keep is off');
  expect(!dump.includes('meow123'), 'plain password must never be stored');
  expect(dump.includes('popurctl:session'), 'session should still be stored');
});

for (const dark of [false, true]) {
  await scenario(`bin full: hero first, theme colour, title (${dark ? 'dark' : 'light'})`, { scen: 'binFull', dark }, async ({ page }) => {
    await page.waitForTimeout(900); // entry animation
    expect(await page.getAttribute('#bin-hero', 'data-state') === 'full', 'hero state');
    expect(await text(page, '#hero-title') === 'Bin full – empty it', 'hero title: ' + await text(page, '#hero-title'));
    const ys = await page.evaluate(() => ['bin-hero', 'today-card', 'usage-card'].map((id) => document.getElementById(id).getBoundingClientRect().top));
    expect(ys[0] < ys[1] && ys[1] < ys[2], 'hero must be first: ' + ys.join(','));
    const w = await page.evaluate(() => { const r = document.getElementById('bin-hero').getBoundingClientRect(); return [r.left, r.right, innerWidth]; });
    expect(w[0] <= 0.5 && w[1] >= w[2] - 0.5, 'hero should be full-bleed on a phone: ' + w.join(','));
    const colors = await page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content.toUpperCase()));
    const want = dark ? '#7F1D1D' : '#B91C1C';
    expect(colors.every((c) => c === want), `theme-color should be ${want}: ${colors}`);
    expect(await page.title() === 'Bin full · Popur', 'title: ' + await page.title());
    expect(/may not finish/.test(await text(page, '#clean-reason')), 'full-bin warning on clean');
    expect(!(await page.locator('#clean-btn').isDisabled()), 'clean stays enabled when bin full');
  });
}

await scenario('box offline disables Clean with a reason; phone offline shows banner', { scen: 'offline' }, async ({ page, context }) => {
  expect(await page.locator('#clean-btn').isDisabled(), 'clean must be disabled');
  expect(/offline/i.test(await text(page, '#clean-reason')), 'reason: ' + await text(page, '#clean-reason'));
  expect(/Offline/.test(await text(page, '#status-text')), 'pill should say Offline');
  expect(/Last known/.test(await text(page, '#hero-title')), 'hero should say last known');
  await context.setOffline(true);
  await page.waitForSelector('#offline-banner:not([hidden])', { timeout: 4000 });
  await context.setOffline(false);
});

await scenario('two-tap confirm, ring expiry reverts, exact clean publish', {}, async (ctx) => {
  const { page } = ctx;
  await page.click('#clean-btn');
  expect(await text(page, '#clean-label') === 'Tap again to clean', 'first tap label');
  expect(/cat is out/.test(await text(page, '#clean-hint')), 'hint missing');
  expect(await page.isVisible('#clean-ring'), 'ring should show');
  await page.waitForTimeout(4600);
  expect(await text(page, '#clean-label') === 'Clean now', 'confirm should revert after 4 s');
  expect(publishes(ctx).length === 0, 'nothing may be published without the second tap');
  await page.click('#clean-btn');
  await page.click('#clean-btn');
  await page.waitForSelector('#progress-card:not([hidden])');
  await page.waitForFunction(() => document.getElementById('step-sent').dataset.state !== 'todo', null, { timeout: 8000 });
  const pubs = publishes(ctx);
  expect(pubs.length === 1, 'expected one publish, got ' + pubs.length);
  expect(pubs[0].topic === 'devcrpc/action/dev_test_789', 'topic ' + pubs[0].topic);
  const p = JSON.parse(pubs[0].payload);
  expect(p.method === 'action' && p.from === 'remote' && Number.isInteger(p.id) && Math.abs(p.id - Date.now() / 1000) < 60, 'payload head ' + pubs[0].payload);
  expect(JSON.stringify(p.params) === JSON.stringify({ did: '0', sid: 2, aid: 1, in: [] }), 'payload params ' + JSON.stringify(p.params));
});

await scenario('progress reaches Done with live updates', {}, async ({ page }) => {
  await page.click('#clean-btn');
  await page.click('#clean-btn');
  await page.waitForFunction(() => document.getElementById('step-cleaning').dataset.state === 'active', null, { timeout: 10000 });
  expect(await text(page, '#progress-title') !== 'Done', 'must not claim Done while cleaning');
  await page.waitForSelector('#progress-card[data-outcome="done"]', { timeout: 20000 });
  expect(await text(page, '#progress-title') === 'Done', 'title ' + await text(page, '#progress-title'));
  expect(await page.getAttribute('#step-done', 'data-state') === 'done', 'done step');
});

await scenario('subscribe refused: polling only, ends at "Cleaning counted"', { scen: 'subscribeRefused' }, async ({ page }) => {
  expect(await page.isHidden('#live-dot'), 'no Live dot when subscribe is refused');
  expect(await page.isHidden('#api-banner'), 'refused subscribe must not show an error');
  await page.click('#clean-btn');
  await page.click('#clean-btn');
  await page.waitForSelector('#progress-card[data-outcome="counted"]', { timeout: 30000 });
  expect(await text(page, '#progress-title') === 'Cleaning counted', 'title ' + await text(page, '#progress-title'));
  expect(/finishes on its own/.test(await text(page, '#progress-text')), 'copy ' + await text(page, '#progress-text'));
  expect(await page.isHidden('#api-banner'), 'no error banner');
});

await scenario('manual switch publishes pid 3 with values 1 then 0', {}, async (ctx) => {
  const { page } = ctx;
  await page.click('#settings-btn');
  await page.click('#pause-switch');
  await page.waitForFunction(() => document.getElementById('pause-switch').getAttribute('aria-checked') === 'true');
  await page.waitForTimeout(700);
  await page.click('#pause-switch');
  await page.waitForFunction(() => document.getElementById('pause-switch').getAttribute('aria-checked') === 'false');
  await page.waitForTimeout(700);
  const attr = publishes(ctx).filter((e) => e.topic === 'devcrpc/attr/dev_test_789').map((e) => JSON.parse(e.payload));
  expect(attr.length === 2, 'expected 2 attr publishes, got ' + attr.length);
  const vals = attr.map((a) => a.params[0]);
  expect(vals.every((v) => v.pid === 3 && v.sid === 2 && v.did === '0'), 'param shape ' + JSON.stringify(vals));
  expect(vals[0].value === 1 && vals[1].value === 0, 'values ' + vals.map((v) => v.value));
  expect(attr.every((a) => a.method === 'set_properties' && a.from === 'remote'), 'method/from');
});

await scenario('silent re-login after the token expires', { scen: 'tokenExpired' }, async (ctx) => {
  const { page } = ctx;
  await page.waitForFunction(() => !document.getElementById('bin-hero').matches('[data-state="loading"]'));
  const logins = ctx.logSince().filter((e) => e.kind === 'rest' && e.path === '/uapi/auth');
  expect(logins.length >= 2, 'expected a second login, saw ' + logins.length);
  expect(await page.isHidden('#login-card'), 'must stay signed in');
  expect(await text(page, '#hero-title') === 'Bin has room', 'hero ' + await text(page, '#hero-title'));
});

await scenario('evicted: shows "Signed in somewhere else"', { scen: 'evicted' }, async ({ page }) => {
  for (let i = 0; i < 8; i++) {
    if (await page.isVisible('#evicted-card')) break;
    await page.click('#updated-btn');
    await page.waitForTimeout(900);
  }
  await page.waitForSelector('#evicted-card:not([hidden])', { timeout: 3000 });
  expect(await text(page, '#evicted-title') === 'Signed in somewhere else', 'title');
  expect(await page.isVisible('#evicted-signin'), 'sign in again button');
  expect(await page.locator('#clean-btn').isDisabled(), 'clean disabled when evicted');
});

await scenario('notsetup: setup state and a decryptable POPUR1 setup code', { mock: 'notsetup' }, async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  expect(await page.isVisible('#usage-setup'), 'setup state should show');
  expect(/History tracking isn't set up yet/.test(await text(page, '#usage-setup')), 'wording');
  expect(!(await page.isVisible('#usage-empty')), 'must differ from "no history yet"');
  await page.click('#setup-open-usage');
  await page.waitForSelector('#setup-code-view:not([hidden])');
  const code = await page.inputValue('#setup-code');
  expect(/^POPUR1\.[A-Za-z0-9_-]{100,}$/.test(code), 'code shape ' + code.slice(0, 20));
  expect(/Paste this code into your chat with Claude/.test(await text(page, '#setup-code-view')), 'instruction');
  await page.click('#setup-copy');
  await page.waitForFunction(() => /Copied/.test(document.getElementById('setup-copy-status').textContent));
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (clip !== null) expect(clip === code, 'clipboard should hold the code');
  const pem = path.join(ROOT, 'secrets/handoff-private.pem');
  if (fs.existsSync(pem)) {
    const b = Buffer.from(code.slice(7).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const plain = crypto.privateDecrypt({ key: fs.readFileSync(pem), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, b);
    const o = JSON.parse(plain.toString('utf8'));
    expect(o.v === 1 && o.e === 'cat@example.com' && o.h === MD5 && Math.abs(o.t - Date.now() / 1000) < 120, 'decrypted payload shape');
  }
});

await scenario('stale tracking shows "Tracking stopped" linking to the workflow', { mock: 'stale', signedIn: false }, async ({ page }) => {
  expect(await text(page, '#hero-title') === 'Bin status unknown', 'old readings must not claim room: ' + await text(page, '#hero-title'));
  const a = page.locator('#tracking-link');
  expect(await a.isVisible(), 'link should show');
  expect(/Tracking stopped – tap to turn it back on/.test(await a.innerText()), 'link text');
  expect((await a.getAttribute('href')).endsWith('/actions/workflows/collect.yml'), 'href ' + await a.getAttribute('href'));
});

await scenario('device name with markup renders inert', {
  signedIn: false,
  setup: async ({ page }) => {
    await page.route('**/uapi/home_details/*', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.data.devicelist[0].name = '<img src=x onerror=alert(1)>';
      await route.fulfill({ response: res, body: JSON.stringify(body) });
    });
  },
}, async ({ page }) => {
  await login(page);
  expect(await text(page, '#box-name') === '<img src=x onerror=alert(1)>', 'name text: ' + await text(page, '#box-name'));
  expect(await page.locator('#top img, main img, #settings-sheet img').count() === 0, 'no img elements may be created');
  await page.click('#settings-btn');
  expect(await page.locator('#settings-sheet img').count() === 0, 'no img in settings');
});

await scenario('charts: summaries and hidden tables exist', {}, async ({ page }) => {
  const info = await page.evaluate(() => ({
    bars: document.querySelectorAll('#usage-chart svg.chart[role="img"][aria-label]').length,
    barRows: document.querySelectorAll('#usage-chart table.sr-only tbody tr').length,
    hours: document.querySelectorAll('#hours-chart svg.chart[role="img"][aria-label]').length,
    hourRows: document.querySelectorAll('#hours-chart table.sr-only tbody tr').length,
  }));
  expect(info.bars === 1 && info.barRows === 7, 'bar chart ' + JSON.stringify(info));
  expect(info.hours === 1 && info.hourRows === 24, 'hours chart ' + JSON.stringify(info));
  await page.click('#range-30');
  expect(await page.locator('#usage-chart table.sr-only tbody tr').count() === 30, '30 day rows');
  await page.click('#usage-chart svg.chart g[role="button"] >> nth=28');
  await page.waitForSelector('#day-panel:not([hidden])');
  expect(await text(page, '#day-name') !== '', 'day panel shows a day');
});

async function targetReport(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href], summary, [role="switch"], [role="radio"], input, textarea')) {
      if (el.closest('svg')) continue; // chart bars have day steppers as accessible alternatives
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.matches('.skip')) continue; // visible only when focused
      if (r.width < 47.5 || r.height < 47.5) out.push(`${el.id || el.className || el.tagName}:${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

await scenario('tap targets are at least 48 px (signed in, sheets)', {}, async ({ page }) => {
  let bad = await targetReport(page);
  expect(bad.length === 0, 'main: ' + bad.join(', '));
  await page.click('#range-30');
  await page.click('#usage-chart svg.chart g[role="button"] >> nth=28');
  bad = await targetReport(page);
  expect(bad.length === 0, 'day panel: ' + bad.join(', '));
  await page.click('#settings-btn');
  await page.click('#advanced > summary');
  await page.click('#diagnostics > summary');
  bad = await targetReport(page);
  expect(bad.length === 0, 'settings: ' + bad.join(', '));
});
await scenario('tap targets are at least 48 px (signed out)', { signedIn: false, mock: 'notsetup' }, async ({ page }) => {
  const bad = await targetReport(page);
  expect(bad.length === 0, bad.join(', '));
  await page.click('#settings-btn');
  const bad2 = await targetReport(page);
  expect(bad2.length === 0, 'settings: ' + bad2.join(', '));
});

await scenario('manifest and icons load; page metadata', { signedIn: false }, async ({ page, mock }) => {
  const get = async (p) => { const r = await fetch(mock.url + '/' + p); return { r, buf: Buffer.from(await r.arrayBuffer()) }; };
  const man = JSON.parse((await get('manifest.webmanifest')).buf.toString('utf8'));
  expect(man.start_url === './' && man.scope === './' && man.display === 'standalone', 'manifest scope/start/display');
  expect(man.icons.every((i) => !i.src.startsWith('/')), 'icon paths must be relative');
  const sizes = { 'icon-192.png': 192, 'icon-512.png': 512, 'icon-maskable-512.png': 512 };
  for (const i of man.icons) {
    const { r, buf } = await get(i.src);
    expect(r.status === 200, i.src + ' status ' + r.status);
    if (i.src.endsWith('.png')) {
      const want = sizes[path.basename(i.src)];
      expect(buf.readUInt32BE(16) === want && buf.readUInt32BE(20) === want, i.src + ' dimensions');
    }
  }
  const a = await get('icons/apple-touch-icon-180.png');
  expect(a.r.status === 200 && a.buf.readUInt32BE(16) === 180, 'apple touch icon');
  const meta = await page.evaluate(() => ({
    manifest: !!document.querySelector('link[rel="manifest"][href="manifest.webmanifest"]'),
    apple: !!document.querySelector('link[rel="apple-touch-icon"]'),
    viewport: document.querySelector('meta[name="viewport"]').content,
    themeMetas: document.querySelectorAll('meta[name="theme-color"]').length,
  }));
  expect(meta.manifest && meta.apple && /viewport-fit=cover/.test(meta.viewport) && meta.themeMetas >= 2, JSON.stringify(meta));
  expect(fs.existsSync(path.join(ROOT, 'docs/.nojekyll')), '.nojekyll');
});

if (!filter || 'static'.includes(filter)) {
  const name = 'static checks: CSP meta exact, no inline script/style/handlers';
  try {
    const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
    expect(csp && csp[1] === EXPECTED_CSP, 'CSP meta differs from design-final #12');
    expect(!/\sstyle\s*=/.test(html), 'inline style attribute in index.html');
    expect(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline script in index.html');
    expect(!/\son[a-z]+\s*=/i.test(html), 'inline event handler in index.html');
    const app = fs.readFileSync(path.join(ROOT, 'docs/app.js'), 'utf8');
    expect(!/setAttribute\(\s*['"]style['"]/.test(app), 'setAttribute style in app.js');
    record(name, true);
  } catch (e) { record(name, false, e.message); }
}

for (const m of Object.values(mocks)) await m.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
