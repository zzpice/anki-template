// Exercise the actual static site under GitHub Pages' project prefix.
// SITE_URL also runs this check against the deployed site, in a fresh context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium, webkit} = require('playwright');
const root = path.resolve(__dirname, '..');
const servedRoot = path.resolve(process.env.SITE_ROOT || root);
const prefix = '/anki-template/';
const mime = {'.html':'text/html', '.css':'text/css', '.json':'application/json',
  '.js':'text/javascript', '.mjs':'text/javascript', '.svg':'image/svg+xml', '.png':'image/png'};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.startsWith(prefix)) {response.writeHead(404).end(); return;}
  const file = path.resolve(servedRoot, decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html');
  if (!file.startsWith(servedRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end(); return;
  }
  response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  response.end(fs.readFileSync(file));
});

async function render(page, action) {
  // Install the listener before changing srcdoc. A matching element can still
  // belong to the previous document; wait for scripts and images in the new one.
  await page.evaluate(() => {
    window.siteFrameLoaded = new Promise(resolve =>
      document.getElementById('preview').addEventListener('load', () => resolve(), {once:true}));
  });
  await action();
  await page.evaluate(() => window.siteFrameLoaded);
}

async function checkReturnNavigation(page, base) {
  const home = page.locator('header a[href="./"]').first();
  assert.equal(new URL(await home.getAttribute('href'), page.url()).href, base);
  const links = page.locator('header').getByRole('link');
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({colorScheme});
    await page.waitForFunction(scheme => document.documentElement.dataset.theme === scheme, colorScheme);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({width, height:844});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow');
      assert.ok(await home.isVisible(), 'return to project must remain visible');
      for (const link of await links.all()) {
        if (!await link.isVisible()) continue;
        const box = await link.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 844, 'navigation is clipped or below the fold');
      }
    }
  }
  await page.setViewportSize({width:1280, height:900});
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
}

async function checkAppearance(browser, base) {
  const context = await browser.newContext({colorScheme:'light'});
  const page = await context.newPage();
  const expectTheme = async (target, mode, theme) => {
    await target.waitForFunction(({mode,theme}) => document.documentElement.dataset.themeMode === mode && document.documentElement.dataset.theme === theme, {mode,theme});
    assert.equal(await target.locator('meta[name="theme-color"]').getAttribute('content'), theme === 'dark' ? '#16171b' : '#f6f6f8');
    assert.equal(await target.locator('html').evaluate(el => getComputedStyle(el).colorScheme), theme);
  };
  await page.goto(base);
  for (const colorScheme of ['dark','light']) {
    await page.emulateMedia({colorScheme}); await expectTheme(page,'system',colorScheme);
  }
  await page.selectOption('#theme','dark'); await page.reload(); await expectTheme(page,'dark','dark');
  await page.goto(new URL('tools.html',base).href); await page.locator('#app').waitFor();
  await expectTheme(page,'dark','dark');
  const tab = await context.newPage(); await tab.goto(new URL('preview.html',base).href);
  await tab.frameLocator('#preview').locator('.review-choice').first().waitFor();
  await expectTheme(tab,'dark','dark');
  const frame = tab.frameLocator('#preview');
  await frame.locator('input:enabled').first().check();
  const order = await frame.locator('.review-choice').evaluateAll(rows=>rows.map(row=>row.dataset.key));
  await tab.emulateMedia({colorScheme:'dark'}); await tab.selectOption('#theme','light');
  await expectTheme(page,'light','light'); await expectTheme(tab,'light','light');
  assert.equal(await frame.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(250, 249, 245)');
  assert.deepEqual(await frame.locator('.review-choice').evaluateAll(rows=>rows.map(row=>row.dataset.key)),order);
  assert.equal(await frame.locator('input:checked').count(),1);
  await tab.selectOption('#theme','system'); await expectTheme(tab,'system','dark');
  await expectTheme(page,'system','light');
  await tab.emulateMedia({colorScheme:'light'}); await expectTheme(tab,'system','light');
  assert.equal(await page.evaluate(()=>localStorage.getItem('anki-template-theme')),null);
  await context.close();
}

async function check(engine, name, base) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({acceptDownloads:true});
    const page = await context.newPage(), failures = [], requested = new Set();
    page.on('pageerror', error => failures.push(error.message));
    page.on('requestfailed', request => failures.push(request.url() + ': ' + request.failure().errorText));
    page.on('response', response => {if (!response.ok()) failures.push(response.url() + ': ' + response.status());});
    page.on('request', request => {
      if (/^https?:/.test(request.url())) {
        assert.ok(request.url().startsWith(base), 'resource escaped project prefix: ' + request.url());
        requested.add(new URL(request.url()).pathname);
      }
    });
    await page.goto(base);
    assert.equal(page.url(), base, 'home must stay at the project root');
    await page.getByRole('heading', {name:'把知识，留在记忆里。', exact:true}).waitFor();
    const entries = page.getByRole('navigation', {name:'开始使用'});
    const downloadLink = entries.getByRole('link', {name:/安装笔记类型/});
    assert.equal(new URL(await downloadLink.getAttribute('href'), base).href,
      new URL('downloads/anki-template.apkg', base).href);
    const downloadPending = page.waitForEvent('download');
    await downloadLink.click();
    const packageDownload = await downloadPending;
    assert.equal(await packageDownload.failure(), null);
    assert.deepEqual(fs.readFileSync(await packageDownload.path()),
      fs.readFileSync(path.join(root, 'downloads/anki-template.apkg')));
    const backgrounds = [];
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({colorScheme});
      await page.waitForFunction(scheme => document.documentElement.dataset.theme === scheme, colorScheme);
      backgrounds.push(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor));
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({width, height:844});
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'home overflow');
        for (const link of await entries.getByRole('link').all()) {
          const box = await link.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width && box.height >= 44, 'home entry is clipped or too small');
        }
      }
    }
    assert.notEqual(backgrounds[0], backgrounds[1], 'home must follow system appearance');
    await page.setViewportSize({width:1280, height:900});
    await page.emulateMedia({colorScheme:'light'});
    await entries.getByRole('link', {name:/网页制卡/}).click();
    await page.locator('#app').waitFor();
    assert.equal(page.url(), new URL('tools.html', base).href);
    await checkReturnNavigation(page, base);
    await page.locator('header a[href="./"]').first().click();
    assert.equal(page.url(), base);
    await page.getByRole('navigation', {name:'开始使用'}).getByRole('link', {name:/网页制卡/}).click();
    await page.locator('#app').waitFor();
    await page.locator('header a[href="./"]').first().click();
    assert.equal(page.url(), base);
    await page.getByRole('navigation', {name:'开始使用'}).getByRole('link', {name:/在线预览/}).click();
    assert.equal(page.url(), new URL('preview.html', base).href);
    // Let the preview's fetches finish before leaving through its navigation.
    await page.frameLocator('#preview').locator('.review-choice').first().waitFor();
    await checkReturnNavigation(page, base);
    await page.locator('header a[href="./"]').first().click();
    assert.equal(page.url(), base);
    await page.getByRole('navigation', {name:'开始使用'}).getByRole('link', {name:/在线预览/}).click();
    const frame = page.frameLocator('#preview');
    await frame.locator('.review-choice').first().waitFor();
    const examples = JSON.parse(fs.readFileSync(path.join(root, 'web/preview-cards.json')));
    assert.equal(await page.locator('#sample option').count(), examples.length);
    for (let index = 0; index < examples.length; index++) {
      await render(page, () => page.selectOption('#sample', String(index)));
      if (examples[index].type === 'occlusion') await frame.locator('#occlusion-error').waitFor();
      else await frame.locator('.review-question').waitFor();
      await render(page, () => page.click('#flip'));
      await frame.locator('#answer').waitFor();
    }
    for (const file of ['index.html', 'preview.html', 'tools.html', 'README.md',
      'docs/usage.md', 'docs/authoring.md', 'docs/development.md', 'LICENSE',
      'cards/note-types.json', 'cards/samples.json', 'cards/style.css',
      'cards/media/_review.js', 'cards/media/_mindmap.js', 'cards/media/_rule-build.svg',
      'web/preview-cards.json', 'downloads/anki-template.apkg',
      'docs/images/preview-choice.png', 'docs/images/preview-content.png', 'docs/images/preview-mindmap.png']) {
      const response = await page.request.get(new URL(file, base).href);
      assert.equal(response.status(), 200, file);
      assert.deepEqual(await response.body(), fs.readFileSync(path.join(root, file)), 'published content differs: ' + file);
    }
    await page.getByRole('link', {name:'网页制卡', exact:true}).click();
    await page.locator('#app').waitFor();
    assert.equal(page.url(), new URL('tools.html', base).href);
    await render(page, () => page.click('#load-samples'));
    assert.equal(await page.locator('#count').innerText(), '9 / 9 条');
    await page.selectOption('#type-filter', 'choice');
    await render(page, () => page.locator('.note-row button').first().click());
    await frame.locator('.review-choice').first().waitFor();
    await render(page, () => page.click('#flip'));
    await frame.locator('#answer').waitFor();
    await page.click('#export-open');
    const pending = page.waitForEvent('download');
    await page.click('#export-zip');
    const download = await pending;
    assert.equal(await download.failure(), null);
    const bytes = fs.readFileSync(await download.path());
    assert.ok(bytes.includes(Buffer.from('_rule-build.svg')), 'sample media missing from ZIP');
    assert.ok(bytes.includes(Buffer.from('/docs/authoring.md')), 'ZIP instructions must point to canonical documentation');
    for (const file of ['web/tools/app.mjs', 'cards/templates/basic/front.html',
      'cards/templates/basic/back.html', 'cards/templates/choice/front.html', 'cards/media/_rule-build.svg']) {
      assert.ok(requested.has(new URL(file, base).pathname), 'not loaded: ' + file);
    }
    await page.waitForFunction(() => document.getElementById('save-status').textContent.startsWith('已保存'));
    assert.deepEqual(failures, []);
    await context.close();
    const plain = await browser.newContext({javaScriptEnabled:false});
    const home = await plain.newPage();
    await home.goto(new URL('index.html', base).href);
    await home.getByRole('heading', {name:'把知识，留在记忆里。', exact:true}).waitFor();
    await home.getByRole('navigation', {name:'开始使用'}).getByRole('link', {name:/在线预览/}).click();
    assert.equal(home.url(), new URL('preview.html', base).href, 'home navigation must work without JavaScript');
    await plain.close();
    await checkAppearance(browser, base);
    console.log(name + ': home navigation, responsive light/dark layout, no-JS entry, Pages project paths, preview, authoring, shared media, ZIP, download, documentation and images passed (' + base + ')');
  } finally {await browser.close();}
}

(async () => {
  if (!process.env.SITE_URL) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = process.env.SITE_URL
    ? new URL('./', process.env.SITE_URL.endsWith('/') ? process.env.SITE_URL : process.env.SITE_URL + '/').href
    : 'http://127.0.0.1:' + server.address().port + prefix;
  try {await check(chromium, 'Chromium', base); await check(webkit, 'WebKit', base);}
  finally {server.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
