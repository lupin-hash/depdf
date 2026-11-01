const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function textPdf({ rich = false, pages = 1 } = {}) {
  const stream = 'BT /F1 24 Tf 60 660 Td (Alpha) Tj 200 0 Td (Bravo) Tj 200 0 Td (Charlie) Tj -400 -200 Td (Delta Echo Foxtrot) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  if (rich) {
    objects[0] = '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(notes.txt) 9 0 R] >> >> >>';
    objects[2] = objects[2].replace('/Contents 4 0 R', '/Annots [7 0 R 8 0 R] /Contents 4 0 R');
    objects.push('<< /Title (Analysis example) /Author (<img src=x onerror=globalThis.injected=1>) >>',
      '<< /Type /Annot /Subtype /Link /Rect [60 390 180 410] /A << /S /URI /URI (https://example.com/report) >> >>',
      '<< /Type /Annot /Subtype /Text /Rect [400 400 420 420] /Contents (Reviewer note example) /T (Reviewer) >>',
      '<< /Type /Filespec /F (notes.txt) /EF << /F 10 0 R >> >>',
      '<< /Type /EmbeddedFile /Length 5 >>\nstream\nnotes\nendstream');
  }
  const kids = ['3 0 R'];
  for (let i = 1; i < pages; i++) { objects.push(objects[2]); kids.push(objects.length + ' 0 R'); }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${rich ? "/Info 6 0 R" : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
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
    window.AndroidBridge = { getVersion: () => '1.0', checkUpdate: () => {}, takeIncomingName: () => '', syncAppearance: () => {}, copyText: text => { window.copies.push(text); return true; } };
    // Observe real word extraction without replacing any worker behavior.
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args); this.requests = new Map(); window.viewerWorker = this;
        let testId = -1;
        window.engineRpc = (cmd, payload) => new Promise((resolve, reject) => {
          const id = testId--;
          const receive = e => { if (e.data.id !== id) return; this.removeEventListener('message', receive); e.data.ok ? resolve(e.data) : reject(new Error(e.data.error)); };
          this.addEventListener('message', receive); this.postMessage({ id, cmd, ...payload });
        });
        this.addEventListener('message', e => { if (this.requests.get(e.data.id) === 'words' && e.data.ok) window.testWords = JSON.parse(e.data.json).lines.flatMap(l => l[4]); });
      }
      postMessage(message, ...args) { this.requests.set(message.id, message.cmd); if (message.job?.kind === 'analyze') window.analysisRequest = message.job; return super.postMessage(message, ...args); }
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('#boot').hidden, { timeout: 45000 });
  await t.test('redesigned home stays usable on phones and wide screens without the launcher icon or old tagline', async () => {
    assert.equal(await page.locator('.top img').count(), 0);
    assert(!(await page.locator('#app').textContent()).includes('for data extraction'));
    for (const width of [320, 412, 960]) {
      await page.setViewportSize({ width, height: 915 });
      assert(await page.locator('#m-upload').isVisible()); assert(await page.locator('#m-batch').isVisible());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.setViewportSize({ width: 412, height: 915 });
    if (process.env.UI_SCREENSHOTS_DIR) { fs.mkdirSync(process.env.UI_SCREENSHOTS_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.UI_SCREENSHOTS_DIR, 'home-light.png'), fullPage: true, animations: 'disabled' }); }
  });
  await t.test('settings contain credits and a readable permission/responsibility disclaimer in light and dark themes', async () => {
    await page.locator('#m-settings').click();
    assert.equal(await page.locator('#credits .developer-credit strong').textContent(), 'DePDF developer');
    for (const project of ['PyMuPDF', 'Pyodide', 'Capacitor']) assert((await page.locator('#credits').textContent()).includes(project));
    for (const theme of ['Dark', 'Light']) {
      await page.locator('.theme-chip').filter({ hasText: new RegExp('^' + theme + '$') }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (process.env.UI_SCREENSHOTS_DIR) await page.screenshot({ path: path.join(process.env.UI_SCREENSHOTS_DIR, 'settings-' + theme.toLowerCase() + '.png'), fullPage: true, animations: 'disabled' });
    }
    await page.locator('#open-disclaimer').click();
    const copy = await page.locator('#modal-disclaimer').textContent();
    for (const text of ['explicit permission', 'developer is not liable', 'applicable law', 'Keep a backup']) assert(copy.includes(text));
    assert(await page.locator('#modal-disclaimer .modal-card').evaluate(c => c.scrollWidth <= c.clientWidth + 1));
    if (process.env.UI_SCREENSHOTS_DIR) await page.screenshot({ path: path.join(process.env.UI_SCREENSHOTS_DIR, 'disclaimer.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.locator('.theme-chip').filter({ hasText: /^System$/ }).click();
    await page.locator('#back-btn').click();
  });
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

  await t.test('dragging the eraser over words only moves the button and never selects or copies text', async () => {
    const a = await word('Alpha'), c = await word('Charlie'), count = await copyCount();
    await dock(a.x, a.y - 90);
    const before = await page.locator('#bubble').boundingBox();
    await page.mouse.move(a.x, a.y - 90); await page.mouse.down();
    await page.mouse.move(a.x, a.y, { steps: 6 }); await page.mouse.move(c.x, c.y, { steps: 10 }); await page.mouse.up();
    const after = await page.locator('#bubble').boundingBox();
    assert(Math.abs(after.x - before.x) > 10 || Math.abs(after.y - before.y) > 10);
    assert.equal(await copyCount(), count);
    assert.equal(await page.locator('#selrects .hl').count(), 0);
    assert.equal(await page.locator('.modal:not([hidden])').count(), 0);
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
  await t.test('touch-dragging the eraser leaves the clipboard and text selection unchanged', async () => {
    await page.keyboard.press('0');
    const a = await word('Alpha'), c = await word('Charlie'), count = await copyCount();
    await dock(a.x, a.y - 90);
    await touch('touchStart', [[a.x, a.y - 90, 1]]);
    await touch('touchMove', [[a.x, a.y, 1]]);
    await touch('touchMove', [[c.x, c.y, 1]]);
    assert.equal(await copyCount(), count);
    await touch('touchEnd', []);
    assert.equal(await copyCount(), count);
    assert.equal(await page.locator('#selrects .hl').count(), 0);
  });
  await t.test('two-finger pinch zooms and subsequent touch panning moves the page', async () => {
    if (await page.locator('#sel-done').isVisible()) await page.locator('#sel-done').click();
    await page.keyboard.press('0');
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
  const richPdf = textPdf({ rich: true });
  await t.test('analysis cards show affected text and pages without changing the original PDF', async () => {
    await page.reload(); await page.waitForFunction(() => document.querySelector('#boot').hidden);
    await page.locator('#file-input').setInputFiles({ name: 'analysis-example.pdf', mimeType: 'application/pdf', buffer: richPdf });
    await page.waitForFunction(() => window.testWords?.length === 6 && document.body.classList.contains('viewer-open'));
    await page.evaluate(() => { document.querySelector('#top').value = '25'; });
    await page.locator('#bubble').click();
    await page.waitForFunction(() => Date.now() - document.querySelector('#modal-opts')._t > 420);
    await page.locator('#o-analyze').click();
    await page.locator('#modal-analysis').waitFor({ state: 'visible' });
    const card = page.locator('#an-grid').getByRole('button', { name: /Text to remove/ });
    await card.click();
    assert.equal(await card.getAttribute('aria-expanded'), 'true');
    const details = await page.locator('#an-detail-list').textContent();
    for (const text of ['Page 1', 'Alpha', 'Bravo', 'Charlie']) assert(details.includes(text));
    assert(!details.includes('Delta')); assert((await page.locator('#an-detail-description').textContent()).includes('nothing has been removed yet'));
    const bytes = await page.evaluate(async () => Array.from(new Uint8Array((await window.engineRpc('get', { path: window.analysisRequest.input })).buffer)));
    assert.deepEqual(bytes, Array.from(richPdf));
    const cardBox = await page.locator('#modal-analysis .modal-card').evaluate(card => ({ width: card.clientWidth, scroll: card.scrollWidth }));
    assert(cardBox.scroll <= cardBox.width + 1);
    if (process.env.VIEWER_SCREENSHOT) await page.screenshot({ path: process.env.VIEWER_SCREENSHOT });
    await page.locator('#an-detail-close').click();
    assert.equal(await card.getAttribute('aria-expanded'), 'false');
    assert(await card.evaluate(button => document.activeElement === button));
  });
  await t.test('summary cards explain links, notes, attachments and properties safely', async () => {
    await page.locator('#an-grid').getByRole('button', { name: /Links/ }).click();
    assert((await page.locator('#an-detail-description').textContent()).includes('printed words stay'));
    assert((await page.locator('#an-detail-status').textContent()).includes('Removal is OFF'));
    assert((await page.locator('#an-detail-list').textContent()).includes('https://example.com/report'));
    await page.locator('#an-grid').getByRole('button', { name: /Annotations/ }).click();
    assert((await page.locator('#an-detail-list').textContent()).includes('Reviewer note example'));
    await page.locator('#an-grid').getByRole('button', { name: /Attachments/ }).click();
    assert((await page.locator('#an-detail-list').textContent()).includes('notes.txt'));
    await page.locator('#an-grid').getByRole('button', { name: /Metadata/ }).click();
    assert((await page.locator('#an-detail-list').textContent()).includes('<img src=x onerror=globalThis.injected=1>'));
    assert.equal(await page.locator('#an-detail-list img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator('#an-plan').getByRole('button', { name: /Header/ }).click();
    assert.equal(await page.locator('#an-detail-title').textContent(), 'Text affected by cleanup');
  });
  await t.test('analysis preview agrees with actual cleanup in the bundled web engine', async () => {
    const words = await page.evaluate(async () => {
      const job = { ...window.analysisRequest, kind: 'clean', output: '/out/analysis-check.pdf' };
      await window.engineRpc('job', { job });
      return JSON.parse((await window.engineRpc('words', { path: job.output, page: 0 })).json).lines.flatMap(l => l[4].map(w => w[4]));
    });
    assert.deepEqual(words, ['Delta', 'Echo', 'Foxtrot']);
    const bytes = await page.evaluate(async () => Array.from(new Uint8Array((await window.engineRpc('get', { path: window.analysisRequest.input })).buffer)));
    assert.deepEqual(bytes, Array.from(richPdf));
  });
  await t.test('batch analysis honors individual PDF settings and identifies the affected file', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#batch-input').setInputFiles(['analysis-A.pdf', 'analysis-B.pdf'].map(name => ({ name, mimeType: 'application/pdf', buffer: richPdf })));
    await page.waitForFunction(() => document.querySelectorAll('#batch-list img').length === 2);
    await page.locator('#batch-list > li').first().click();
    await page.locator('#card-preview').waitFor({ state: 'visible' });
    await page.evaluate(() => { document.querySelector('#top').value = '0'; });
    await page.locator('#viewer-back').click();
    await page.locator('#bubble').click();
    await page.waitForFunction(() => Date.now() - document.querySelector('#modal-opts')._t > 420);
    await page.locator('#o-analyze').click();
    await page.locator('#modal-analysis').waitFor({ state: 'visible' });
    await page.locator('#an-grid').getByRole('button', { name: /Text to remove/ }).click();
    const status = await page.locator('#an-detail-status').textContent();
    assert(status.includes('analysis-A.pdf: No text removal is selected'));
    assert(status.includes('analysis-B.pdf: 3 words'));
    const detail = await page.locator('#an-detail-list').textContent();
    assert(detail.includes('analysis-B.pdf')); assert(!detail.includes('analysis-A.pdf'));
  });
  await t.test('history cleanup is mandatory and explained in analysis', async () => {
    assert(await page.locator('#opt-meta').isChecked()); assert(await page.locator('#opt-meta').isDisabled());
    assert(await page.locator('#opt-extras').isChecked()); assert(await page.locator('#opt-extras').isDisabled());
    await page.locator('#an-grid').getByRole('button', { name: /File history/ }).click();
    assert((await page.locator('#an-detail-description').textContent()).includes('cloud backups'));
    assert((await page.locator('#an-detail-description').textContent()).includes('Earlier saved revisions'));
  });
  await t.test('real bundled engine strips history from cleaned and unlocked exports, including encrypted sources', async () => {
    for (const encrypted of [false, true]) {
      const fixture = path.join(__dirname, 'fixtures', encrypted ? 'history-encrypted.pdf' : 'history-incremental.pdf');
      const bytes = Array.from(fs.readFileSync(fixture));
      for (const kind of ['clean', 'unlock']) {
        const result = await page.evaluate(async ({ bytes, encrypted, kind }) => {
          const input = '/in/history-fixture.pdf', output = '/out/history-fixture.pdf';
          await window.engineRpc('put', { path: input, buffer: new Uint8Array(bytes).buffer });
          const saved = await window.engineRpc('job', { job: { kind, input, output, password: encrypted ? 'fixture-reader' : '', options: { remove_metadata: false, remove_extras: false, remove_image_watermarks: false } } });
          const inspected = await window.engineRpc('job', { job: { kind: 'analyze', input: output, options: { remove_metadata: false, remove_extras: false } } });
          const words = JSON.parse((await window.engineRpc('words', { path: output, page: 0 })).json).lines.flatMap(l => l[4].map(w => w[4]));
          const original = Array.from(new Uint8Array((await window.engineRpc('get', { path: input })).buffer));
          const pdf = new TextDecoder().decode((await window.engineRpc('get', { path: output })).buffer);
          return { original, words, details: inspected.details, report: saved.report, pdf };
        }, { bytes, encrypted, kind });
        assert.deepEqual(result.original, bytes);
        assert.deepEqual(result.words, ['Current', 'version', 'only']);
        assert.equal(result.details.metadata.total, 0); assert.equal(result.details.attachments.total, 0);
        assert(result.details.history.items[0].text.includes('No earlier save chain detected'));
        assert.equal((result.pdf.match(/startxref/g) || []).length, 1);
        assert(!result.pdf.includes('/Prev '));
        const sourcePdf = Buffer.from(bytes).toString('latin1');
        const ids = text => [...(text.match(/\/ID\s*\[([^\]]*)\]/)?.[1] || '').matchAll(/<([0-9a-f]+)>/gi)].map(m => m[1].toLowerCase());
        assert(ids(result.pdf).length > 0); assert(!ids(result.pdf).some(id => ids(sourcePdf).includes(id)));
      }
    }
  });
  await t.test('touch swipes do not change the PDF page; visible arrows navigate and respect page boundaries', async () => {
    await page.reload(); await page.waitForFunction(() => document.querySelector('#boot').hidden);
    await page.locator('#file-input').setInputFiles({ name: 'two-pages.pdf', mimeType: 'application/pdf', buffer: textPdf({ pages: 2 }) });
    await page.waitForFunction(() => document.querySelector('#pg-label').textContent === 'Page 1 of 2');
    assert(await page.locator('#pg-prev').isVisible()); assert(await page.locator('#pg-next').isVisible());
    assert(await page.locator('#pg-prev').isDisabled()); assert(await page.locator('#pg-next').isEnabled());
    await touch('touchStart', [[300, 550, 1]]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [[300 - i * 25, 550, 1]]);
    await touch('touchEnd', []);
    assert.equal(await page.locator('#pg-label').textContent(), 'Page 1 of 2');
    await page.locator('#pg-next').tap();
    await page.waitForFunction(() => document.querySelector('#pg-label').textContent === 'Page 2 of 2');
    assert(await page.locator('#pg-next').isDisabled()); assert(await page.locator('#pg-prev').isEnabled());
    await touch('touchStart', [[100, 550, 1]]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [[100 + i * 25, 550, 1]]);
    await touch('touchEnd', []);
    assert.equal(await page.locator('#pg-label').textContent(), 'Page 2 of 2');
    await page.locator('#pg-prev').tap();
    await page.waitForFunction(() => document.querySelector('#pg-label').textContent === 'Page 1 of 2');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#pg-label').textContent === 'Page 2 of 2');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('#pg-label').textContent === 'Page 1 of 2');
  });
  await t.test('no uncaught page errors', () => assert.deepEqual(errors, []));
});
