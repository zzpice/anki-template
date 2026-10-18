// 使用导入安装包后的真实 HTML 和官方 Anki reviewer，检查两种浏览器引擎。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium, webkit} = require('playwright');

const root = path.resolve(__dirname, '..');
const renderRoot = path.resolve(root, process.env.ANKI_RENDER_DIR || 'build');
const examples = JSON.parse(fs.readFileSync(path.join(renderRoot, 'cards.json'), 'utf8'));
const choiceCases = JSON.parse(fs.readFileSync(path.join(renderRoot, 'choice-cases.json'), 'utf8'));
const mindmapCases = JSON.parse(fs.readFileSync(path.join(renderRoot, 'mindmap-cases.json'), 'utf8'));
const checkMindMap = require('./mindmap_browser.cjs');
const checkReview = require('./review_browser.cjs');
const reviewCases = JSON.parse(fs.readFileSync(path.join(renderRoot, 'review-cases.json'), 'utf8'));
const nativeRoot = JSON.parse(fs.readFileSync(path.join(renderRoot, 'anki-web.json'), 'utf8'));
const cards = Object.fromEntries(examples.map(example => [example.key, example.cards]));
const server = http.createServer((request, response) => {
  const url = decodeURIComponent(request.url.split('?')[0]);
  if (url === '/card') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<base href="/cards/media/"><link rel="stylesheet" href="/native/css/reviewer.css">' +
      '<link rel="stylesheet" href="/cards/style.css"></head><body class="card"><div id="qa"></div>' +
      '<script src="/native/js/reviewer.js"></script></body></html>');
    return;
  }
  const directory = url.startsWith('/native/') ? nativeRoot : root;
  const file = path.resolve(directory, '.' + (directory === root ? url : url.slice(7)));
  if (!file.startsWith(directory + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end(); return;
  }
  const types = {'.html':'text/html', '.css':'text/css', '.json':'application/json',
    '.js':'text/javascript', '.svg':'image/svg+xml', '.apkg':'application/octet-stream'};
  response.setHeader('Content-Type', (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8');
  response.end(fs.readFileSync(file));
});

async function showCard(page, html) {
  if (html.includes('data-mindmap=') && !html.startsWith('<style>')) {
    html = '<style>' + examples.find(e => e.type === 'mindmap').css + '</style>' + html;
  }
  await page.evaluate(async html => {
    const qa = document.getElementById('qa');
    qa.innerHTML = html;
    // 与官方 reviewer 相同，顺序执行内联脚本并等待媒体脚本完成。
    for (const old of Array.from(qa.querySelectorAll('script'))) {
      await new Promise(resolve => {
        const script = document.createElement('script');
        for (const attribute of old.attributes) script.setAttribute(attribute.name, attribute.value);
        script.textContent = old.textContent;
        if (old.src) {
          script.onload = resolve;
          script.onerror = () => { throw new Error('Script failed: ' + old.src); };
        }
        old.replaceWith(script);
        if (!script.src) resolve();
      });
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, html);
}

function contrast(rgb1, rgb2) {
  const luminance = rgb => rgb.match(/\d+/g).slice(0, 3).map(Number).map(v => {
    v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  }).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0);
  const a = luminance(rgb1), b = luminance(rgb2);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

async function choiceOrder(page) {
  return page.locator('.review-choice').evaluateAll(rows => rows.map(row => ({
    source:row.dataset.key,
    letter:row.querySelector('.review-choice-key').textContent,
    content:row.querySelector('.content').innerHTML,
  })));
}

async function checkPreviewViewport(page, requestedWidth) {
  const view = await page.locator('#preview').evaluate(el => ({
    width:el.contentWindow.innerWidth,
    left:el.getBoundingClientRect().left,
    outerWidth:innerWidth,
    availableWidth:(()=>{const stage=el.closest('.preview-stage'),style=getComputedStyle(stage);return stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);})(),
    mobile:el.contentWindow.matchMedia('(max-width:480px)').matches,
    cardOverflow:el.contentDocument.documentElement.scrollWidth > el.contentWindow.innerWidth,
    pageOverflow:document.documentElement.scrollWidth > innerWidth,
  }));
  // Fill the preview stage; phone mode stays capped within its available width.
  const width=Math.min(requestedWidth,view.availableWidth);
  assert.equal(view.width, width, 'card viewport fits the preview stage');
  assert.ok(Math.abs(view.left - (view.outerWidth - width) / 2) < 1, 'viewport centering');
  assert.equal(view.mobile, width <= 480, 'card media queries use iframe width');
  assert.equal(view.cardOverflow, false, 'card overflows viewport');
  assert.equal(view.pageOverflow, false, 'preview controls overflow page');
}

async function checkChoices(page) {
  // 控制熵验证不同排序，并按原始选项标识核对背面的显示字母和正文。
  await page.evaluate(() => { Math.random = () => 0; });
  await showCard(page, cards.single[0].front);
  const first = await choiceOrder(page);
  assert.deepEqual(first.map(row => row.source), ['B', 'C', 'D', 'A']);
  assert.deepEqual(first.map(row => row.letter), ['A', 'B', 'C', 'D']);
  await page.locator('#review-choice-A').check();
  await showCard(page, cards.single[0].back);
  assert.deepEqual(await choiceOrder(page), first);
  assert.equal(await page.locator('.review-selected').count(), 1);
  assert.equal(await page.locator('.review-choice[data-key="A"] .review-selected').count(), 1);
  assert.equal(await page.locator('.is-correct').getAttribute('data-key'), 'C');
  assert.equal(await page.locator('.review-answer-choice .review-choice-key').innerText(), 'B');
  assert.match(await page.locator('[data-answer]').innerText(), /allowlist\.txt/);
  assert.equal(await page.locator('input:enabled').count(), 0);
  assert.equal(await page.locator('input:checked').count(), 1);
  assert.ok(await page.evaluate(() => sessionStorage.getItem('anki-template/current-choice')));
  // 重绘背面不丢选择；新正面即使是同一道题也开启新一次复习。
  await showCard(page, cards.single[0].back);
  assert.deepEqual(await choiceOrder(page), first);
  assert.equal(await page.locator('.review-selected').count(), 1);
  await page.evaluate(() => { Math.random = () => .999; });
  await showCard(page, cards.single[0].front);
  assert.deepEqual((await choiceOrder(page)).map(row => row.source), ['A', 'B', 'C', 'D']);
  assert.equal(await page.locator('input:checked').count(), 0);
  await page.locator('#review-choice-C').check();
  // 同一浏览上下文重载文档后仍可核对刚才的选择。
  await page.reload();
  await page.evaluate(() => { window.originalRandom = Math.random; });
  await showCard(page, cards.single[0].back);
  assert.equal(await page.locator('.is-correct .review-selected').count(), 1);
  assert.equal(await page.locator('.review-answer-choice .review-choice-key').innerText(), 'C');

  for (const key of ['multiple', 'judgment']) {
    await page.evaluate(() => { Math.random = () => 0; });
    await showCard(page, cards[key][0].front);
    const order = await choiceOrder(page);
    if (key === 'judgment') assert.deepEqual(order.map(row => row.source), ['A', 'B']);
    else assert.deepEqual(order.map(row => row.source), ['B', 'C', 'D', 'A']);
    await page.locator('#review-choice-A').check();
    if (key === 'multiple') await page.locator('#review-choice-C').check();
    await showCard(page, cards[key][0].back);
    assert.deepEqual(await choiceOrder(page), order);
    assert.equal(await page.locator('.review-selected').count(), key === 'multiple' ? 2 : 1);
    const correct = key === 'multiple' ? ['A', 'B', 'D'] : ['B'];
    assert.deepEqual((await page.locator('.is-correct').evaluateAll(rows => rows.map(row => row.dataset.key))).sort(), correct);
    for (const source of correct) {
      const row = order.find(row => row.source === source);
      assert.ok((await page.locator('[data-answer]').innerText()).includes(row.letter));
      assert.ok((await page.locator('[data-answer]').innerText()).includes(row.content));
    }
  }
  for (const key of ['fixed', 'fixed_multi', 'duplicates', 'literal', 'maximum']) {
    await showCard(page, choiceCases[key].front);
    const order = await choiceOrder(page);
    if (key.startsWith('fixed')) assert.deepEqual(order.map(row => row.source), ['A', 'B', 'C', 'D']);
    const picked = key === 'maximum' ? 'Z' : 'A';
    await page.locator('#review-choice-' + picked).check();
    await showCard(page, choiceCases[key].back);
    assert.deepEqual(await choiceOrder(page), order);
    assert.equal(await page.locator('.review-selected').count(), 1);
    if (key === 'literal') {
      assert.equal(await page.locator('.is-correct').count(), 0);
      assert.equal(await page.locator('[data-answer]').innerText(), '直接核对这段答案');
    } else {
      const correct = key === 'fixed_multi' ? ['A', 'C'] : key === 'maximum' ? ['A', 'Z'] : ['C'];
      assert.deepEqual((await page.locator('.is-correct').evaluateAll(rows => rows.map(row => row.dataset.key))).sort(), correct);
      const expected = order.filter(row => correct.includes(row.source));
      assert.deepEqual(await page.locator('.review-answer-choice .review-choice-key').allTextContents(), expected.map(row => row.letter));
      assert.deepEqual(await page.locator('.review-answer-choice .content').allInnerTexts(),
        await page.locator('.is-correct .content').allInnerTexts());
    }
  }
  await showCard(page, cards.minimal[0].front);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('anki-template/current-choice')), null);
  // 存储被禁用时，确定性排序保证两面一致，答案照常对应。
  await page.evaluate(() => {
    window.originalGet = Storage.prototype.getItem; window.originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('disabled'); };
  });
  await showCard(page, cards.single[0].front);
  const fallback = await choiceOrder(page);
  await showCard(page, cards.single[0].back);
  assert.deepEqual(await choiceOrder(page), fallback);
  assert.equal(await page.locator('.is-correct').getAttribute('data-key'), 'C');
  await page.evaluate(() => { Storage.prototype.getItem = window.originalGet; Storage.prototype.setItem = window.originalSet; });
  await page.evaluate(() => { Math.random = window.originalRandom; });
}

async function run(browserType, name, base) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage({hasTouch:true});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/card');
    for (const viewport of [{width:1280,height:900}, {width:390,height:844}, {width:844,height:390}, {width:320,height:568}]) {
      await page.setViewportSize(viewport);
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({colorScheme:scheme});
        for (const example of examples) {
          for (const card of example.cards) {
            await showCard(page, card.front);
            assert.equal(await page.locator('#answer').count(), 0);
            assert.equal(await page.locator('[data-answer]').count(), 0);
            await showCard(page, card.back);
            assert.equal(await page.locator('#answer').count(), 1);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              name + ': overflow in ' + example.key);
          }
        }
        const colors = await page.evaluate(() => ({
          ink:getComputedStyle(document.body).color,
          paper:getComputedStyle(document.body).backgroundColor,
          muted:getComputedStyle(document.querySelector('.review-context')).color,
        }));
        assert.ok(contrast(colors.ink, colors.paper) >= 7, 'body contrast');
        assert.ok(contrast(colors.muted, colors.paper) >= 4.5, 'secondary text contrast');
      }
    }
    await page.setViewportSize({width:390,height:844});
    await page.emulateMedia({colorScheme:'light'});
    await checkChoices(page);
    await checkReview(page, showCard, reviewCases);
    await checkMindMap(page, showCard, mindmapCases, name);
    await page.setViewportSize({width:390,height:844});
    await page.emulateMedia({colorScheme:'light'});
    await showCard(page, cards.single[0].front);
    assert.equal(await page.getByRole('radio', {name:/allowlist\.txt/}).count(), 1);
    await page.locator('label[for="review-choice-A"]').click();
    await page.locator('label[for="review-choice-C"]').click();
    assert.equal(await page.locator('input:checked').count(), 1);
    assert.equal(await page.locator('#review-choice-C').isChecked(), true);
    // 原生控件可用键盘操作，不抢占 Anki 的评分数字键。
    await page.locator('#review-choice-A').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#review-choice-A').isChecked(), true);
    await showCard(page, cards.single[0].back);
    assert.equal(await page.locator('.is-correct').getAttribute('data-key'), 'C');
    assert.match(await page.locator('[data-answer]').innerText(), /allowlist\.txt/);
    assert.equal(await page.locator('input:enabled').count(), 0);
    assert.equal(await page.locator('input:checked').count(), 1);
    await showCard(page, cards.multiple[0].front);
    await page.locator('#review-choice-A').check();
    await page.locator('#review-choice-B').check();
    assert.equal(await page.locator('input:checked').count(), 2);
    await page.locator('#review-choice-A').uncheck();
    assert.equal(await page.locator('input:checked').count(), 1);
    await showCard(page, cards.multiple[0].back);
    assert.equal(await page.locator('.is-correct').count(), 3);
    assert.equal(await page.locator('.review-answer-choice').count(), 3);
    await showCard(page, cards.judgment[0].back);
    assert.equal(await page.locator('.is-correct').getAttribute('data-key'), 'B');
    assert.equal(await page.locator('.review-selected').count(), 0);
    await showCard(page, cards.minimal[0].back);
    assert.equal(await page.locator('.review-context').isVisible(), false);
    assert.equal(await page.locator('.review-meta').isVisible(), false);
    assert.equal(await page.locator('details, .review-explanation').count(), 0);

    await showCard(page, cards.recall[0].back);
    assert.equal(await page.locator('details').getAttribute('open'), null);
    await page.locator('summary').click();
    assert.equal(await page.locator('details[open]').count(), 1);
    assert.equal(await page.locator('details .review-scroll').count(), 1);
    await page.locator('summary').click();
    assert.equal(await page.locator('details[open]').count(), 0);
    await showCard(page, cards.rich[0].back);
    assert.ok(await page.locator('.review-scroll').evaluate(el => el.scrollWidth > el.clientWidth));
    await page.locator('.review-scroll').evaluate(el => { el.scrollLeft = 60; });
    assert.ok(await page.locator('.review-scroll').evaluate(el => el.scrollLeft > 0));
    assert.ok(await page.locator('pre').evaluate(el => el.scrollWidth > el.clientWidth));
    const light = await page.locator('body').evaluate(el => getComputedStyle(el).color);
    for (const night of ['nightMode', 'night_mode']) {
      await page.locator('body').evaluate((el, value) => el.classList.add(value), night);
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).color), 'rgb(237, 238, 238)');
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(21, 22, 23)');
      await page.locator('body').evaluate((el, value) => el.classList.remove(value), night);
    }
    const image = page.locator('.review-question img');
    const box = await image.boundingBox();
    assert.ok(box.width <= 354 && Math.abs(box.width / box.height - 960 / 360) < .01);
    await image.click();
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await page.keyboard.press('Escape');
    await page.locator('dialog').waitFor({state:'detached'});
    assert.equal(await page.locator('dialog').count(), 0);
    await image.click();
    await page.getByRole('button', {name:'关闭', exact:true}).click();
    await page.locator('dialog').waitFor({state:'detached'});
    assert.equal(await page.locator('dialog').count(), 0);
    await image.click();
    await showCard(page, cards.minimal[0].front);
    assert.equal(await page.locator('dialog').count(), 0, 'zoom survives card replacement');
    assert.equal(await page.locator(':modal').count(), 0);
    await showCard(page, cards.rich[0].front);
    await image.evaluate(el => el.classList.add('no-zoom'));
    await image.click();
    assert.equal(await page.locator('dialog').count(), 0);
    await image.evaluate(el => {
      el.classList.remove('no-zoom');
      const link = document.createElement('a'); link.href = location.href.split('#')[0] + '#image-link';
      el.before(link); link.appendChild(el);
    });
    await image.click();
    assert.ok(page.url().endsWith('#image-link'));
    assert.equal(await page.locator('dialog').count(), 0);

    // 官方原生图片遮挡实际绘制：正面遮住，背面中心透明，另一处遮挡仍保留。
    await showCard(page, cards.occlusion[0].front);
    const canvas = page.locator('#image-occlusion-canvas');
    await page.waitForFunction(() => document.querySelector('canvas').width > 0);
    const pixel = async (x, y) => canvas.evaluate((el, point) => Array.from(
      el.getContext('2d').getImageData(Math.round(el.width * point[0]), Math.round(el.height * point[1]), 1, 1).data), [x, y]);
    assert.equal((await pixel(.19, .50))[3], 255, 'active mask missing');
    assert.equal((await pixel(.82, .50))[3], 255, 'inactive mask missing');
    const container = await page.locator('#image-occlusion-container').boundingBox();
    assert.ok(Math.abs(container.width / container.height - 960 / 360) < .01);
    await showCard(page, cards.occlusion[0].back);
    assert.equal((await pixel(.19, .50))[3], 0, 'answer mask remains opaque');
    assert.equal((await pixel(.82, .50))[3], 255);
    await page.locator('#toggle').click();
    assert.equal((await pixel(.82, .50))[3], 0, 'toggle masks failed');
    await page.locator('#toggle').click();
    assert.equal((await pixel(.82, .50))[3], 255);

    for (let i = 0; i < 8; i++) {
      await showCard(page, cards.rich[0].front);
      await showCard(page, cards.rich[0].back);
    }
    assert.equal(await page.locator('.review-scroll .review-scroll').count(), 0);
    await page.locator('.review-question img').click();
    assert.equal(await page.locator('dialog').count(), 1, 'duplicate handlers');
    await showCard(page, '<section><img src="_rule-build.svg"></section>');
    await page.locator('section img').click();
    assert.equal(await page.locator('dialog').count(), 0, 'other note types are intercepted');
    assert.equal(await page.locator(':modal').count(), 0);

    // 页面读取相同官方渲染；全套示例、填空分卡、强制主题和下载链接可用。
    await page.setViewportSize({width:1280,height:900});
    await page.goto(base + '/preview.html');
    const frame = page.frameLocator('#preview');
    await frame.locator('.review-choice').first().waitFor();
    await checkPreviewViewport(page, 1280);
    const previewOrder = await choiceOrder(frame);
    await frame.locator('#review-choice-A').check();
    await page.selectOption('#viewport', 'phone');
    await checkPreviewViewport(page, 390);
    assert.deepEqual(await choiceOrder(frame), previewOrder);
    assert.equal(await frame.locator('#review-choice-A').isChecked(), true);
    await page.click('#flip');
    await frame.locator('#answer').waitFor();
    assert.deepEqual(await choiceOrder(frame), previewOrder);
    assert.equal(await frame.locator('.review-choice[data-key="A"] .review-selected').count(), 1);
    assert.equal(await frame.locator('.is-correct').getAttribute('data-key'), 'C');
    await page.selectOption('#viewport', 'auto');
    await checkPreviewViewport(page, 1280);
    assert.equal(await frame.locator('.review-selected').count(), 1);
    assert.deepEqual(await choiceOrder(frame), previewOrder);
    await page.selectOption('#viewport', 'phone');
    await page.click('#flip');
    await frame.locator('input:enabled').first().waitFor();
    assert.deepEqual(await choiceOrder(frame), previewOrder);
    assert.equal(await frame.locator('#review-choice-A').isChecked(), true);
    await page.selectOption('#theme', 'dark');
    assert.notEqual(await frame.locator('body').evaluate(el => getComputedStyle(el).color), light);
    assert.equal(await frame.locator('#review-choice-A').isChecked(), true);
    await page.emulateMedia({colorScheme:'dark'});
    await page.selectOption('#theme', 'light');
    assert.equal(await frame.locator('body').evaluate(el => getComputedStyle(el).color), light);
    await page.selectOption('#theme', 'system');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.notEqual(await frame.locator('body').evaluate(el => getComputedStyle(el).color), light);
    await page.emulateMedia({colorScheme:'light'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await frame.locator('body').evaluate(el => getComputedStyle(el).color), light);
    await page.click('#flip');
    await frame.locator('#answer').waitFor();
    assert.equal(await frame.locator('.review-selected').count(), 1);
    await page.selectOption('#sample', String(examples.findIndex(e => e.key === 'multiple')));
    await frame.locator('input:enabled').first().waitFor();
    assert.equal(await frame.locator('input:checked').count(), 0);
    for (let i = 0; i < examples.length; i++) {
      await page.selectOption('#sample', String(i));
      if (examples[i].type === 'occlusion') {
        await frame.locator('#occlusion-error').waitFor({state:'visible'});
        assert.equal(await frame.locator('#image-occlusion-container').isVisible(), false);
      } else {
        await frame.locator('.review-question').waitFor();
      }
      await page.click('#flip');
      await frame.locator('#answer').waitFor();
      await checkPreviewViewport(page, 390);
    }
    await page.selectOption('#sample', String(examples.findIndex(e => e.key === 'cloze')));
    assert.equal(await page.locator('#card option').count(), 3);
    await page.selectOption('#card', '2');
    await frame.locator('.cloze').waitFor();
    assert.match(await frame.locator('.cloze').innerText(), /正负方向/);

    // 桌面上的手机视口与真实窄屏共用同一张富文本卡片，调整宽度不重绘内容。
    await page.selectOption('#sample', String(examples.findIndex(e => e.key === 'rich')));
    await frame.locator('#answer').waitFor({state:'detached'});
    await page.click('#flip');
    await frame.locator('pre').waitFor();
    await frame.locator('.review-question img').evaluate(el => el.decode());
    const viewports = [
      {width:1280, mode:'auto'}, {width:1280, mode:'phone'},
      ...[320, 360, 375, 390, 430].map(width => ({width, mode:'auto'})),
      {width:320, mode:'phone'}, {width:430, mode:'phone'},
    ];
    for (const scheme of ['light', 'dark']) {
      await page.selectOption('#theme', scheme);
      for (const view of viewports) {
        await page.setViewportSize({width:view.width,height:900});
        await page.selectOption('#viewport', view.mode);
        const width = view.mode === 'phone' ? Math.min(390, view.width) : view.width;
        await checkPreviewViewport(page, width);
        assert.equal(await frame.locator('#answer').count(), 1, 'resize changed card side');
        assert.ok((await frame.locator('.review-question img').boundingBox()).width <= width);
        if (width <= 430) {
          for (const selector of ['.review-scroll', 'pre']) {
            const scroll = frame.locator(selector);
            assert.ok(await scroll.evaluate(el => el.scrollWidth > el.clientWidth));
            await scroll.evaluate(el => { el.scrollLeft = 60; });
            assert.ok(await scroll.evaluate(el => el.scrollLeft > 0));
          }
        }
      }
    }
    await page.setViewportSize({width:1280,height:900});
    await page.selectOption('#viewport', 'phone');
    await frame.locator('.review-question img').click();
    await frame.locator('dialog[open]').waitFor();
    await checkPreviewViewport(page, 390);
    const zoom = await frame.locator('dialog').boundingBox();
    const viewportBox = await page.locator('#preview').boundingBox();
    assert.ok(zoom.x >= viewportBox.x && zoom.x + zoom.width <= viewportBox.x + viewportBox.width);
    await frame.getByRole('button', {name:'关闭', exact:true}).click();
    await frame.locator('dialog').waitFor({state:'detached'});
    assert.equal((await page.request.get(base + '/downloads/anki-template.apkg')).status(), 200);
    await page.goto(base + '/index.html');
    await page.getByRole('link', {name:'在线预览', exact:false}).click();
    await page.waitForURL('**/preview.html');
    await frame.locator('.review-choice').first().waitFor();
    if (name === 'Chromium' && process.env.ANKI_SCREENSHOTS === '1') {
      // 使用说明截图直接取在线预览，随示例一起更新。
      async function capture(filename) {
        await frame.locator('.review-meta a').waitFor();
        await page.locator('#preview').evaluate(el => {
          el.style.minHeight = '0';
          el.style.height = Math.ceil(el.contentDocument.body.getBoundingClientRect().height) + 'px';
        });
        await frame.locator('body').screenshot({path:path.join(root, filename)});
      }
      await page.setViewportSize({width:390,height:844});
      await page.emulateMedia({colorScheme:'light'});
      await page.selectOption('#theme', 'light');
      await frame.locator('#review-choice-A').check();
      await page.click('#flip');
      await frame.locator('.review-selected').waitFor();
      await frame.locator('.is-correct').waitFor();
      await capture('docs/images/preview-choice.png');
      await page.setViewportSize({width:700,height:1200});
      await page.selectOption('#sample', String(examples.findIndex(e => e.key === 'rich')));
      await page.click('#flip');
      await frame.locator('pre').waitFor();
      await frame.locator('img').evaluate(el => el.decode());
      await capture('docs/images/preview-content.png');
    }
    assert.deepEqual(errors, []);
    console.log(name + ': 14 sample cards, responsive layout, contrast, choices, Cloze, native occlusion, images, lifecycle, Mind Map and preview passed');
  } finally { await browser.close(); }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    await run(chromium, 'Chromium', base);
    await run(webkit, 'WebKit', base);
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
