/*
MIT License

Copyright (c) 2026 zzpice

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
(function () {
  'use strict';
  var back = !!document.querySelector('[data-review-back], #answer');
  var stateKey = 'anki-template/current-choice';
  var sheets = Array.from(document.querySelectorAll('[data-review]'));

  // One ephemeral record. Never write fields, grades, scheduling or durable history.
  function readState() {
    try { return JSON.parse(sessionStorage.getItem(stateKey)); } catch (error) { return null; }
  }
  function saveState(state) {
    try { sessionStorage.setItem(stateKey, JSON.stringify(state)); return true; } catch (error) { return false; }
  }
  function seededRandom(text) {
    var seed = 2166136261;
    for (var i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
    seed = seed || 1;
    return function () {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
  }
  function shuffle(order, random) {
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1)), value = order[i];
      order[i] = order[j]; order[j] = value;
    }
  }
  function tags(sheet, selector) {
    var field = sheet.querySelector(selector);
    return field ? field.textContent.trim().split(/\s+/) : [];
  }
  function message(parent, text, className) {
    var element = document.createElement('p');
    element.className = className || 'review-feedback';
    element.setAttribute('role', 'status'); element.textContent = text;
    parent.appendChild(element); return element;
  }

  function mountChoice(sheet) {
    var options = sheet.querySelector('[data-options]');
    if (!options || options.dataset.ready) return;
    options.dataset.ready = 'true';
    var parts = options.innerHTML.split('||');
    if (parts.length < 2 || parts.length > 26 || parts.some(function (part) { return !part.trim(); })) {
      message(sheet, '选项需填写 2–26 项，用 || 分隔；请编辑笔记后再复习。');
      return;
    }
    var typeField = sheet.querySelector('[data-question-type]');
    var type = typeField ? typeField.textContent.trim() : '';
    var badge = sheet.querySelector('[data-choice-kind]');
    if (badge && ['单选', '多选', '判断'].indexOf(type) !== -1) badge.textContent = type;
    var noteTags = tags(sheet, '[data-choice-tags]');
    var fixed = type === '判断' || noteTags.indexOf('固定顺序') !== -1;
    var key = JSON.stringify([sheet.querySelector('.review-question').innerHTML, parts, type, fixed]);
    var state = readState();
    var valid = state && state.key === key && Array.isArray(state.order) &&
      state.order.length === parts.length && new Set(state.order).size === parts.length &&
      state.order.every(function (i) { return Number.isInteger(i) && i >= 0 && i < parts.length; }) &&
      Array.isArray(state.selected) && state.selected.every(function (value) { return /^[A-Z]$/.test(value) && value.charCodeAt(0) - 65 < parts.length; });
    if (!valid) {
      state = {key:key, order:parts.map(function (_, i) { return i; }), selected:[]};
      // Persist the final order, then verify a read round trip. Write-only or
      // blocked storage must use the same deterministic order on both sides.
      if (!fixed) shuffle(state.order, Math.random);
      var stored = !back && saveState(state) ? readState() : null;
      if (!stored || stored.key !== key || JSON.stringify(stored.order) !== JSON.stringify(state.order)) {
        state.order = parts.map(function (_, i) { return i; });
        if (!fixed) shuffle(state.order, seededRandom(key));
      }
    }
    if (!back) saveState(state);
    options.textContent = '';
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', type === '多选' ? '多选选项' : '单选选项');
    state.order.forEach(function (sourceIndex, displayIndex) {
      var sourceKey = String.fromCharCode(65 + sourceIndex);
      var row = document.createElement('div'); row.className = 'review-choice';
      row.dataset.key = sourceKey; row.dataset.displayKey = String.fromCharCode(65 + displayIndex);
      var input = document.createElement('input');
      input.type = type === '多选' ? 'checkbox' : 'radio';
      input.name = 'review-choice'; input.id = 'review-choice-' + sourceKey; input.value = sourceKey;
      input.checked = state.selected.indexOf(sourceKey) !== -1;
      row.classList.toggle('is-selected', input.checked);
      var label = document.createElement('label'); label.htmlFor = input.id;
      var letter = document.createElement('span'); letter.className = 'review-choice-key'; letter.textContent = row.dataset.displayKey;
      var content = document.createElement('div'); content.className = 'content'; content.innerHTML = parts[sourceIndex].trim();
      label.appendChild(letter); label.appendChild(content);
      row.appendChild(input); row.appendChild(label); options.appendChild(row);
    });
    if (noteTags.indexOf('先回忆') !== -1) {
      var recall = document.createElement('details'); recall.className = 'review-recall'; recall.open = back;
      var summary = document.createElement('summary'); summary.textContent = '回忆后，展开选项';
      options.before(recall); recall.appendChild(summary); recall.appendChild(options);
    }
    options.addEventListener('change', function () {
      state.selected = Array.from(options.querySelectorAll('input:checked')).map(function (input) { return input.value; });
      options.querySelectorAll('.review-choice').forEach(function (row) {
        row.classList.toggle('is-selected', row.querySelector('input').checked);
      });
      saveState(state);
    });
  }

  function renderChoiceAnswer(sheet, options) {
    var answer = document.querySelector('[data-answer]');
    if (!answer || options.dataset.answered) return;
    options.dataset.answered = 'true';
    var rows = Array.from(options.querySelectorAll('.review-choice'));
    var key = answer ? answer.textContent.toUpperCase().replace(/[\s,，、]/g, '') : '';
    var valid = /^[A-Z]+$/.test(key) && key.split('').every(function (letter) { return letter.charCodeAt(0) - 65 < rows.length; });
    if (valid) {
      answer.dataset.key = key; answer.textContent = '';
      rows.filter(function (row) { return key.indexOf(row.dataset.key) !== -1; }).forEach(function (row) {
        var item = document.createElement('div'); item.className = 'review-answer-choice';
        item.appendChild(row.querySelector('.review-choice-key').cloneNode(true));
        item.appendChild(row.querySelector('.content').cloneNode(true)); answer.appendChild(item);
      });
    }
    var wrong = 0, missed = 0, selected = rows.filter(function (row) { return row.querySelector('input').checked; }).length;
    rows.forEach(function (row) {
      var input = row.querySelector('input'); input.disabled = true;
      var correct = valid && key.indexOf(row.dataset.key) !== -1;
      if (!input.checked && !correct) return;
      var marks = document.createElement('span'); marks.className = 'review-choice-marks'; row.appendChild(marks);
      if (input.checked) {
        var picked = document.createElement('span'); picked.className = 'review-selected'; picked.textContent = '已选'; marks.appendChild(picked);
      }
      if (!valid) return;
      var mark = document.createElement('span'); marks.appendChild(mark);
      if (correct) {
        row.classList.add('is-correct'); mark.className = 'review-correct';
        mark.textContent = input.checked || !selected ? '✓ 正确' : '✓ 漏选';
        if (!input.checked) missed++;
      } else {
        wrong++; row.classList.add('is-wrong'); mark.className = 'review-wrong'; mark.textContent = '× 错选';
      }
    });
    message(sheet, !valid ? '请按参考答案自行核对。' : !selected ? '本次未作选择，请核对参考答案。' :
      !wrong && !missed ? '选择与答案一致。请按实际回忆情况评分。' :
      '错选 ' + wrong + ' 项 · 漏选 ' + missed + ' 项。请核对后评分。');
  }

  function openImage(image, sheet) {
    if (sheet.querySelector('.review-zoom')) return;
    var dialog = document.createElement('dialog');
    if (typeof dialog.showModal !== 'function') return; // Keep the original image usable.
    dialog.className = 'review-zoom'; dialog.setAttribute('aria-label', '图片放大'); dialog.dataset.size = 'fit';
    var toolbar = document.createElement('div'); toolbar.className = 'review-zoom-tools';
    var close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
    var size = document.createElement('button'); size.type = 'button'; size.textContent = '原始尺寸'; size.setAttribute('aria-pressed', 'false');
    toolbar.appendChild(size); toolbar.appendChild(close); dialog.appendChild(toolbar);
    var stage = document.createElement('div'); stage.className = 'review-zoom-stage'; stage.tabIndex = 0;
    stage.setAttribute('role', 'region'); stage.setAttribute('aria-label', '放大图片，可滚动查看');
    var enlarged = document.createElement('img'); enlarged.src = image.currentSrc || image.src; enlarged.alt = image.alt;
    stage.appendChild(enlarged); dialog.appendChild(stage);
    if (image.alt) { var caption = document.createElement('p'); caption.className = 'review-zoom-caption'; caption.textContent = image.alt; dialog.appendChild(caption); }
    sheet.appendChild(dialog);
    size.addEventListener('click', function () {
      var actual = dialog.dataset.size !== 'actual'; dialog.dataset.size = actual ? 'actual' : 'fit';
      size.textContent = actual ? '适应屏幕' : '原始尺寸'; size.setAttribute('aria-pressed', String(actual));
    });
    close.addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (event) { event.stopPropagation(); if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('keydown', function (event) { event.stopPropagation(); });
    dialog.addEventListener('close', function () { dialog.remove(); if (image.isConnected) image.focus(); });
    dialog.showModal(); close.focus();
  }

  function mountCloze(sheet) {
    if (back || sheet.dataset.review !== 'cloze' || tags(sheet, '[data-review-tags]').indexOf('逐项揭示') === -1) return;
    var clozes = Array.from(sheet.querySelectorAll('.cloze'));
    // Nested / older native output stays native; no custom Cloze syntax parser.
    if (clozes.some(function (el) {
      if (!el.hasAttribute('data-cloze') || el.closest('.cloze-inactive') || el.querySelector('.cloze, .cloze-inactive')) return true;
      var answer = el.getAttribute('data-cloze'), probe = document.createElement('div');
      probe.innerHTML = answer;
      return probe.querySelector('.cloze, .cloze-inactive, a, button, input, textarea, select, audio, video, table, pre, ul, ol, div, p') || /\\(?:\(|\[)/.test(answer);
    })) return;
    clozes.forEach(function (el) {
      var hint = document.createElement('span'), answer = document.createElement('span');
      hint.innerHTML = el.innerHTML;
      answer.innerHTML = el.getAttribute('data-cloze'); answer.hidden = true;
      var button = document.createElement('button'); button.type = 'button'; button.className = 'review-cloze-toggle';
      button.appendChild(hint); button.appendChild(answer);
      // Let the visible hint / rich answer name the button for screen readers.
      button.title = '揭示或隐藏这一处填空'; button.setAttribute('aria-expanded', 'false');
      el.textContent = ''; el.appendChild(button);
      button.addEventListener('click', function () {
        var reveal = button.getAttribute('aria-expanded') !== 'true';
        hint.hidden = reveal; answer.hidden = !reveal;
        button.setAttribute('aria-expanded', String(reveal));
      });
    });
  }

  function mountContent(sheet) {
    sheet.querySelectorAll('.review-context, .review-meta').forEach(function (element) {
      if (!element.childElementCount && !element.textContent.trim()) element.hidden = true;
    });
    sheet.querySelectorAll('table').forEach(function (table) {
      if (table.parentElement.classList.contains('review-scroll')) return;
      var wrapper = document.createElement('div'); wrapper.className = 'review-scroll'; wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', '表格，可左右滚动');
      table.before(wrapper); wrapper.appendChild(table);
    });
    sheet.querySelectorAll('.content img').forEach(function (image) {
      if (image.closest('a, button, #image-occlusion-container') || image.classList.contains('no-zoom')) return;
      image.tabIndex = 0; image.setAttribute('role', 'button'); image.setAttribute('aria-label', '放大图片' + (image.alt ? '：' + image.alt : ''));
    });
    sheet.addEventListener('click', function (event) {
      var target = event.target;
      if (target.closest('.review-choice, details, button, #toggle')) event.stopPropagation();
      var image = target.closest('.content img');
      if (!image || image.closest('a, button, #image-occlusion-container') || image.classList.contains('no-zoom')) return;
      event.preventDefault(); event.stopPropagation(); openImage(image, sheet);
    });
    sheet.addEventListener('keydown', function (event) {
      // Only focused in-card controls consume keys; Anki rating shortcuts stay native.
      if (event.target.closest('input, button, summary')) event.stopPropagation();
      if (event.target.matches('.content img[role="button"]') && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); event.stopPropagation(); openImage(event.target, sheet);
      }
    });
  }

  function mountOcclusion() {
    var container = document.getElementById('image-occlusion-container');
    if (!container || container.dataset.ready) return;
    container.dataset.ready = 'true';
    function unavailable() {
      if (!container.isConnected) return;
      container.hidden = true; // Never disclose the unmasked image on failure.
      var error = document.getElementById('occlusion-error');
      error.hidden = false; error.textContent = '请使用支持原生图片遮挡的 Anki 客户端打开这张卡片。';
      var toggle = document.getElementById('toggle'); if (toggle) toggle.hidden = true;
    }
    try {
      var setup = anki.imageOcclusion.setup({onDidDrawShapes:function () {
        if (!container.isConnected) return;
        container.style.visibility = 'visible';
        document.getElementById('occlusion-error').hidden = true;
      }});
      if (setup && typeof setup.catch === 'function') setup.catch(unavailable);
    } catch (error) { unavailable(); }
  }

  if (!back && !document.body.hasAttribute('data-review-resume') && sheets.some(function (sheet) { return !sheet.dataset.ready; })) {
    try { sessionStorage.removeItem(stateKey); } catch (error) {}
  }
  sheets.forEach(function (sheet) {
    if (!sheet.dataset.ready) {
      sheet.dataset.ready = 'true';
      mountChoice(sheet); mountCloze(sheet); mountContent(sheet);
    }
    // FrontSide scripts may run before the answer section has been parsed.
    // The back's trailing script completes annotation once the answer exists.
    var options = sheet.querySelector('[data-options]');
    if (back && options && options.querySelector('.review-choice')) renderChoiceAnswer(sheet, options);
  });
  mountOcclusion();
})();
