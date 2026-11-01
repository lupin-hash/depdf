const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function textPdf() {
  const stream = 'BT /F1 24 Tf 60 660 Td (Alpha) Tj 200 0 Td (Bravo) Tj 200 0 Td (Charlie) Tj -400 -200 Td (Delta Echo Foxtrot) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test('PDF viewer interactions (real bundled PDF engine; simulated Android clipboard)', async t => {
  const root = path.resolve(__dirname, '../www');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try { const data = fs.readFileSync(file); res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(data); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, hasTouch: true });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.copies = [];
    window.AndroidBridge = { getVersion: () => '1.0', takeIncomingName: () => '', syncAppearance: () => {}, copyText: text => { window.copies.push(text); return true; } };
    // Observe real word extraction without replacing any worker behavior.
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args); this.requests = new Map();
        this.addEventListener('message', e => { if (this.requests.get(e.data.id) === 'words' && e.data.ok) window.testWords = JSON.parse(e.data.json).lines.flatMap(l => l[4]); });
      }
      postMessage(message, ...args) { this.requests.set(message.id, message.cmd); return super.postMessage(message, ...args); }
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('#boot').hidden, { timeout: 45000 });
  await page.locator('#file-input').setInputFiles({ name: 'selection.pdf', mimeType: 'application/pdf', buffer: textPdf() });
  await page.waitForFunction(() => window.testWords?.length === 6 && document.body.classList.contains('viewer-open'));
  await page.locator('#prev-img').evaluate(img => img.decode());

  await t.test('fit view keeps the entire page inside the stage', async () => {
    const img = await page.locator('#prev-img').boundingBox(), stage = await page.locator('#stage').boundingBox();
    assert(img.width <= stage.width + 1); assert(img.x >= stage.x - 1); assert(img.x + img.width <= stage.x + stage.width + 1);
  });

  async function word(name) {
    return page.evaluate(name => {
      const w = window.testWords.find(w => w[4] === name), r = document.querySelector('#prev-img').getBoundingClientRect();
      const stage = document.querySelector('#stage').getBoundingClientRect();
      return { x: Math.max(stage.left + 4, Math.min(stage.right - 4, r.left + (w[0] + w[2]) / 2 * r.width)), y: r.top + (w[1] + w[3]) / 2 * r.height };
    }, name);
  }
  async function dock(x, y) {
    await page.locator('#bubble').evaluate((b, { x, y }) => {
      const h = b.parentElement.getBoundingClientRect();
      Object.assign(b.style, { left: `${x - h.left - b.offsetWidth / 2}px`, top: `${y - h.top - b.offsetHeight / 2}px`, right: 'auto', bottom: 'auto', transform: '' });
    }, { x, y });
  }
  const copyCount = () => page.evaluate(() => window.copies.length);
  const lastCopy = () => page.evaluate(() => window.copies.at(-1));

  await t.test('eraser selects only touched words, skips untouched words, and copies on release', async () => {
    const a = await word('Alpha'), c = await word('Charlie');
    await dock(a.x, a.y - 90);
    await page.mouse.move(a.x, a.y - 90); await page.mouse.down();
    await page.mouse.move(a.x, a.y, { steps: 6 });
    await page.mouse.move(a.x, a.y - 90, { steps: 6 });
    await page.mouse.move(c.x, c.y - 90, { steps: 12 });
    await page.mouse.move(c.x, c.y, { steps: 6 });
    assert.equal(await copyCount(), 0);
    await page.mouse.up();
    await page.waitForFunction(() => window.copies.length === 1);
    assert.deepEqual((await lastCopy()).split(/\s+/), ['Alpha', 'Charlie']);
    assert.equal(await page.locator('#selrects .hl').count(), 2);
    assert.equal(await page.locator('.modal:not([hidden])').count(), 0);
  });
  await t.test('fast eraser movement selects intermediate words without duplicates', async () => {
    const a = await word('Alpha'), c = await word('Charlie');
    await dock(a.x, a.y - 90);
    await page.mouse.move(a.x, a.y - 90); await page.mouse.down();
    await page.mouse.move(a.x, a.y); await page.mouse.move(c.x, c.y); await page.mouse.move(a.x, a.y); await page.mouse.up();
    assert.deepEqual((await lastCopy()).split(/\s+/), ['Alpha', 'Bravo', 'Charlie']);
    await page.waitForFunction(() => document.querySelectorAll('#selrects .hl').length === 3);
  });
  await t.test('cancelled and blank strokes do not change the clipboard', async () => {
    const count = await copyCount(), a = await word('Alpha');
    await dock(a.x, a.y - 90); await page.mouse.move(a.x, a.y - 90); await page.mouse.down(); await page.mouse.move(a.x, a.y);
    await page.locator('#bubble').dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
    assert.equal(await copyCount(), count);
    await dock(160, 100); await page.mouse.move(160, 100); await page.mouse.down(); await page.mouse.move(230, 100); await page.mouse.up();
    assert.equal(await copyCount(), count);
  });
  await t.test('tapping the eraser still opens cleaning options', async () => {
    await page.locator('#bubble').click();
    await page.waitForFunction(() => document.querySelector('.modal:not([hidden])'));
    await page.keyboard.press('Escape');
  });
  await t.test('text selection handles remain stable while extending selection; Copy uses the native bridge', async () => {
    const a = await word('Alpha'), c = await word('Charlie');
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(c.x, c.y, { steps: 10 }); await page.mouse.up();
    await page.locator('#sel-copy').waitFor({ state: 'visible' });
    const handle = await page.locator('.sel-handle').last().elementHandle();
    const h = await handle.boundingBox(), delta = await word('Delta');
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
    await page.mouse.move(delta.x, delta.y + 18, { steps: 8 }); await page.mouse.up();
    assert(await handle.evaluate(h => h.isConnected));
    await page.locator('#sel-copy').click();
    assert.equal(await lastCopy(), 'Alpha\nBravo\nCharlie\nDelta');
  });
  async function scaleSamples(key) {
    await page.evaluate(() => { window.zoomSamples = []; let n = 0; const frame = () => { window.zoomSamples.push(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('#zoomwrap')).transform).a); if (++n < 22) requestAnimationFrame(frame); }; requestAnimationFrame(frame); });
    await page.keyboard.press(key);
    await page.waitForFunction(() => window.zoomSamples.length === 22);
    return page.evaluate(() => window.zoomSamples);
  }
  await t.test('zoom in and out animate through intermediate scales', async () => {
    const up = await scaleSamples('+');
    assert(new Set(up.map(n => n.toFixed(3))).size > 3); assert(up.at(-1) > 1.3);
    const down = await scaleSamples('-');
    assert(new Set(down.map(n => n.toFixed(3))).size > 3); assert(Math.abs(down.at(-1) - 1) < 0.01);
  });
  await t.test('selection stays accurate after zooming', async () => {
    await scaleSamples('+');
    const a = await word('Alpha'), c = await word('Charlie');
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(c.x, c.y, { steps: 12 }); await page.mouse.up();
    await page.locator('#sel-copy').click(); assert.deepEqual((await lastCopy()).split(/\s+/), ['Alpha', 'Bravo', 'Charlie']);
  });
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
  await t.test('touch eraser gesture copies only when the finger is released', async () => {
    await page.keyboard.press('0');
    const a = await word('Alpha'), c = await word('Charlie'), count = await copyCount();
    await dock(a.x, a.y - 90);
    await touch('touchStart', [[a.x, a.y - 90, 1]]);
    await touch('touchMove', [[a.x, a.y, 1]]);
    await touch('touchMove', [[c.x, c.y, 1]]);
    assert.equal(await copyCount(), count);
    await touch('touchEnd', []);
    await page.waitForFunction(n => window.copies.length === n + 1, count);
    assert.deepEqual((await lastCopy()).split(/\s+/), ['Alpha', 'Bravo', 'Charlie']);
  });
  await t.test('two-finger pinch zooms and subsequent touch panning moves the page', async () => {
    await page.locator('#sel-done').click(); await page.keyboard.press('0');
    await touch('touchStart', [[180, 450, 1], [232, 450, 2]]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [[180 - i * 5, 450, 1], [232 + i * 5, 450, 2]]);
    await touch('touchEnd', []);
    await page.waitForFunction(() => Number(document.querySelector('#zoomwrap').style.getPropertyValue('--zs')) > 2);
    assert.equal(await page.locator('#selbar').isVisible(), false);
    const before = await page.locator('#zoomwrap').evaluate(w => new DOMMatrixReadOnly(getComputedStyle(w).transform).f);
    await touch('touchStart', [[206, 480, 1]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[206, 480 - i * 15, 1]]);
    await touch('touchEnd', []);
    await page.waitForFunction(before => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('#zoomwrap')).transform).f < before - 50, before);
  });
  await t.test('batch items keep their existing eraser behavior without auto-copy', async () => {
    await page.locator('#viewer-back').click();
    await page.locator('#batch-input').setInputFiles(['batch-one.pdf', 'batch-two.pdf'].map(name => ({ name, mimeType: 'application/pdf', buffer: textPdf() })));
    await page.waitForFunction(() => document.querySelectorAll('#batch-list img').length === 2);
    await page.evaluate(() => { window.testWords = null; });
    await page.locator('#batch-list > li').first().click();
    await page.waitForFunction(() => window.testWords?.length === 6 && !document.querySelector('#card-preview').hidden);
    const a = await word('Alpha'), c = await word('Charlie'), count = await copyCount();
    await dock(a.x, a.y - 90); await page.mouse.move(a.x, a.y - 90); await page.mouse.down();
    await page.mouse.move(a.x, a.y); await page.mouse.move(c.x, c.y); await page.mouse.up();
    assert.equal(await copyCount(), count);
  });
  await t.test('no uncaught page errors', () => assert.deepEqual(errors, []));
});
