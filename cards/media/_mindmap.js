/* Copyright (c) 2026 zzpice. MIT License. */
(function () {
  var sheet = document.querySelector('[data-mindmap]');
  if (!sheet || sheet.dataset.mmReady) return;
  sheet.dataset.mmReady = 'true';
  var tree = sheet.querySelector('.mm-tree');
  var tools = sheet.querySelector('.mm-tools');
  var back = sheet.dataset.mindmap === 'back';
  var storageKey = 'anki-template/current-mindmap';
  var nodes = [], clozes = [], results = [], marks = [];
  var searchIndex = -1, cursor = -1, query = '', key;

  // Anki owns parsing, numbering, rich answers and card generation. Unsupported
  // renderers retain the native Cloze instead of attempting a second parser.
  var nativeClozes = Array.from(tree.querySelectorAll('.cloze, .cloze-inactive'));
  if (nativeClozes.some(function (el) {
    return !el.dataset.ordinal || el.querySelector('.cloze, .cloze-inactive') ||
      (!back && el.classList.contains('cloze') && !el.hasAttribute('data-cloze'));
  })) return;
  nativeClozes.forEach(function (el) {
    var active = el.classList.contains('cloze');
    var hint = !back && active ? el.textContent : '[…]';
    var answer = !back && active ? el.getAttribute('data-cloze') : el.innerHTML;
    el.innerHTML = answer;
    el.removeAttribute('data-cloze');
    el.className = 'mm-cloze' + (active ? ' mm-active' : '');
    clozes.push({el:el, active:active, hint:hint});
  });

  function fingerprint(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16) + ':' + text.length;
  }
  key = fingerprint(sheet.querySelector('.review-context').innerHTML + tree.innerHTML);
  function readState() {
    try { return JSON.parse(sessionStorage.getItem(storageKey)); } catch (error) { return null; }
  }
  var saved = readState();
  if (!back && !document.body.hasAttribute('data-review-resume')) saved = null;
  if (!saved || saved.key !== key) saved = null;

  // Normalize only once. Parent/list references and text indexes are cached;
  // toggling changes hidden, never replaces the tree or its content.
  var listElements = Array.from(tree.querySelectorAll('ul, ol'));
  Array.from(tree.querySelectorAll('li')).forEach(function (el, index) {
    var parent = el.parentElement.closest('li');
    var node = {el:el, parent:parent ? parent.mmNode : null, lists:[], index:index};
    node.depth = node.parent ? node.parent.depth + 1 : 0;
    el.mmNode = node;
    el.classList.add('mm-node');
    el.dataset.mmDepth = node.depth;
    nodes.push(node);
  });
  listElements.forEach(function (list) {
    var owner = list.closest('li');
    list.classList.add('mm-list');
    if (owner && owner.mmNode) {
      owner.mmNode.lists.push(list);
      if (owner.mmNode.depth >= 5) list.setAttribute('data-mm-deep', '');
      // Some editor paste formats wrap a sublist in a div.
      owner.appendChild(list);
    } else list.classList.add('mm-root-list');
  });
  if (nodes.length) {
    // Paragraphs alongside a list are content too, and belong in full-text search.
    Array.from(tree.childNodes).forEach(function (child) {
      if ((child.nodeType === 1 && child.matches('ul, ol')) ||
          (child.nodeType === 3 && !child.textContent.trim())) return;
      if (child.nodeType === 1 && child.querySelector('.mm-list')) {
        var wrapper = {el:child, parent:null, lists:[], depth:0, passthrough:true};
        child.mmNode = wrapper; child.classList.add('mm-node'); nodes.push(wrapper);
        return;
      }
      var block = document.createElement('div');
      child.before(block); block.appendChild(child); block.className = 'mm-node';
      var node = {el:block, parent:null, lists:[], depth:0}; block.mmNode = node;
      nodes.push(node);
    });
    nodes.sort(function (a, b) { return a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1; });
    nodes.forEach(function (node, index) { node.index = index; });
  }
  nodes.forEach(function (node) {
    if (node.passthrough) { node.row = node.content = node.el; return; }
    var row = document.createElement('div'); row.className = 'mm-row';
    var content = document.createElement('div'); content.className = 'mm-row-content';
    Array.from(node.el.childNodes).forEach(function (child) {
      if (node.lists.indexOf(child) === -1) content.appendChild(child);
    });
    var toggle = document.createElement(node.lists.length ? 'button' : 'span');
    toggle.className = node.lists.length ? 'mm-toggle' : 'mm-leaf';
    if (node.lists.length) {
      toggle.type = 'button'; toggle.dataset.mmToggle = node.index;
      toggle.setAttribute('aria-label', '展开 / 折叠第 ' + (node.depth + 1) + ' 层节点');
    } else { toggle.textContent = '·'; toggle.setAttribute('aria-hidden', 'true'); }
    row.appendChild(toggle); row.appendChild(content);
    node.el.insertBefore(row, node.el.firstChild);
    node.row = row; node.content = content; node.toggle = toggle;
    if (node.depth >= 5) content.dataset.mmLevel = node.depth + 1;
  });
  // A field without a list is one readable node; no special authoring syntax.
  if (!nodes.length) nodes.push({el:tree, parent:null, lists:[], content:tree, row:tree, index:0});
  var branches = nodes.filter(function (node) { return node.lists.length; });

  clozes.forEach(function (cloze, index) {
    var owner = cloze.el.closest('.mm-node');
    cloze.node = owner ? owner.mmNode : nodes[0];
    var answer = document.createElement('span'); answer.className = 'mm-answer';
    while (cloze.el.firstChild) answer.appendChild(cloze.el.firstChild);
    var reveal = document.createElement('button'); reveal.type = 'button'; reveal.className = 'mm-reveal';
    reveal.textContent = cloze.hint; reveal.setAttribute('aria-label', '揭示挖空答案');
    var rehide = document.createElement('button'); rehide.type = 'button'; rehide.className = 'mm-rehide';
    rehide.textContent = '收起'; rehide.setAttribute('aria-label', '隐藏挖空答案');
    reveal.dataset.mmCloze = rehide.dataset.mmCloze = index;
    cloze.el.appendChild(reveal); cloze.el.appendChild(answer); cloze.el.appendChild(rehide);
    cloze.answer = answer; cloze.reveal = reveal; cloze.rehide = rehide;
    setRevealed(cloze, back && cloze.active);
  });

  function setRevealed(cloze, value) {
    cloze.shown = !!value;
    cloze.answer.hidden = cloze.rehide.hidden = !value;
    cloze.reveal.hidden = !!value;
  }
  function setCollapsed(node, value) {
    if (!node.lists.length) return;
    node.collapsed = !!value;
    node.lists.forEach(function (list) { list.hidden = !!value; });
    node.toggle.textContent = value ? '▸' : '▾';
    node.toggle.setAttribute('aria-expanded', String(!value));
  }
  function openPath(node) {
    for (var parent = node.parent; parent; parent = parent.parent) setCollapsed(parent, false);
  }
  nodes.forEach(function (node) {
    setCollapsed(node, saved && Array.isArray(saved.collapsed) ? saved.collapsed.indexOf(node.index) !== -1 : true);
  });
  clozes.forEach(function (cloze) { if (cloze.active) openPath(cloze.node); });
  // A repeated back (or preview resume) preserves deliberate answer controls.
  if (saved && saved.side === sheet.dataset.mindmap && Array.isArray(saved.revealed)) {
    clozes.forEach(function (cloze, index) { setRevealed(cloze, saved.revealed.indexOf(index) !== -1); });
  }

  tools.innerHTML = '<div class="mm-actions">' +
    '<button type="button" data-mm-action="locate">定位本卡</button>' +
    '<button type="button" data-mm-action="next">下一处挖空</button>' +
    '<details class="mm-more"><summary>结构与答案</summary><div class="mm-batch">' +
    '<button type="button" data-mm-action="expand">全部展开</button>' +
    '<button type="button" data-mm-action="collapse">全部折叠</button>' +
    '<button type="button" data-mm-action="show">显示全部答案</button>' +
    '<button type="button" data-mm-action="hide">隐藏全部答案</button></div></details></div>' +
    '<form class="mm-search" role="search"><input type="search" aria-label="搜索导图" placeholder="搜索导图" autocomplete="off">' +
    '<button type="submit">搜索</button><div class="mm-results">' +
    '<button type="button" data-mm-action="prev-result" aria-label="上一搜索结果">↑</button>' +
    '<span class="mm-search-status" role="status" aria-live="polite">0/0</span>' +
    '<button type="button" data-mm-action="next-result" aria-label="下一搜索结果">↓</button>' +
    '<button type="button" data-mm-action="clear">清除</button></div></form>' +
    '<p class="mm-help">下划线标记本卡挖空 · 搜索不会揭示答案</p>';
  tools.hidden = false;
  var input = tools.querySelector('input');
  var status = tools.querySelector('[role="status"]');
  var prevResult = tools.querySelector('[data-mm-action="prev-result"]');
  var nextResult = tools.querySelector('[data-mm-action="next-result"]');
  ['locate', 'next', 'show', 'hide'].forEach(function (action) {
    tools.querySelector('[data-mm-action="' + action + '"]').disabled = !clozes.length;
  });

  // Index answer text, excluding generated controls, once. Text-node ranges let
  // a literal query span bold/link boundaries without rewriting rich HTML.
  function textParts(content) {
    var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode:function (text) {
        return text.parentElement.closest('button, script, style') ||
          text.parentElement.closest('.mm-node') !== content.closest('.mm-node') ?
          NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var parts = [], offset = 0, text;
    while ((text = walker.nextNode())) {
      parts.push({el:text, start:offset, end:offset + text.length}); offset += text.length;
    }
    return parts;
  }
  nodes.forEach(function (node) { node.text = textParts(node.content).map(function (part) { return part.el.data; }).join(''); });

  function saveState() {
    var state = {key:key, side:sheet.dataset.mindmap, cursor:cursor, query:query, searchIndex:searchIndex,
      collapsed:branches.filter(function (node) { return node.collapsed; }).map(function (node) { return node.index; }),
      revealed:clozes.map(function (cloze, index) { return cloze.shown ? index : -1; }).filter(function (index) { return index >= 0; })};
    try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch (error) {}
  }
  function scrollTo(element) {
    if (!element || !sheet.isConnected) return;
    element.scrollIntoView({block:'center', behavior:'auto'});
  }
  function locate(index, scroll) {
    if (index < 0 || index >= clozes.length) return;
    if (cursor >= 0) clozes[cursor].el.classList.remove('mm-located');
    cursor = index;
    var cloze = clozes[index]; openPath(cloze.node);
    cloze.el.classList.add('mm-located');
    if (scroll) scrollTo(cloze.el);
  }
  function resultStatus() {
    status.textContent = (results.length ? searchIndex + 1 : 0) + '/' + results.length;
    prevResult.disabled = nextResult.disabled = !results.length;
  }
  function clearSearch() {
    marks.forEach(function (mark) { mark.replaceWith(document.createTextNode(mark.textContent)); });
    if (searchIndex >= 0) results[searchIndex].node.row.classList.remove('mm-search-row');
    marks = []; results = []; searchIndex = -1;
  }
  function navigateResult(index, scroll) {
    if (!results.length) return;
    if (searchIndex >= 0) {
      results[searchIndex].marks.forEach(function (mark) { mark.classList.remove('mm-search-current'); });
      results[searchIndex].node.row.classList.remove('mm-search-row');
    }
    searchIndex = (index + results.length) % results.length;
    var result = results[searchIndex]; openPath(result.node);
    result.marks.forEach(function (mark) { mark.classList.add('mm-search-current'); });
    result.node.row.classList.add('mm-search-row');
    // A hit inside a masked answer locates its node without exposing the answer.
    if (scroll) scrollTo(result.node.row);
    resultStatus();
  }
  function search(value, targetIndex, scroll) {
    clearSearch(); query = value.trim();
    if (query) {
      var regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      nodes.forEach(function (node) {
        regex.lastIndex = 0;
        var hits = [], match;
        while ((match = regex.exec(node.text))) hits.push({start:match.index, end:match.index + match[0].length, node:node, marks:[]});
        if (!hits.length) return;
        node.content.normalize();
        var hitCursor = 0;
        textParts(node.content).forEach(function (part) {
          while (hitCursor < hits.length && hits[hitCursor].end <= part.start) hitCursor++;
          var spans = [];
          for (var i = hitCursor; i < hits.length && hits[i].start < part.end; i++) spans.push(hits[i]);
          if (!spans.length) return;
          var fragment = document.createDocumentFragment(), position = 0;
          spans.forEach(function (hit) {
            var start = Math.max(hit.start - part.start, 0), end = Math.min(hit.end - part.start, part.el.length);
            fragment.appendChild(document.createTextNode(part.el.data.slice(position, start)));
            var mark = document.createElement('mark'); mark.className = 'mm-search-mark';
            mark.textContent = part.el.data.slice(start, end);
            fragment.appendChild(mark); marks.push(mark); hit.marks.push(mark); position = end;
          });
          fragment.appendChild(document.createTextNode(part.el.data.slice(position)));
          part.el.replaceWith(fragment);
        });
        hits.forEach(function (hit) { results.push(hit); });
      });
    }
    navigateResult(Math.max(0, Math.min(targetIndex, results.length - 1)), scroll);
    resultStatus();
  }

  // Local listeners disappear with the current card. Never consume rating keys
  // unless a tree control has focus.
  sheet.addEventListener('keydown', function (event) {
    if (event.target.closest('button, input, summary')) event.stopPropagation();
  });
  sheet.addEventListener('submit', function (event) {
    if (!event.target.classList.contains('mm-search')) return;
    event.preventDefault(); event.stopPropagation();
    search(input.value, 0, true); input.blur(); saveState();
  });
  sheet.addEventListener('click', function (event) {
    if (event.target.closest('.mm-tools')) event.stopPropagation();
    var button = event.target.closest('button');
    if (!button || !sheet.contains(button)) return;
    event.stopPropagation();
    if (button.hasAttribute('data-mm-toggle')) {
      var node = nodes[Number(button.dataset.mmToggle)]; setCollapsed(node, !node.collapsed);
    } else if (button.hasAttribute('data-mm-cloze')) {
      var cloze = clozes[Number(button.dataset.mmCloze)]; setRevealed(cloze, !cloze.shown);
    } else {
      switch (button.dataset.mmAction) {
        case 'expand': branches.forEach(function (node) { setCollapsed(node, false); }); break;
        case 'collapse': branches.forEach(function (node) { setCollapsed(node, true); }); break;
        case 'show': clozes.forEach(function (cloze) { setRevealed(cloze, true); }); break;
        case 'hide': clozes.forEach(function (cloze) { setRevealed(cloze, false); }); break;
        case 'locate': locate(clozes.findIndex(function (cloze) { return cloze.active; }), true); break;
        case 'next': locate((cursor + 1) % clozes.length, true); break;
        case 'prev-result': navigateResult(searchIndex - 1, true); break;
        case 'next-result': navigateResult(searchIndex + 1, true); break;
        case 'clear': input.value = ''; search('', 0, false); break;
      }
    }
    saveState();
  });
  var firstActive = clozes.findIndex(function (cloze) { return cloze.active; });
  if (firstActive >= 0) locate(saved && Number.isInteger(saved.cursor) && saved.cursor >= 0 && saved.cursor < clozes.length ? saved.cursor : firstActive, false);
  if (saved && typeof saved.query === 'string') { input.value = saved.query; search(saved.query, saved.searchIndex || 0, false); }
  resultStatus(); saveState();
  // One bounded layout callback; no observers, polling, hooks or document-level
  // listeners survive replacement of the current card.
  requestAnimationFrame(function () { if (cursor >= 0) scrollTo(clozes[cursor].el); });
})();
