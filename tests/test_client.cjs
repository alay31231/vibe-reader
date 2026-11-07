// Run with: node --test vibe-reader/tests/test_client.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8').replace(/initialize\(\);\s*$/, '');

function setup(href = 'http://127.0.0.1:35924/?doc=old#L204') {
  const nodes = new Map();
  const storage = new Map();
  const history = [];
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { hidden: false, textContent: '', style: {}, dataset: {} });
      return nodes.get(selector);
    },
    documentElement: { dataset: {} },
  };
  const context = vm.createContext({
    document, URL, URLSearchParams, console,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    window: {
      location: new URL(href), scrollY: 175,
      history: { replaceState: (...args) => history.push(args), pushState: (...args) => history.push(args) },
      scrollTo: () => {},
    },
    requestAnimationFrame: callback => callback(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/parallel.js'), 'utf8'), context);
  vm.runInContext(source, context);
  vm.runInContext(`
    const jumps = [];
    const originalRenderMarkdown = renderMarkdown;
    renderMarkdown = () => {};
    renderParallel = () => {};
    const paragraphJumps = [];
    goToParagraph = (...args) => paragraphJumps.push(args);
    installReaderManifest = () => {};
    updateDocumentList = () => {};
    updateOutline = () => {};
    clearHighlight = () => {};
    updateReadingPosition = () => {};
    showToast = () => {};
    goToLine = (...args) => jumps.push(args);
  `, context);
  return { run: code => vm.runInContext(code, context), history };
}

function renderBlocks(markdown) {
  const { run } = setup();
  run(`
    document.createDocumentFragment = () => ({children: [], append(child) { this.children.push(child); }});
    createTextBlock = (tag, html, start, end = start) => ({tag, html, start, end});
    const rendered = {replaceChildren(fragment) { this.blocks = fragment.children; }};
  `);
  run(`originalRenderMarkdown(${JSON.stringify(markdown)}, rendered)`);
  return JSON.parse(run('JSON.stringify(rendered.blocks)'));
}

test('Chinese novel paragraphs without blank lines keep separate source ranges', () => {
  const blocks = renderBlocks('---\ntitle: 小说\n---\n# 第八章\n\n　　第一段。\n　　“运动防御战，我先示范到这里。”\n　　女儿点了点头。\n');
  assert.deepEqual(blocks.map(({tag, start, end}) => ({tag, start, end})), [
    {tag:'h1', start:4, end:4},
    {tag:'p', start:6, end:6},
    {tag:'p', start:7, end:7},
    {tag:'p', start:8, end:8},
  ]);
  assert.match(blocks[2].html, /运动防御战/);
  assert.doesNotMatch(blocks[2].html, /第一段|女儿/);
});

test('soft-wrapped Markdown and unindented continuations remain one paragraph', () => {
  const blocks = renderBlocks('A soft-wrapped\nMarkdown paragraph.\n\n　　中文段落的开头\n没有缩进的续行。\n　　下一段。');
  assert.deepEqual(blocks.map(({start, end}) => ({start, end})), [
    {start:1, end:2}, {start:4, end:5}, {start:6, end:6},
  ]);
});

test('document switching must not inherit the previous document hash', async () => {
  const { run, history } = setup();
  run(`requestJSON = async () => ({ id: 'new', title: 'New', name: 'new.md', content: 'Text', line_count: 1 });`);
  await run(`loadDocument('new')`);
  assert.equal(run('jumps.length'), 0);
  assert.equal(history.at(-1)[2].hash, '');
  assert.equal(history.at(-1)[2].searchParams.get('doc'), 'new');
});

test('a slower old document response cannot replace the newer selection', async () => {
  const { run } = setup();
  run(`const pending = {}; requestJSON = url => new Promise(resolve => pending[url] = resolve);`);
  const first = run(`loadDocument('first')`);
  const second = run(`loadDocument('second')`);
  run(`pending['/api/documents/second']({id:'second', content:'new'});`);
  await second;
  run(`pending['/api/documents/first']({id:'first', content:'old'});`);
  await first;
  assert.equal(run('state.currentDocument.id'), 'second');
});

test('range links retain both endpoints; catalog links have no artificial L1 target', () => {
  const { run } = setup();
  assert.equal(run(`buildDeepLink('book', 204, 210)`), 'http://127.0.0.1:35924/?doc=book#L204-L210');
  assert.equal(run(`buildDeepLink('book', null)`), 'http://127.0.0.1:35924/?doc=book');
  assert.equal(run(`targetFromURL(new URL('http://localhost/?file=a.md&line=12&end=20')).endLine`), 20);
  assert.equal(run(`targetFromURL(new URL('http://localhost/#L12-L20')).line`), 12);
});

test('explicit range navigation highlights the requested source range', async () => {
  const { run } = setup();
  run(`requestJSON = async () => ({id:'book', content:'text'});`);
  await run(`loadDocument('book', {line:12,endLine:20})`);
  assert.equal(run('jumps[0][0]'), 12);
  assert.equal(run('jumps[0][2]'), 20);
});

test('missing documents show an error instead of silently substituting a book', async () => {
  const { run } = setup();
  run(`requestJSON = async () => { throw new Error('Document not found.'); };`);
  await run(`loadDocument('missing')`);
  assert.equal(run('state.currentDocument'), null);
  assert.equal(run(`document.querySelector('#error-state').hidden`), false);
  assert.equal(run(`document.querySelector('#error-message').textContent`), 'Document not found.');
});

test('document HTML and script URLs remain inert', () => {
  const { run } = setup();
  assert.equal(run(`inlineMarkdown('<script>alert(1)</script>')`), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(run(`safeURL('javascript:alert(1)')`), '#');
});


test('paragraph reference parsing supports document codes and padded paragraph IDs', () => {
  const { run } = setup();
  assert.equal(run(`parseParagraphReference('VC-01§042').code`), 'VC-01');
  assert.equal(run(`parseParagraphReference('VC-01 § 042').paragraph`), 42);
  assert.equal(run(`parseParagraphReference('p042').paragraph`), 42);
  assert.equal(run(`parseParagraphReference('0')`), null);
  assert.equal(run(`parseParagraphReference('not-a-reference')`), null);
  assert.equal(run(`targetFromURL(new URL('http://localhost/?doc=book#p042')).paragraph`), 42);
});

test('paragraph navigation uses a paragraph link and keeps its target after refresh', async () => {
  const { run, history } = setup('http://127.0.0.1:35924/?doc=book#p042');
  run(`requestJSON = async () => ({id:'book', content:'text', parallel:{}});`);
  await run(`openReaderURL(new URL(window.location.href))`);
  assert.equal(run('paragraphJumps[0][0]'), 42);
  assert.equal(run('jumps.length'), 0);
  await run(`loadDocument('book', {paragraph:5})`);
  assert.equal(history.at(-1)[2], 'http://127.0.0.1:35924/?doc=book#p005');
});

test('cross-document reference resolves the code before opening the requested paragraph', async () => {
  const { run, history } = setup();
  run(`requestJSON = async url => url.startsWith('/api/resolve?code=') ? {documents:[{id:'translated'}]} : {id:'translated', content:'text',parallel:{}};`);
  await run(`openReaderURL(new URL('http://127.0.0.1:35924/?ref=D-14%C2%A7003'))`);
  assert.equal(run('state.currentDocument.id'), 'translated');
  assert.equal(run('paragraphJumps[0][0]'), 3);
  assert.equal(history.at(-1)[2], 'http://127.0.0.1:35924/?doc=translated#p003');
});

test('unknown and ambiguous document codes never silently select another document', async () => {
  const { run } = setup();
  run(`requestJSON = async () => ({documents:[]});`);
  await assert.rejects(run(`openReaderURL(new URL('http://localhost/?ref=MISSING%C2%A7001'))`), /未找到/);
  run(`requestJSON = async () => ({documents:[{id:'a'},{id:'b'}]});`);
  await assert.rejects(run(`openReaderURL(new URL('http://localhost/?ref=DUPLICATE%C2%A7001'))`), /不唯一/);
  assert.equal(run('state.currentDocument'), null);
});
