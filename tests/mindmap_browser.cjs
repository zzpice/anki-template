// Called by the existing Chromium/WebKit runner, using official Anki renders.
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function checkMindMap(page, showCard, cases, engine) {
  const action = name => {
    const locator = page.locator('[data-mm-action="' + name + '"]');
    return {isDisabled:() => locator.isDisabled(), click:async () => {
      if (['expand', 'collapse', 'show', 'hide'].includes(name)) {
        const panel = page.locator('.mm-more');
        if (!(await panel.evaluate(el => el.open))) await panel.locator('summary').click();
      }
      await locator.click();
    }};
  };
  const search = async text => {
    await page.getByRole('searchbox').fill(text);
    await page.getByRole('button', {name:'搜索', exact:true}).click();
  };
  const revealed = () => page.locator('.mm-answer:not([hidden])').count();
  await showCard(page, cases.single[0].front);
  assert.equal(await page.locator('.mm-node').count(), 1);
  assert.equal(await page.locator('.mm-toggle').count(), 0);
  assert.equal(await revealed(), 0);
  await page.locator('.mm-reveal').tap();
  assert.equal(await revealed(), 1, 'touch reveals exactly once');
  await page.locator('.mm-rehide').tap();
  assert.equal(await revealed(), 0, 'touch hides exactly once');
  await search('中文 English');
  assert.equal(await page.locator('.mm-search-status').innerText(), '1/1');
  assert.equal(await revealed(), 0, 'search must not disclose answer');
  await action('clear').click();
  assert.equal(await page.locator('.mm-search-mark').count(), 0);
  await showCard(page, cases.flat[0].front);
  assert.equal(await page.locator('.mm-reveal').innerText(), '[提示]');
  await page.locator('.mm-reveal').click();
  assert.equal(await page.locator('.mm-answer b').innerText(), '答案');
  await showCard(page, cases.loose[0].front);
  assert.equal(await page.locator('.mm-node').count(), 3);
  await search('needle');
  assert.equal(await page.locator('.mm-search-status').innerText(), '1/2', 'paragraphs outside lists are searchable');
  await action('next-result').click();
  assert.ok((await page.locator('.mm-search-row').innerText()).includes('Footer'));
  await action('next').click();
  assert.equal(await page.locator('.mm-located .mm-answer').innerText(), 'leaf');
  await showCard(page, cases.wrapper[0].front);
  await search('needle');
  assert.equal(await page.locator('.mm-search-status').innerText(), '1/2', 'root wrappers do not duplicate list search results');
  assert.equal(await page.locator('.mm-root-list').evaluate(el => getComputedStyle(el).paddingLeft), '0px');

  await showCard(page, cases.mixed[0].front);
  assert.equal(await page.locator('.mm-node').count(), 7);
  assert.equal(await page.locator('.mm-active').count(), 2);
  assert.equal(await page.locator('.mm-located').count(), 1);
  assert.equal(await page.locator('.mm-located .mm-reveal').innerText(), '[提示]');
  // Retain references to verify interactions do not replace the DOM.
  await page.evaluate(() => { window.mmOriginalNode = document.querySelector('.mm-node'); });
  await page.locator('.mm-reveal').nth(1).click();
  assert.equal(await revealed(), 1, 'multiple Clozes in one node remain independent');
  await action('hide').click();
  await action('next').click();
  assert.equal(await page.locator('.mm-located .mm-answer').innerText(), '第二');
  await action('next').click();
  assert.equal(await page.locator('.mm-located .mm-answer').innerText(), 'Hidden Needle');
  assert.equal(await page.locator('.mm-located').isVisible(), true, 'next expands the path');
  assert.equal(await revealed(), 0);
  await action('next').click();
  assert.equal(await page.locator('.mm-located .mm-answer').innerText(), '答案');
  await action('show').click(); assert.equal(await revealed(), 3);
  await action('hide').click(); assert.equal(await revealed(), 0);
  await action('collapse').click();
  assert.equal(await page.locator('.mm-toggle[aria-expanded="true"]').count(), 0);
  await action('locate').click();
  assert.equal(await page.locator('.mm-located').isVisible(), true);
  assert.equal(await page.locator('.mm-toggle[aria-expanded="true"]').count(), 1);
  await action('expand').click();
  assert.equal(await page.locator('.mm-toggle[aria-expanded="false"]').count(), 0);
  await page.locator('.mm-toggle').nth(1).click();
  assert.equal(await page.locator('.mm-toggle').nth(1).getAttribute('aria-expanded'), 'false');
  await search('needle');
  assert.equal(await page.locator('.mm-search-status').innerText(), '1/3');
  assert.equal(await page.locator('.mm-search-mark').count(), 4, 'query spans formatting boundaries');
  await action('prev-result').click();
  assert.equal(await page.locator('.mm-search-status').innerText(), '3/3');
  assert.ok((await page.locator('.mm-search-row').innerText()).includes('[…]'), 'hidden hit stays masked');
  assert.equal(await revealed(), 0);
  await action('next-result').click();
  assert.equal(await page.locator('.mm-search-status').innerText(), '1/3');
  await search('not-found');
  assert.equal(await page.locator('.mm-search-status').innerText(), '0/0');
  assert.equal(await action('next-result').isDisabled(), true);
  await search('.*');
  assert.equal(await page.locator('.mm-search-status').innerText(), '0/0', 'query is literal');
  for (let i = 0; i < 5; i++) { await search('needle'); await action('clear').click(); }
  assert.equal(await page.evaluate(() => window.mmOriginalNode === document.querySelector('.mm-node')), true);
  assert.equal(await page.locator('.mm-cloze').count(), 3);

  // Front -> Back keeps UI paths/query but reveals this card's native group only.
  await search('needle');
  await action('next-result').click();
  await page.locator('.mm-reveal').first().click();
  await showCard(page, cases.mixed[0].back);
  assert.equal(await page.locator('.mm-search-status').innerText(), '2/3');
  assert.equal(await revealed(), 2);
  assert.equal(await page.locator('.mm-cloze:not(.mm-active) .mm-answer').getAttribute('hidden'), '');
  await action('hide').click();
  await showCard(page, cases.mixed[0].back);
  assert.equal(await revealed(), 0, 'repeated back preserves deliberate controls');
  await showCard(page, cases.mixed[0].front);
  assert.equal(await revealed(), 0, 'a fresh front starts a new review');
  assert.equal(await page.getByRole('searchbox').inputValue(), '');
  await showCard(page, cases.mixed[1].back);
  assert.equal(await revealed(), 1, 'c2 is a separately generated Anki card');

  // Whole chapters: native text, image-only and mixed answers retain one tree.
  for (const name of ['comparison_chapter', 'symmetry_chapter']) {
    let chapterNodes;
    for (const card of cases[name]) {
      await showCard(page, card.front);
      const count = await page.locator('.mm-node').count();
      if (chapterNodes === undefined) chapterNodes = count;
      assert.equal(count, chapterNodes, 'every native Cloze card retains the entire chapter');
      assert.equal(await revealed(), 0);
      assert.equal(await page.locator('.mm-answer img:visible').count(), 0, 'front masks image answers too');
      await page.evaluate(() => {
        window.mmImages = Array.from(document.querySelectorAll('.mm-tree img'));
        window.mmImageAttributes = window.mmImages.map(el => el.outerHTML);
      });
      await action('expand').click();
      const ordinary = page.locator('.mm-tree img').filter({visible:true});
      assert.equal(await ordinary.count(), 1, 'ordinary chapter overview/illustration stays visible');
      const imageAnswers = page.locator('.mm-cloze:has(img)');
      for (let i = 0; i < await imageAnswers.count(); i++) {
        const cloze = imageAnswers.nth(i);
        await cloze.locator('.mm-reveal').tap();
        assert.equal(await revealed(), 1, 'image and text answers reveal independently');
        const img = cloze.locator('img');
        assert.equal(await img.isVisible(), true);
        await img.evaluate(el => el.decode());
        assert.equal(await img.getAttribute('src'), '_rule-build.svg');
        assert.ok(await img.getAttribute('alt'));
        assert.equal(await img.getAttribute('width'), '960');
        assert.equal(await img.getAttribute('height'), '360');
        await img.tap();
        assert.equal(await revealed(), 1, 'tapping the image does not toggle its answer');
        assert.equal(await page.locator('dialog').count(), 0);
        await cloze.locator('.mm-rehide').tap();
        assert.equal(await img.isVisible(), false);
        assert.equal(await revealed(), 0);
      }
      await action('show').click(); assert.equal(await revealed(), 4);
      await action('hide').click(); assert.equal(await revealed(), 0);
      await action('collapse').click();
      for (let i = 0; i < 4; i++) {
        await action('next').click();
        assert.equal(await page.locator('.mm-located').isVisible(), true, 'navigation opens every answer path');
      }
      await action('locate').click();
      assert.equal(await page.locator('.mm-located.mm-active').count(), 1);
      assert.equal(await revealed(), 0, 'navigation never reveals images');
      const query = name === 'comparison_chapter' ? '解析示意' : '图片说明';
      await search(query);
      assert.equal(await page.locator('.mm-search-status').innerText(), '1/1');
      assert.equal(await page.locator('.mm-search-current').isVisible(), false, 'hidden text/image answer remains masked');
      assert.equal(await page.locator('.mm-answer img:visible').count(), 0);
      await action('next-result').click(); await action('prev-result').click();
      assert.equal(await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('.mm-tree img'));
        return images.length === window.mmImages.length && images.every((el, i) =>
          el === window.mmImages[i] && el.outerHTML === window.mmImageAttributes[i]);
      }), true, 'search leaves both ordinary and Cloze image elements intact');
      await showCard(page, card.back);
      assert.equal(await page.getByRole('searchbox').inputValue(), query, 'image answers keep the front/back state fingerprint');
      assert.equal(await revealed(), await page.locator('.mm-active').count());
      await action('expand').click();
      assert.equal(await page.locator('.mm-answer img:visible').count(), await page.locator('.mm-active img').count(),
        'back restores this card image group, other image answers stay hidden');
      await action('hide').click();
      await showCard(page, card.back);
      assert.equal(await revealed(), 0, 'repeated back respects deliberate image masking');
    }
  }

  await showCard(page, cases.comparison_chapter[2].front);
  const imageCloze = page.locator('.mm-active:has(img)');
  const imageNode = imageCloze.locator('xpath=ancestor::li[1]');
  await page.evaluate(() => {
    window.mmImage = document.querySelector('.mm-active img');
    window.mmImageHTML = window.mmImage.outerHTML;
    window.mmElementCount = document.querySelectorAll('.mm-tree *').length;
  });
  for (let i = 0; i < 12; i++) {
    await imageCloze.locator('.mm-reveal').tap();
    await imageCloze.locator('.mm-rehide').tap();
    await action('show').click(); await action('hide').click();
  }
  await imageCloze.locator('.mm-reveal').tap();
  const toggle = imageNode.locator(':scope > .mm-row > .mm-toggle');
  await toggle.click(); assert.equal(await imageNode.locator(':scope > ul').isVisible(), true);
  await toggle.click(); assert.equal(await imageNode.locator(':scope > ul').isVisible(), false);
  assert.equal(await imageCloze.locator('img').isVisible(), true, 'folding children leaves the parent image intact');
  await action('hide').click();
  for (let i = 0; i < 4; i++) { await search('解析示意'); await action('clear').click(); }
  await search('例题 & Example');
  assert.equal(await page.locator('.mm-search-status').innerText(), '0/0', 'image alt text is not an OCR/text search index');
  await action('clear').click();
  assert.equal(await page.evaluate(() => window.mmImage === document.querySelector('.mm-active img') &&
    window.mmImageHTML === window.mmImage.outerHTML &&
    window.mmElementCount === document.querySelectorAll('.mm-tree *').length), true,
    'repeated reveal/hide/search preserves the actual image, its attributes and DOM size');
  for (const night of ['nightMode', 'night_mode']) {
    await page.locator('body').evaluate((el, value) => el.classList.add(value), night);
    assert.equal(await imageCloze.locator('img').evaluate(el => getComputedStyle(el).filter), 'none');
    await page.locator('body').evaluate((el, value) => el.classList.remove(value), night);
  }

  // Storage can fail in WebViews: native answers, paths and all controls still work.
  await page.evaluate(() => {
    window.mmGet = Storage.prototype.getItem; window.mmSet = Storage.prototype.setItem;
    Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('blocked'); };
  });
  await showCard(page, cases.mixed[0].front);
  await action('show').click(); assert.equal(await revealed(), 3);
  await showCard(page, cases.mixed[0].back); assert.equal(await revealed(), 2);
  await showCard(page, cases.comparison_chapter[2].front);
  assert.equal(await page.locator('.mm-answer img:visible').count(), 0);
  await showCard(page, cases.comparison_chapter[2].back);
  assert.equal(await revealed(), 2);
  assert.equal(await page.locator('.mm-answer img:visible').count(), 1, 'image back also works without storage');
  await page.evaluate(() => { Storage.prototype.getItem = window.mmGet; Storage.prototype.setItem = window.mmSet; });
  await showCard(page, cases.single[0].front.replace(/data-cloze="[^"]*"/g, ''));
  assert.equal(await page.locator('.mm-tools').isVisible(), false, 'unsupported renderer uses native fallback');
  assert.equal(await page.locator('.cloze').count(), 1);

  for (const width of [320, 360, 375, 390, 430, 844]) {
    await page.setViewportSize({width,height:width === 844 ? 390 : 844});
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({colorScheme:scheme});
      for (const name of ['mixed', 'deep', 'formatting', 'comparison_chapter', 'symmetry_chapter']) {
        const card = cases[name][name === 'comparison_chapter' ? 2 : 0];
        for (const side of name.endsWith('_chapter') ? ['front', 'back'] : ['front']) {
          await showCard(page, card[side]);
          assert.ok(await page.getByRole('searchbox').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16),
            'search input avoids small-font focus zoom on iOS');
          await action('expand').click();
          await action('show').click();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
            engine + ': Mind Map overflow ' + name + ' ' + width + ' ' + side);
          for (const img of await page.locator('.mm-tree img').all()) {
            await img.evaluate(el => el.decode());
            const box = await img.boundingBox();
            assert.ok(box.width <= width && Math.abs(box.width / box.height - 960 / 360) < .01);
            assert.equal(await img.evaluate(el => getComputedStyle(el).filter), 'none', 'night mode preserves original image colors');
          }
        }
      }
    }
  }
  await showCard(page, cases.deep[0].front);
  assert.equal(await page.locator('.mm-node').count(), 80);
  assert.equal(await page.locator('.mm-active').isVisible(), true);
  await action('collapse').click();
  await action('locate').click();
  assert.equal(await page.locator('.mm-active').isVisible(), true);

  const start = Date.now();
  await showCard(page, cases.large[0].front);
  assert.equal(await page.locator('.mm-node').count(), 2001);
  assert.equal(await page.locator('.mm-cloze').count(), 100);
  await page.evaluate(() => { window.mmLargeNode = document.querySelector('.mm-node'); });
  for (let i = 0; i < 8; i++) { await action('collapse').click(); await action('expand').click(); }
  await search('Node 1999');
  assert.equal(await page.locator('.mm-search-status').innerText(), '1/1');
  assert.equal(await page.evaluate(() => window.mmLargeNode === document.querySelector('.mm-node')), true);
  console.log(engine + ': Mind Map 2,001 nodes / 100 Clozes, init + 16 fold actions + search ' + (Date.now() - start) + 'ms');
  await action('clear').click();
  // Re-executing the same media script must not double handlers or controls.
  await page.addScriptTag({url:new URL('/cards/media/_mindmap.js', page.url()).href});
  assert.equal(await page.locator('.mm-actions').count(), 1);
  await page.locator('.mm-reveal').first().click();
  assert.equal(await revealed(), 1);
  if (engine === 'Chromium' && process.env.ANKI_SCREENSHOTS === '1') {
    await page.setViewportSize({width:390,height:844});
    await page.emulateMedia({colorScheme:'light'});
    const preview = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '../web/preview-cards.json'), 'utf8'));
    await showCard(page, preview.find(e => e.type === 'mindmap').cards[0].front);
    await action('expand').click();
    await page.locator('.mm-more summary').click();
    await page.locator('.mm-sheet').screenshot({path:path.join(__dirname, '../docs/images/preview-mindmap.png')});
  }
};
