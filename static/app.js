"use strict";

const elements = {
  reader: document.querySelector("#reader"),
  emptyState: document.querySelector("#empty-state"),
  loadingState: document.querySelector("#loading-state"),
  libraryButton: document.querySelector("#library-button"),
  documentMenuButton: document.querySelector("#document-menu-button"),
  documentTitle: document.querySelector("#document-title"),
  libraryPanel: document.querySelector("#library-panel"),
  searchPanel: document.querySelector("#search-panel"),
  scrim: document.querySelector("#scrim"),
  documentList: document.querySelector("#document-list"),
  importButton: document.querySelector("#import-button"),
  emptyImportButton: document.querySelector("#empty-import-button"),
  fileInput: document.querySelector("#file-input"),
  searchButton: document.querySelector("#search-button"),
  searchForm: document.querySelector("#search-form"),
  searchInput: document.querySelector("#search-input"),
  searchCurrentDocument: document.querySelector("#search-current-document"),
  searchStatus: document.querySelector("#search-status"),
  searchResults: document.querySelector("#search-results"),
  fontSmaller: document.querySelector("#font-smaller"),
  fontLarger: document.querySelector("#font-larger"),
  fontSize: document.querySelector("#font-size"),
  dropZone: document.querySelector("#drop-zone"),
  copyLinkButton: document.querySelector("#copy-link-button"),
  toast: document.querySelector("#toast"),
  selectionToolbar: document.querySelector("#selection-toolbar"),
  navigationPanel: document.querySelector("#navigation-panel"),
  outline: document.querySelector("#outline"),
  libraryFilter: document.querySelector("#library-filter"),
  readingPosition: document.querySelector("#reading-position"),
  returnButton: document.querySelector("#return-button"),
};

const state = {
  documents: [],
  currentDocument: null,
  activePanel: null,
  fontSize: Number(localStorage.getItem("vibe-reader:font-size")) || 19,
  searchTimer: null,
  scrollTimer: null,
  toastTimer: null,
  dragDepth: 0,
  selectionLine: null,
  selectionEndLine: null,
  selectionText: "",
  loadVersion: 0,
  searchVersion: 0,
  navigationStack: [],
  panelOpener: null,
};

const supportedExtensions = [".md", ".markdown", ".txt"];
let desktopPreferencesAvailable = false;

async function restoreDesktopPreferences() {
  try {
    const response = await fetch("/api/desktop-preferences");
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return;
    const payload = await response.json();
    if (!payload.preferences || typeof payload.preferences !== "object") return;
    for (const [key, value] of Object.entries(payload.preferences)) {
      if (key.startsWith("vibe-reader:") && typeof value === "string") localStorage.setItem(key, value);
    }
    desktopPreferencesAvailable = true;
    state.fontSize = Number(localStorage.getItem("vibe-reader:font-size")) || 19;
  } catch { /* The legacy browser server has no desktop preferences API. */ }
}

function rememberPreference(key, value) {
  localStorage.setItem(key, value);
  if (!desktopPreferencesAvailable) return;
  fetch("/api/desktop-preferences", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }), keepalive: true,
  }).catch(() => {});
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeURL(value, image = false) {
  const trimmed = value.trim();
  if (/^(https?:|mailto:|#|\/)/i.test(trimmed)) return trimmed;
  if (image && /^data:image\//i.test(trimmed)) return trimmed;
  if (!/^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    if (image && state.currentDocument?.id) {
      return `/api/documents/${encodeURIComponent(state.currentDocument.id)}/asset?path=${encodeURIComponent(trimmed)}`;
    }
    return trimmed;
  }
  return "#";
}

function inlineMarkdown(source) {
  const tokens = [];
  const reserve = (html) => {
    const index = tokens.push(html) - 1;
    return `\u0000${index}\u0000`;
  };

  let text = String(source);
  text = text.replace(/`([^`\n]+)`/g, (_, code) => reserve(`<code>${escapeHTML(code)}</code>`));
  text = text.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+["']([^"']*)["'])?\)/g, (_, alt, url, title) => {
    const titleAttribute = title ? ` title="${escapeHTML(title)}"` : "";
    return reserve(
      `<img src="${escapeHTML(safeURL(url, true))}" alt="${escapeHTML(alt)}"${titleAttribute} loading="lazy">`
    );
  });
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+["']([^"']*)["'])?\)/g, (_, label, url, title) => {
    const titleAttribute = title ? ` title="${escapeHTML(title)}"` : "";
    return reserve(
      `<a href="${escapeHTML(safeURL(url))}"${titleAttribute} target="_blank" rel="noreferrer">${escapeHTML(label)}</a>`
    );
  });

  text = escapeHTML(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  text = text.replace(/  \n/g, "<br>");
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || "");
  return text;
}

function blockStarts(lines, index) {
  const line = lines[index] || "";
  const next = lines[index + 1] || "";
  return (
    /^#{1,6}\s+/.test(line) ||
    /^\s*(```|~~~)/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-+*])\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line) ||
    (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(next))
  );
}

function addLineMetadata(element, startLine, endLine) {
  element.classList.add("source-block");
  element.id = `L${startLine}`;
  element.dataset.lineStart = String(startLine);
  element.dataset.lineEnd = String(endLine);

  for (let line = startLine + 1; line <= endLine; line += 1) {
    const alias = document.createElement("span");
    alias.id = `L${line}`;
    alias.className = "line-anchor-alias";
    alias.dataset.aliasFor = String(startLine);
    alias.setAttribute("aria-hidden", "true");
    element.prepend(alias);
  }

  const lineLink = document.createElement("button");
  lineLink.className = "line-link";
  lineLink.type = "button";
  lineLink.dataset.line = String(startLine);
  lineLink.title = `复制第 ${startLine} 行的链接`;
  lineLink.setAttribute("aria-label", `复制第 ${startLine} 行的链接`);
  lineLink.textContent = String(startLine);
  element.prepend(lineLink);
  return element;
}

function createTextBlock(tagName, html, startLine, endLine = startLine) {
  const element = document.createElement(tagName);
  element.innerHTML = html;
  return addLineMetadata(element, startLine, endLine);
}

function parseTable(lines, startIndex) {
  const rows = [];
  let index = startIndex;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(lines[index]);
    index += 1;
  }

  const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const wrapper = document.createElement("div");
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const body = document.createElement("tbody");
  const headerCells = splitRow(rows[0]);
  const headerRow = document.createElement("tr");
  headerCells.forEach((cell) => {
    const th = document.createElement("th");
    th.innerHTML = inlineMarkdown(cell);
    headerRow.append(th);
  });
  head.append(headerRow);

  rows.slice(2).forEach((row) => {
    const tr = document.createElement("tr");
    splitRow(row).forEach((cell) => {
      const td = document.createElement("td");
      td.innerHTML = inlineMarkdown(cell);
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(head, body);
  wrapper.append(table);
  addLineMetadata(wrapper, startIndex + 1, index);
  return { element: wrapper, nextIndex: index };
}

function renderMarkdown(markdown, target = elements.reader) {
  const fragment = document.createDocumentFragment();
  const lines = String(markdown).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let index = 0;

  if (lines[0]?.trim() === "---") {
    index = 1;
    while (index < lines.length && lines[index].trim() !== "---") index += 1;
    if (index < lines.length) index += 1;
  }

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const sourceLine = index + 1;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      fragment.append(createTextBlock(`h${heading[1].length}`, inlineMarkdown(heading[2]), sourceLine));
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*(```|~~~)\s*([^\s]*)\s*$/);
    if (fence) {
      const fenceMark = fence[1];
      const language = fence[2];
      const content = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fenceMark}`).test(lines[index])) {
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (language) code.dataset.language = language;
      code.textContent = content.join("\n");
      pre.append(code);
      fragment.append(addLineMetadata(pre, sourceLine, index));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      const start = sourceLine;
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      fragment.append(createTextBlock("blockquote", inlineMarkdown(quoteLines.join("\n")), start, index));
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const list = document.createElement(ordered ? "ol" : "ul");
      if (ordered) list.start = Number(line.match(/^\s*(\d+)/)[1]);
      const pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
      while (index < lines.length) {
        const itemMatch = lines[index].match(pattern);
        if (!itemMatch) break;
        const item = createTextBlock("li", inlineMarkdown(itemMatch[1]), index + 1);
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      fragment.append(addLineMetadata(document.createElement("hr"), sourceLine, sourceLine));
      index += 1;
      continue;
    }

    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || "")) {
      const table = parseTable(lines, index);
      fragment.append(table.element);
      index = table.nextIndex;
      continue;
    }

    const paragraphLines = [line];
    const start = sourceLine;
    index += 1;
    // Chinese prose commonly marks paragraphs with two full-width spaces
    // instead of blank lines. Keep those boundaries and original line numbers.
    while (index < lines.length && lines[index].trim() && !blockStarts(lines, index) && !/^\u3000{2}/.test(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    fragment.append(createTextBlock("p", inlineMarkdown(paragraphLines.join("\n")), start, index));
  }

  target.replaceChildren(fragment);
}

function buildDeepLink(documentId, line, endLine = line) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("doc", documentId);
  url.hash = line ? `L${line}${endLine > line ? `-L${endLine}` : ""}` : "";
  return url.toString();
}

function replaceLocation(documentId, line = null, push = false) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("doc", documentId);
  url.hash = line ? `L${line}` : "";
  window.history[push ? "pushState" : "replaceState"]({ scrollY: window.scrollY }, "", url);
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 2600);
}

function showLoading(show) {
  document.querySelector("#error-state").hidden = true;
  elements.loadingState.hidden = !show;
  if (show) {
    elements.reader.hidden = true;
    elements.emptyState.hidden = true;
  }
}

function setFontSize(size) {
  state.fontSize = Math.min(28, Math.max(13, size));
  document.documentElement.style.setProperty("--reader-font-size", `${state.fontSize}px`);
  elements.fontSize.value = String(state.fontSize);
  elements.fontSize.textContent = String(state.fontSize);
  rememberPreference("vibe-reader:font-size", String(state.fontSize));
}

function updateDocumentList() {
  const fragment = document.createDocumentFragment();
  const query = elements.libraryFilter.value.trim().toLocaleLowerCase();
  const documents = state.documents.filter((item) => `${item.doc_code || ""} ${item.title} ${item.relative_path}`.toLocaleLowerCase().includes(query) && (!document.querySelector("#translated-only").checked || item.translated_count > 0));
  document.querySelector("#library-count").textContent = `${documents.length} / ${state.documents.length} 份材料`;
  if (!documents.length) {
    const message = document.createElement("p");
    message.className = "panel-description";
    message.textContent = "没有匹配的材料。试试文件名中的其他词。";
    fragment.append(message);
  }
  documents.forEach((documentInfo) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "document-item";
    button.dataset.documentId = documentInfo.id;
    if (documentInfo.id === state.currentDocument?.id) button.classList.add("active");

    const main = document.createElement("span");
    const title = document.createElement("span");
    title.className = "document-item-title";
    title.textContent = `${documentInfo.doc_code ? `${documentInfo.doc_code} · ` : ""}${documentInfo.title}`;
    const meta = document.createElement("span");
    meta.className = "document-item-meta";
    meta.textContent = `${documentInfo.library || "材料"} / ${documentInfo.relative_path}`;
    main.append(title, meta);

    const lines = document.createElement("span");
    lines.className = "document-item-lines";
    lines.textContent = documentInfo.paragraph_count ? `${documentInfo.translated_count}/${documentInfo.paragraph_count} 段已译` : `${documentInfo.line_count} 行`;
    button.append(main, lines);
    fragment.append(button);
  });
  elements.documentList.replaceChildren(fragment);
}

async function refreshDocuments() {
  const payload = await requestJSON("/api/documents");
  state.documents = payload.documents || [];
  updateDocumentList();
  return state.documents;
}

function scrollStorageKey(documentId) {
  return `vibe-reader:scroll:${documentId}`;
}

function saveScrollPosition() {
  if (!state.currentDocument) return;
  rememberPreference(scrollStorageKey(state.currentDocument.id), String(window.scrollY));
}

function findBlockForLine(line) {
  const direct = document.getElementById(`L${line}`);
  if (direct) return direct.closest(".source-block");
  return [...elements.reader.querySelectorAll(".source-block")].find((block) => {
    return Number(block.dataset.lineStart) <= line && Number(block.dataset.lineEnd) >= line;
  });
}

function goToLine(line, behavior = "smooth", endLine = line) {
  const block = findBlockForLine(line);
  if (!block) {
    showToast(`没有找到第 ${line} 行`);
    return false;
  }
  elements.reader.querySelectorAll(".source-block.targeted").forEach((item) => item.classList.remove("targeted"));
  elements.reader.querySelectorAll(".source-block").forEach((item) => {
    if (Number(item.dataset.lineEnd) >= line && Number(item.dataset.lineStart) <= endLine) item.classList.add("targeted");
  });
  document.querySelector("#clear-highlight").hidden = false;
  block.scrollIntoView({ behavior, block: "center" });
  document.documentElement.dataset.targetLine = String(line);
  return true;
}

function installReaderManifest(documentInfo) {
  document.documentElement.dataset.vibeReader = "true";
  document.documentElement.dataset.documentId = documentInfo.id;
  document.documentElement.dataset.documentName = documentInfo.name;
  window.VibeReader = Object.freeze({
    document: {
      id: documentInfo.id,
      name: documentInfo.name,
      title: documentInfo.title,
      lineCount: documentInfo.line_count,
      code: documentInfo.doc_code,
      paragraphCount: documentInfo.paragraph_count,
    },
    linkToLine: (line, endLine = line) => buildDeepLink(documentInfo.id, Number(line), Number(endLine)),
    goToLine: (line) => goToLine(Number(line)),
    linkToParagraph: (paragraph) => buildParagraphLink(documentInfo.id, Number(paragraph)),
    goToParagraph: (paragraph) => goToParagraph(Number(paragraph)),
  });
}

function rememberLocation() {
  if (!state.currentDocument || elements.reader.hidden) return;
  saveScrollPosition();
  const location = { id: state.currentDocument.id, scrollY: window.scrollY, hash: window.location.hash };
  state.navigationStack.push(location);
  if (state.navigationStack.length > 60) state.navigationStack.shift();
  window.history.replaceState({ scrollY: window.scrollY }, "");
  elements.returnButton.disabled = false;
}

async function loadDocument(documentId, options = {}) {
  const { line = null, endLine = line, paragraph = null, updateURL = true, pushHistory = false, restoreScroll = true, scrollY = null } = options;
  if (!documentId) return;
  const version = ++state.loadVersion;
  if (pushHistory) rememberLocation();
  else saveScrollPosition();
  showLoading(true);
  try {
    const documentInfo = await requestJSON(`/api/documents/${encodeURIComponent(documentId)}`);
    if (version !== state.loadVersion) return;
    state.currentDocument = documentInfo;
    if (documentInfo.parallel) renderParallel(documentInfo);
    else renderMarkdown(documentInfo.content);
    document.querySelector("#parallel-view").hidden = !documentInfo.parallel;
    clearHighlight();
    elements.documentTitle.textContent = documentInfo.name;
    elements.documentMenuButton.disabled = false;
    document.title = `${documentInfo.title} · Vibe Reader`;
    rememberPreference("vibe-reader:last-document", documentInfo.id);
    installReaderManifest(documentInfo);
    updateDocumentList();
    updateOutline();
    if (updateURL) {
      replaceLocation(documentInfo.id, line, pushHistory);
      if (paragraph) window.history.replaceState(window.history.state, "", buildParagraphLink(documentId, paragraph));
      else if (endLine > line) window.history.replaceState(window.history.state, "", buildDeepLink(documentId, line, endLine));
    }
    elements.emptyState.hidden = true;
    elements.reader.hidden = false;
    elements.loadingState.hidden = true;
    requestAnimationFrame(() => {
      if (version !== state.loadVersion) return;
      if (paragraph) goToParagraph(paragraph, "auto", scrollY === null);
      if (scrollY !== null) window.scrollTo({ top: scrollY, behavior: "auto" });
      else if (paragraph) { /* Position already restored by paragraph anchor. */ }
      else if (line) goToLine(line, "auto", endLine || line);
      else window.scrollTo({ top: restoreScroll ? Number(localStorage.getItem(scrollStorageKey(documentInfo.id))) || 0 : 0, behavior: "auto" });
      updateReadingPosition();
    });
  } catch (error) {
    if (version !== state.loadVersion) return;
    elements.loadingState.hidden = true;
    elements.reader.hidden = !state.currentDocument;
    elements.emptyState.hidden = true;
    document.querySelector("#error-state").hidden = !!state.currentDocument;
    document.querySelector("#error-message").textContent = error.message;
    if (!state.currentDocument) elements.documentTitle.textContent = "无法打开文档";
    showToast(`无法打开指定材料：${error.message}`);
  }
}

function openPanel(panelName) {
  const opener = document.activeElement;
  closePanels(false);
  state.panelOpener = opener;
  const panel = panelName === "search" ? elements.searchPanel : panelName === "navigation" ? elements.navigationPanel : elements.libraryPanel;
  panel.inert = false;
  state.activePanel = panelName;
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  elements.scrim.hidden = false;
  (panelName === "search" ? elements.searchInput : panelName === "library" ? elements.libraryFilter : panel.querySelector("button")).focus();
}

function closePanels(restoreFocus = true) {
  [elements.libraryPanel, elements.searchPanel, elements.navigationPanel].forEach((panel) => {
    panel.inert = true;
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  });
  state.activePanel = null;
  elements.scrim.hidden = true;
  if (restoreFocus && state.panelOpener?.isConnected) state.panelOpener.focus();
}

async function runSearch() {
  const version = ++state.searchVersion;
  const query = elements.searchInput.value.trim();
  elements.searchResults.replaceChildren();
  if (!query) {
    elements.searchStatus.textContent = "输入关键词，结果会带你直达原文行。";
    return;
  }

  elements.searchStatus.textContent = "正在搜索…";
  const parameters = new URLSearchParams({ q: query });
  if (elements.searchCurrentDocument.checked && state.currentDocument) {
    parameters.set("document_id", state.currentDocument.id);
  }

  try {
    const payload = await requestJSON(`/api/search?${parameters}`);
    if (version !== state.searchVersion) return;
    const results = payload.results || [];
    elements.searchStatus.textContent = results.length ? `找到 ${results.length} 个相关段落` : "没有找到匹配段落。";
    const fragment = document.createDocumentFragment();
    results.forEach((result) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result";
      button.dataset.documentId = result.document_id;
      button.dataset.line = String(result.line);
      if (result.paragraph) button.dataset.paragraph = String(result.paragraph);

      const source = document.createElement("span");
      source.className = "search-result-source";
      const title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = result.document_title;
      const line = document.createElement("span");
      line.className = "search-result-line";
      line.textContent = result.paragraph ? `${result.doc_code}§${paragraphLabel(result.paragraph)}` : `第 ${result.line} 行`;
      source.append(title, line);

      const snippet = document.createElement("span");
      snippet.className = "search-result-snippet";
      const terms = query.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
      const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
      snippet.innerHTML = result.snippet.split(pattern).map((part, index) => index % 2 ? `<mark>${escapeHTML(part)}</mark>` : escapeHTML(part)).join("");
      button.append(source, snippet);
      fragment.append(button);
    });
    elements.searchResults.replaceChildren(fragment);
  } catch (error) {
    if (version === state.searchVersion) elements.searchStatus.textContent = error.message;
  }
}

function scheduleSearch() {
  state.searchVersion += 1;
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(runSearch, 220);
}

function isSupportedFile(file) {
  const lowerName = file.name.toLowerCase();
  return supportedExtensions.some((extension) => lowerName.endsWith(extension));
}

async function importFiles(files) {
  const accepted = [...files].filter(isSupportedFile);
  if (!accepted.length) {
    showToast("请选择 Markdown 或纯文本文件");
    return;
  }

  let lastImported = null;
  for (const file of accepted) {
    try {
      const content = await file.text();
      lastImported = await requestJSON("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, content }),
      });
    } catch (error) {
      showToast(`${file.name}：${error.message}`);
      return;
    }
  }

  await refreshDocuments();
  if (lastImported) await loadDocument(lastImported.id, { restoreScroll: false });
  closePanels();
  showToast(`已导入 ${accepted.length} 份材料`);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch {
    window.prompt("请复制以下内容", text);
  }
}

async function copyLineLink(line, endLine = line) {
  if (!state.currentDocument) return;
  const row = state.currentDocument.parallel?.rows.find(row => row.kind === 'pair' && row.line <= line && row.end_line >= line);
  await copyText(row ? buildParagraphLink(state.currentDocument.id, row.start) : buildDeepLink(state.currentDocument.id, line, endLine), "已复制原文链接");
}

function updateSelectionLinkButton() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    elements.selectionToolbar.hidden = true;
    return;
  }
  const range = selection.getRangeAt(0);
  const owner = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(".source-block");
  const first = owner(range.startContainer);
  const last = owner(range.endContainer);
  if (!first || !last || !elements.reader.contains(first) || !elements.reader.contains(last)) {
    elements.selectionToolbar.hidden = true;
    return;
  }
  const fragment = range.cloneContents();
  fragment.querySelectorAll(".line-link, .line-anchor-alias, .paragraph-link, .paragraph-anchor, .language-label").forEach((node) => node.remove());
  fragment.querySelectorAll("p,li,blockquote,pre,h1,h2,h3,h4,h5,h6,tr").forEach((node) => node.append(document.createTextNode("\n\n")));
  state.selectionText = fragment.textContent.trim();
  state.selectionLine = Number(first.dataset.lineStart);
  state.selectionEndLine = Number(last.dataset.lineEnd);
  const rect = range.getBoundingClientRect();
  elements.selectionToolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - 210, rect.right - 200))}px`;
  elements.selectionToolbar.style.top = `${Math.max(50, rect.top - 38)}px`;
  elements.selectionToolbar.hidden = false;
}

function citation(text, line, endLine = line) {
  if (state.currentDocument.parallel) {
    const paired = parallelCitation(text, line, endLine);
    if (paired) return paired;
  }
  const title = state.currentDocument.title.replace(/[\[\]\\]/g, "\\$&");
  return `${text.split("\n").map((part) => `> ${part}`).join("\n")}\n\n— [${title} · L${line}${endLine > line ? `–L${endLine}` : ""}](${buildDeepLink(state.currentDocument.id, line, endLine)})`;
}

function currentBlock() {
  const blocks = [...elements.reader.querySelectorAll(state.currentDocument?.parallel ? ".parallel-pair" : ".source-block")];
  return blocks.find((block) => block.getBoundingClientRect().bottom > 75) || blocks.at(-1);
}

function updateReadingPosition() {
  if (!state.currentDocument || elements.reader.hidden) return;
  const block = currentBlock();
  if (state.currentDocument.parallel) {
    const parallel = state.currentDocument.parallel;
    elements.readingPosition.textContent = `${parallel.code} §${paragraphLabel(block?.dataset.paragraphStart || 1)} · 共 ${parallel.paragraph_count} 段`;
    return;
  }
  const line = Number(block?.dataset.lineStart || 1);
  elements.readingPosition.textContent = `L${line} / ${state.currentDocument.line_count} · ${Math.min(100, Math.round(line / Math.max(1, state.currentDocument.line_count) * 100))}%`;
}

function clearHighlight() {
  elements.reader.querySelectorAll(".targeted").forEach((block) => block.classList.remove("targeted"));
  delete document.documentElement.dataset.targetLine;
  delete document.documentElement.dataset.targetParagraph;
  document.querySelector("#clear-highlight").hidden = true;
}

function updateOutline() {
  elements.outline.replaceChildren();
  elements.reader.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading) => {
    const link = document.createElement("a");
    const clean = heading.cloneNode(true);
    clean.querySelectorAll(".line-link,.line-anchor-alias").forEach((node) => node.remove());
    link.textContent = clean.textContent;
    const block = heading.closest('.source-block');
    if (!block) return;
    link.href = block.dataset.paragraphStart ? buildParagraphLink(state.currentDocument.id, Number(block.dataset.paragraphStart)) : buildDeepLink(state.currentDocument.id, Number(block.dataset.lineStart));
    link.className = `outline-link level-${heading.tagName.slice(1)}`;
    elements.outline.append(link);
  });
  if (!elements.outline.children.length) elements.outline.textContent = "这份材料没有标题，可通过行号或搜索定位。";
  document.querySelector("#source-details").textContent = `${state.currentDocument.relative_path} · ${state.currentDocument.line_count} 行`;
  document.querySelector("#line-input").max = state.currentDocument.line_count;
}

function targetFromURL(url) {
  const match = url.hash.match(/^#L(\d+)(?:-L?(\d+))?$/i);
  const line = Number(match?.[1] || url.searchParams.get("line")) || null;
  const paragraph = Number(url.hash.match(/^#p(\d+)$/i)?.[1]) || null;
  return { paragraph, line, endLine: Math.max(line || 0, Number(match?.[2] || url.searchParams.get("end")) || line) };
}

async function openReaderURL(url, pushHistory = false, scrollY = null) {
  let id = url.searchParams.get("doc");
  const filename = url.searchParams.get("file");
  const reference = url.searchParams.get("ref");
  let referenceParagraph = null;
  if (reference) {
    const parsed = parseParagraphReference(reference);
    if (!parsed?.code) throw new Error("引用格式应为 文档码§段号，例如 VC-01§042。");
    const result = await requestJSON(`/api/resolve?code=${encodeURIComponent(parsed.code)}`);
    if (result.documents.length !== 1) throw new Error(result.documents.length ? "文档码不唯一，请使用文档 ID 链接。" : "未找到此文档码，请检查对照材料库是否已挂载。");
    id = result.documents[0].id;
    referenceParagraph = parsed.paragraph;
  }
  if (!id && filename) {
    const result = await requestJSON(`/api/resolve?file=${encodeURIComponent(filename)}`);
    if (result.documents.length !== 1) {
      elements.libraryFilter.value = filename.split("/").at(-1);
      updateDocumentList();
      openPanel("library");
      throw new Error(result.documents.length ? "存在同名文件，请在文档库中选择完整路径对应的材料。" : "未找到链接中的文件，请检查文件名或先导入材料。");
    }
    id = result.documents[0].id;
  }
  if (!id) throw new Error("链接缺少材料标识。");
  await loadDocument(id, { ...targetFromURL(url), ...(referenceParagraph ? {paragraph: referenceParagraph} : {}), pushHistory, updateURL: pushHistory || !!filename || !!reference, scrollY });
}

function installEventHandlers() {
  elements.libraryButton.addEventListener("click", () => openPanel("library"));
  elements.documentMenuButton.addEventListener("click", () => openPanel("library"));
  elements.searchButton.addEventListener("click", () => openPanel("search"));
  elements.scrim.addEventListener("click", closePanels);
  document.querySelectorAll("[data-close-panel]").forEach((button) => button.addEventListener("click", closePanels));

  elements.documentList.addEventListener("click", async (event) => {
    const button = event.target.closest(".document-item");
    if (!button) return;
    closePanels();
    await loadDocument(button.dataset.documentId, { restoreScroll: true, pushHistory: true });
  });

  elements.searchResults.addEventListener("click", async (event) => {
    const button = event.target.closest(".search-result");
    if (!button) return;
    const line = Number(button.dataset.line);
    closePanels();
    await loadDocument(button.dataset.documentId, {
      line,
      paragraph: Number(button.dataset.paragraph) || null,
      restoreScroll: false,
      pushHistory: true,
    });
  });

  elements.reader.addEventListener("click", (event) => {
    const lineLink = event.target.closest(".line-link");
    if (!lineLink) return;
    event.preventDefault();
    copyLineLink(Number(lineLink.dataset.line));
  });

  elements.searchInput.addEventListener("input", scheduleSearch);
  elements.searchCurrentDocument.addEventListener("change", scheduleSearch);
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch();
  });

  elements.fontSmaller.addEventListener("click", () => setFontSize(state.fontSize - 1));
  elements.fontLarger.addEventListener("click", () => setFontSize(state.fontSize + 1));
  [elements.importButton, elements.emptyImportButton].forEach((button) => {
    button.addEventListener("click", () => elements.fileInput.click());
  });
  elements.fileInput.addEventListener("change", async () => {
    await importFiles(elements.fileInput.files);
    elements.fileInput.value = "";
  });

  window.addEventListener("scroll", () => {
    window.clearTimeout(state.scrollTimer);
    state.scrollTimer = window.setTimeout(() => { saveScrollPosition(); updateReadingPosition(); }, 180);
    elements.selectionToolbar.hidden = true;
  }, { passive: true });

  document.addEventListener("selectionchange", () => {
    window.setTimeout(updateSelectionLinkButton, 0);
  });
  elements.copyLinkButton.addEventListener("click", () => {
    if (state.selectionLine) copyLineLink(state.selectionLine, state.selectionEndLine);
    elements.selectionToolbar.hidden = true;
  });

  document.addEventListener("keydown", (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPanel("search");
      return;
    }
    if (event.key === "Escape") {
      closePanels();
      elements.selectionToolbar.hidden = true;
      return;
    }
    const target = event.target;
    const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable || modifier || event.altKey;
    if (!isTyping && (event.key === "+" || event.key === "=")) setFontSize(state.fontSize + 1);
    if (!isTyping && event.key === "-") setFontSize(state.fontSize - 1);
  });

  window.addEventListener("popstate", async (event) => {
    try { await openReaderURL(new URL(window.location.href), false, event.state?.scrollY ?? null); }
    catch (error) { showToast(error.message); }
  });

  document.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    state.dragDepth += 1;
    elements.dropZone.hidden = false;
  });
  document.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) elements.dropZone.hidden = true;
  });
  document.addEventListener("drop", async (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    state.dragDepth = 0;
    elements.dropZone.hidden = true;
    await importFiles(event.dataTransfer.files);
  });
}

function installNavigationHandlers() {
  document.querySelector("#navigation-button").addEventListener("click", () => openPanel("navigation"));
  elements.libraryFilter.addEventListener("input", updateDocumentList);
  document.querySelector("#error-library-button").addEventListener("click", () => openPanel("library"));
  document.querySelector("#line-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.currentDocument) return;
    const line = Number(document.querySelector("#line-input").value);
    closePanels();
    await loadDocument(state.currentDocument.id, { line, pushHistory: true });
  });
  elements.returnButton.addEventListener("click", async () => {
    const previous = state.navigationStack.pop();
    if (!previous) return;
    await loadDocument(previous.id, { scrollY: previous.scrollY });
    const url = new URL(window.location.href);
    url.hash = previous.hash;
    window.history.replaceState({ scrollY: previous.scrollY }, "", url);
    const target = targetFromURL(url);
    if (target.paragraph) goToParagraph(target.paragraph, "auto", false);
    else if (target.line) {
      elements.reader.querySelectorAll(".source-block").forEach((block) => {
        if (Number(block.dataset.lineEnd) >= target.line && Number(block.dataset.lineStart) <= target.endLine) block.classList.add("targeted");
      });
      document.querySelector("#clear-highlight").hidden = false;
    }
    elements.returnButton.disabled = !state.navigationStack.length;
  });
  document.querySelector("#clear-highlight").addEventListener("click", () => {
    clearHighlight();
    replaceLocation(state.currentDocument.id);
  });
  document.querySelector("#copy-quote-button").addEventListener("click", () => {
    if (state.selectionText) copyText(citation(state.selectionText, state.selectionLine, state.selectionEndLine), "已复制原文引用与出处");
    elements.selectionToolbar.hidden = true;
  });
  elements.selectionToolbar.addEventListener("mousedown", (event) => event.preventDefault());
  document.querySelector("#copy-context").addEventListener("click", () => {
    if (!state.currentDocument) return showToast("请先打开一份材料");
    if (copyParallelContext()) return;
    const blocks = [...elements.reader.querySelectorAll(".source-block")];
    const selected = blocks.find((block) => block.classList.contains("targeted")) || currentBlock();
    if (!selected) return showToast("这份材料没有可引用的正文");
    const index = blocks.indexOf(selected);
    const start = Number(blocks[Math.max(0, index - 1)].dataset.lineStart);
    const end = Number(blocks[Math.min(blocks.length - 1, index + 1)].dataset.lineEnd);
    const lines = state.currentDocument.content.split(/\r\n|\r|\n/);
    const excerpt = lines.slice(start - 1, end).map((line, offset) => `L${start + offset}: ${line}`).join("\n");
    const text = `${citation(excerpt, start, end)}\n\n请围绕以上原文回答我的问题，区分原文陈述与推断；如引用其他材料，请核对原文并附可点击的 Vibe Reader 行号链接，不要编造出处。\n\n我的问题：`;
    copyText(text, "已复制当前段落、前后文与行号链接");
  });
  document.querySelector("#copy-catalog").addEventListener("click", () => {
    const intro = "以下是本地 Vibe Reader 材料索引（不包含全文）。请在实际读取材料后引用，不能仅凭标题推断内容。若你无法读取本地材料，请明确说明并让我提供原文。\n引用格式：在材料链接末尾添加实际源文件行号，例如 #L204 或 #L204-L210。普通材料的行号是 Markdown 源文件行号。对照材料请使用固定段号：在链接末尾加 #p042；也可使用 ?ref=VC-01%C2%A7042。\n";
    const catalog = state.documents.map((item) => `- ${item.doc_code ? `${item.doc_code} · ` : ""}${item.title}${item.paragraph_count ? `（共 ${item.paragraph_count} 段，已译 ${item.translated_count} 段）` : ""}\n  文件：${item.relative_path}（${item.line_count} 行）\n  ${buildDeepLink(item.id, null)}`).join("\n");
    copyText(`${intro}\n${catalog}`, `已复制 ${state.documents.length} 份材料的索引`);
  });
  document.addEventListener("click", async (event) => {
    const link = event.target.closest("a[href]");
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || !(url.searchParams.has("doc") || url.searchParams.has("file") || url.searchParams.has("ref") || /^#(?:L|p)\d+/i.test(url.hash))) return;
    event.preventDefault();
    if (!url.searchParams.has("doc") && !url.searchParams.has("file") && !url.searchParams.has("ref") && state.currentDocument) url.searchParams.set("doc", state.currentDocument.id);
    closePanels();
    try { await openReaderURL(url, true); } catch (error) { showToast(error.message); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !state.activePanel) return;
    const panel = document.querySelector(".panel.open");
    const items = [...panel.querySelectorAll("button, input, a[href]")].filter((item) => !item.disabled && item.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  window.addEventListener("pagehide", saveScrollPosition);
}

async function initialize() {
  await restoreDesktopPreferences();
  setFontSize(state.fontSize);
  installEventHandlers();
  installNavigationHandlers();
  installParallelHandlers();
  closePanels(false);
  window.history.scrollRestoration = "manual";
  try {
    await refreshDocuments();
    if (!state.documents.length) {
      elements.loadingState.hidden = true;
      elements.emptyState.hidden = false;
      elements.reader.hidden = true;
      elements.documentTitle.textContent = "没有材料";
      return;
    }

    const url = new URL(window.location.href);
    if (url.searchParams.has("doc") || url.searchParams.has("file") || url.searchParams.has("ref")) {
      await openReaderURL(url);
    } else {
      const storedId = localStorage.getItem("vibe-reader:last-document");
      const initialDocument = state.documents.find((item) => item.id === storedId) || state.documents[0];
      await loadDocument(initialDocument.id, targetFromURL(url));
    }
  } catch (error) {
    elements.loadingState.hidden = true;
    elements.reader.hidden = true;
    elements.emptyState.hidden = true;
    document.querySelector("#error-state").hidden = false;
    document.querySelector("#error-message").textContent = error.message;
    elements.documentTitle.textContent = "无法打开材料";
    showToast(error.message);
  }
}

initialize();
