// New interactions and failure paths, using only official backend output.
const assert = require('node:assert/strict');

module.exports = async function checkReview(page, showCard, cases) {
  const sample = name => cases[name][0];
  await showCard(page, sample('recall_first').front);
  assert.equal(await page.locator('.review-kind').innerText(), '多选');
  assert.equal(await page.locator('.review-options').isVisible(), false);
  await page.locator('.review-recall summary').click();
  await page.locator('#review-choice-A').check();
  await page.locator('#review-choice-B').check();
  await page.addScriptTag({url:new URL('/cards/media/_review.js', page.url()).href});
  assert.equal(await page.locator('.review-choice').count(), 3, 'duplicate init must preserve choices');
  assert.equal(await page.locator('input:checked').count(), 2);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('anki-template/current-choice')).selected.length), 2);
  await showCard(page, sample('recall_first').back);
  assert.equal(await page.locator('.review-options').isVisible(), true);
  assert.equal(await page.locator('.is-wrong').getAttribute('data-key'), 'B');
  assert.match(await page.locator('.review-feedback').innerText(), /错选 1 项 · 漏选 1 项/);
  assert.match(await page.locator('.is-correct[data-key="C"]').innerText(), /漏选/);
  await page.addScriptTag({url:new URL('/cards/media/_review.js', page.url()).href});
  assert.equal(await page.locator('.review-feedback').count(), 1);
  // A WebView may permit writes but deny reads; both sides must still agree.
  await page.evaluate(() => { window.reviewGet = Storage.prototype.getItem; Storage.prototype.getItem = () => { throw new Error('read blocked'); }; });
  await showCard(page, sample('storage').front);
  const fallbackOrder = await page.locator('.review-choice').evaluateAll(rows => rows.map(row => row.dataset.key));
  await showCard(page, sample('storage').back);
  assert.deepEqual(await page.locator('.review-choice').evaluateAll(rows => rows.map(row => row.dataset.key)), fallbackOrder);
  assert.equal(await page.locator('.is-correct').getAttribute('data-key'), 'B');
  await page.evaluate(() => { Storage.prototype.getItem = window.reviewGet; });
  await showCard(page, sample('invalid_options').front);
  assert.equal(await page.locator('.review-choice').count(), 0);
  assert.match(await page.locator('.review-feedback').innerText(), /选项需填写/);

  await showCard(page, sample('progressive').front);
  const toggles = page.locator('.review-cloze-toggle');
  assert.equal(await toggles.count(), 2);
  assert.equal(await page.locator('.review-question img').isVisible(), false, 'image answers start masked');
  await toggles.first().focus();
  await page.keyboard.press('Space');
  assert.equal(await toggles.first().getAttribute('aria-expanded'), 'true');
  assert.equal(await toggles.nth(1).getAttribute('aria-expanded'), 'false');
  assert.match(await toggles.first().innerText(), /甲 & A/);
  await toggles.first().click();
  assert.equal(await toggles.first().getAttribute('aria-expanded'), 'false');
  await toggles.nth(1).click();
  await page.locator('.review-question img').evaluate(el => el.decode());
  assert.equal(await page.locator('.review-question img').isVisible(), true);
  await page.evaluate(() => { window.progressiveImage = document.querySelector('.review-question img'); });
  for (let i = 0; i < 4; i++) await toggles.nth(1).click();
  assert.equal(await page.evaluate(() => window.progressiveImage === document.querySelector('.review-question img')), true);
  await showCard(page, sample('progressive').back);
  assert.equal(await page.locator('.review-cloze-toggle').count(), 0);
  assert.equal(await page.locator('.cloze').count(), 2);
  assert.match(await page.locator('.cloze').first().innerText(), /甲 & A/);
  for (const card of cases.math_cloze) {
    await showCard(page, card.front);
    assert.equal(await page.locator('.review-cloze-toggle').count(), 0, 'formula and block answers stay native');
  }
  await showCard(page, sample('nested').front);
  assert.equal(await page.locator('.review-cloze-toggle').count(), 0, 'nested Cloze keeps native output');

  await showCard(page, sample('rich').back);
  const image = page.locator('.review-question img');
  await image.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', {name:'原始尺寸', exact:true}).click();
  const stage = page.locator('.review-zoom-stage');
  assert.ok(await stage.evaluate(el => el.scrollWidth > el.clientWidth));
  await stage.evaluate(el => { el.scrollLeft = 80; });
  assert.ok(await stage.evaluate(el => el.scrollLeft > 0));
  await page.getByRole('button', {name:'适应屏幕', exact:true}).click();
  assert.equal(await page.locator('dialog').getAttribute('data-size'), 'fit');
  await page.keyboard.press('Escape');
  await page.locator('dialog').waitFor({state:'detached'});
  assert.equal(await image.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('.review-scroll').count(), 1);
  assert.equal(await page.locator('[dir="rtl"]').getAttribute('dir'), 'rtl');
  assert.equal(await page.locator('ruby rt').innerText(), 'かんじ');
  // Without a dialog API, ordinary content is still readable and no exception fires.
  await page.evaluate(() => { window.savedShowModal = HTMLDialogElement.prototype.showModal; HTMLDialogElement.prototype.showModal = undefined; });
  await image.click();
  assert.equal(await page.locator('dialog').count(), 0);
  await page.evaluate(() => { HTMLDialogElement.prototype.showModal = window.savedShowModal; });

  const pixel = async (x, y) => page.locator('canvas').evaluate((el, point) => Array.from(el.getContext('2d')
    .getImageData(Math.round(el.width * point[0]), Math.round(el.height * point[1]), 1, 1).data), [x, y]);
  await showCard(page, sample('io_hide_one').front);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#image-occlusion-container')).visibility === 'visible');
  assert.equal((await pixel(.2, .2))[3], 255);
  assert.equal((await pixel(.7, .2))[3], 0, 'hide-one leaves inactive areas visible');
  await showCard(page, sample('io_hide_one').back);
  assert.equal((await pixel(.2, .2))[3], 0);
  assert.equal(await page.locator('#toggle').isVisible(), false);
  await showCard(page, sample('io_group').front);
  assert.equal((await pixel(.2, .2))[3], 255);
  assert.equal((await pixel(.6, .6))[3], 255, 'ellipse grouped with rectangle');
  assert.equal((await pixel(.2, .7))[3], 255, 'inactive polygon stays masked');
  await showCard(page, sample('io_group').back);
  assert.equal((await pixel(.2, .2))[3], 0);
  assert.equal((await pixel(.6, .6))[3], 0);
  assert.equal((await pixel(.2, .7))[3], 255);
  // Missing / rejecting native APIs must fail closed, including async failures.
  await page.evaluate(() => { window.savedSetup = anki.imageOcclusion.setup; anki.imageOcclusion.setup = () => Promise.reject(new Error('unsupported')); });
  await showCard(page, sample('io_hide_one').front);
  assert.equal(await page.locator('#image-occlusion-container').isVisible(), false);
  assert.match(await page.locator('#occlusion-error').innerText(), /支持原生图片遮挡/);
  await page.evaluate(() => { anki.imageOcclusion.setup = window.savedSetup; });
};
