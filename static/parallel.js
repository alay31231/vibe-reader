"use strict";

function paragraphLabel(number) { return String(number).padStart(3, '0'); }

function buildParagraphLink(documentId, paragraph) {
  const url = new URL(buildDeepLink(documentId, null));
  url.hash = `p${paragraphLabel(paragraph)}`;
  return url.toString();
}

function parseParagraphReference(value) {
  const match = value.trim().match(/^(?:(.+?)\s*§\s*)?(?:p)?(\d+)$/i);
  return match && Number(match[2]) > 0 ? { code: match[1]?.trim(), paragraph: Number(match[2]) } : null;
}

function passageMarkdown(text, target) {
  renderMarkdown(text, target);
  target.querySelectorAll('.line-link,.line-anchor-alias').forEach(node => node.remove());
  target.querySelectorAll('.source-block').forEach(node => {
    node.removeAttribute('id');
    node.classList.remove('source-block');
    delete node.dataset.lineStart;
    delete node.dataset.lineEnd;
  });
}

function renderParallel(documentInfo) {
  const parallel = documentInfo.parallel;
  const fragment = document.createDocumentFragment();
  const title = document.createElement('h1');
  title.textContent = documentInfo.title;
  fragment.append(title);
  const summary = document.createElement('p');
  summary.className = 'parallel-summary';
  summary.textContent = `${parallel.code} · ${parallel.paragraph_count} 段 · 已有译文 ${parallel.translated_count} 段`;
  fragment.append(summary);
  if (parallel.warnings.length) {
    const warning = document.createElement('p');
    warning.className = 'parallel-warning';
    warning.textContent = parallel.warnings.join(' ');
    fragment.append(warning);
  }
  parallel.rows.forEach(row => {
    if (row.kind !== 'pair') {
      const block = document.createElement('div');
      passageMarkdown(row.text, block);
      addLineMetadata(block, row.line, row.end_line);
      fragment.append(block);
      return;
    }
    const pair = document.createElement('section');
    pair.className = 'parallel-pair';
    pair.dataset.paragraphStart = row.start;
    pair.dataset.paragraphEnd = row.end;
    addLineMetadata(pair, row.line, row.end_line);
    for (let number = row.start; number <= row.end; number++) {
      const anchor = document.createElement('span');
      anchor.id = `p${paragraphLabel(number)}`;
      anchor.className = 'paragraph-anchor';
      anchor.setAttribute('aria-hidden', 'true');
      pair.append(anchor);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'paragraph-link';
    copy.dataset.paragraphLink = row.start;
    copy.textContent = `${parallel.code} §${paragraphLabel(row.start)}${row.end > row.start ? `–${paragraphLabel(row.end)}` : ''}`;
    copy.title = '复制这一段的定位链接';
    pair.append(copy);
    const source = document.createElement('div');
    source.className = 'parallel-source';
    const sourceLabel = document.createElement('p');
    sourceLabel.className = 'language-label';
    sourceLabel.textContent = `原文 · L${row.line}${row.end_line > row.line ? `–L${row.end_line}` : ""}`;
    source.append(sourceLabel);
    row.source.forEach(item => {
      const content = document.createElement('div');
      passageMarkdown(item.text, content);
      source.append(content);
    });
    pair.append(source);
    const translation = document.createElement('div');
    translation.className = 'parallel-translation';
    if (row.translation) {
      const label = document.createElement('p');
      label.className = 'language-label';
      label.textContent = `中文译文${row.end > row.start ? ' · 合译本组原文' : ''}`;
      const content = document.createElement('div');
      passageMarkdown(row.translation.text, content);
      translation.append(label, content);
    } else {
      pair.classList.add('untranslated');
      translation.textContent = parallel.translation_available ? '这一段暂无可配对译文。' : '本篇尚未提供中文译文。';
    }
    pair.append(translation);
    fragment.append(pair);
  });
  if (parallel.translation_notes.length || parallel.unpaired_translations.length) {
    const notes = document.createElement('details');
    notes.className = 'translation-notes';
    const summary = document.createElement('summary');
    summary.textContent = '译者说明与译注（非原文）';
    notes.append(summary);
    const content = document.createElement('div');
    passageMarkdown(parallel.translation_notes.map(item => item.text).join('\n\n'), content);
    notes.append(content);
    if (parallel.unpaired_translations.length) {
      const unpaired = document.createElement('div');
      passageMarkdown('## 未配对译文\n\n' + parallel.unpaired_translations.map(item => `[${item.start}-${item.end}] ${item.text}`).join('\n\n'), unpaired);
      notes.append(unpaired);
    }
    fragment.append(notes);
  }
  elements.reader.replaceChildren(fragment);
}

function paragraphBlock(paragraph) {
  return [...elements.reader.querySelectorAll('.parallel-pair')].find(pair =>
    Number(pair.dataset.paragraphStart) <= paragraph && Number(pair.dataset.paragraphEnd) >= paragraph);
}

function goToParagraph(paragraph, behavior = 'auto', scroll = true) {
  const pair = paragraphBlock(paragraph);
  if (!pair) { showToast(`未找到第 ${paragraph} 段，请核对文档码与段号。`); return false; }
  clearHighlight();
  pair.classList.add('targeted');
  document.documentElement.dataset.targetParagraph = String(paragraph);
  document.querySelector('#clear-highlight').hidden = false;
  if (scroll) pair.scrollIntoView({ behavior, block: 'start' });
  return true;
}

function parallelCitation(text, line, endLine) {
  const rows = state.currentDocument.parallel.rows.filter(row => row.kind === 'pair' && row.end_line >= line && row.line <= endLine);
  if (!rows.length) return null;
  const first = rows[0], last = rows.at(-1);
  const code = state.currentDocument.parallel.code;
  return `${text.split('\n').map(part => `> ${part}`).join('\n')}\n\n— [${code}§${paragraphLabel(first.start)}${last.end > first.start ? `–${paragraphLabel(last.end)}` : ''}](${buildParagraphLink(state.currentDocument.id, first.start)})`;
}

function copyParallelContext() {
  const parallel = state.currentDocument?.parallel;
  if (!parallel) return false;
  const selected = elements.reader.querySelector('.parallel-pair.targeted') || currentBlock();
  const rows = parallel.rows.filter(row => row.kind === 'pair');
  let index = rows.findIndex(row => row.start === Number(selected?.dataset.paragraphStart));
  if (index < 0) index = 0;
  const text = rows.slice(Math.max(0, index - 1), index + 2).map(row => {
    return `## ${parallel.code}§${paragraphLabel(row.start)}\n${buildParagraphLink(state.currentDocument.id, row.start)}\n\n原文：\n${row.source.map(item => item.text).join('\n\n')}\n\n已有中文译文：\n${row.translation?.text || '暂无译文'}`;
  }).join('\n\n');
  copyText(text + '\n\n请区分原文、译文与推断，并在引用时附上实际段落链接。\n我的问题：', '已复制相邻段落的原译文与段落链接');
  return true;
}

function installParallelHandlers() {
  document.querySelector('#translated-only').addEventListener('change', updateDocumentList);
  document.querySelector('#parallel-view').addEventListener('change', event => {
    const selected = elements.reader.querySelector('.parallel-pair.targeted') || currentBlock();
    document.documentElement.dataset.readerView = event.target.value;
    selected?.scrollIntoView({ block: 'start' });
    updateReadingPosition();
  });
  document.querySelector('#paragraph-form').addEventListener('submit', async event => {
    event.preventDefault();
    const target = parseParagraphReference(document.querySelector('#paragraph-input').value);
    if (!target) return showToast('请输入段号（如 042）或 文档码§段号（如 VC-01§042）。');
    closePanels();
    if (target.code) {
      const url = new URL(window.location.href);
      url.search = new URLSearchParams({ ref: `${target.code}§${target.paragraph}` });
      url.hash = '';
      try { await openReaderURL(url, true); } catch (error) { showToast(error.message); }
    } else if (state.currentDocument?.parallel) {
      await loadDocument(state.currentDocument.id, { paragraph: target.paragraph, pushHistory: true });
    } else showToast('当前材料没有固定段号，请输入文档码§段号，或使用原文行号定位。');
  });
  elements.reader.addEventListener('click', event => {
    const button = event.target.closest('[data-paragraph-link]');
    if (button) copyText(buildParagraphLink(state.currentDocument.id, Number(button.dataset.paragraphLink)), '已复制段落定位链接');
  });
}
