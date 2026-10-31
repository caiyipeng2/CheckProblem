import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  createCliResourceReaders,
  createPlanningDocumentReader,
} from '../src/planning-document.js';

const HOST = 'example.feishu.cn';
const DOC_URL = `https://${HOST}/docx/docxToken123`;
const WIKI_URL = `https://${HOST}/wiki/wikiNode456`;
const testDocLink = {
  kind: 'docx',
  token: 'docxToken123',
  url: DOC_URL,
  requestId: 'req_test_1',
};
const testWikiLink = {
  kind: 'wiki',
  token: 'wikiNode456',
  url: WIKI_URL,
  requestId: 'req_wiki_1',
};

// Media tokens are deliberately unique strings so a serialized Snapshot can be
// searched for them verbatim.
const MEDIA = {
  image1: 'mediaTokenImageOne',
  image2: 'mediaTokenImageTwo',
  whiteboard: 'mediaTokenWhiteboard',
  sheet: 'mediaTokenSheet',
  video: 'mediaTokenVideo',
  xlsx: 'mediaTokenXlsx',
};
const SIGNED_URL = 'https://example.feishu.cn/open-apis/media/download?sign=fakeSignatureValue';

const CONTENT = [
  '<title id="doc-title">勋章挑战系统</title>',
  '<h1 id="chapter-1">第一章 入口</h1>',
  '<p id="p-1">活动期间，大厅显示勋章挑战入口。</p>',
  '<ol><li id="li-1">列表项</li></ol>',
  `<img id="img-1" src="${MEDIA.image1}" alt="大厅入口截图"/>`,
  '<table id="table-1"><tbody>',
  '<tr><td id="cell-1-1">第一张表 A1</td><td id="cell-1-2">第一张表 B1</td>'
    + '<td id="cell-1-3"></td></tr>',
  '</tbody></table>',
  '<h2 id="chapter-2">第二章 表格</h2>',
  '<p id="p-2">表格之后。</p>',
  '<table id="table-2"><tbody><tr><td id="cell-2-1">table-page-2</td></tr></tbody></table>',
  `<img id="img-2" src="${MEDIA.image2}" alt="第二张图"/>`,
  `<whiteboard id="wb-1" token="${MEDIA.whiteboard}"/>`,
  `<sheet id="sheet-1" sheet-id="sheetId01" token="${MEDIA.sheet}"/>`,
  `<source id="video-1" name="演示视频.mp4" mime="video/mp4" size="1024" token="${MEDIA.video}"/>`,
  `<source name="数值表.xlsx" mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" size="2048" token="${MEDIA.xlsx}"/>`,
  `<p id="p-3">详见 <a href="${DOC_URL}">本文档</a> 与 <a href="https://${HOST}/docx/refDoc789">引用文档</a>。</p>`,
].join('');

const REFERENCE_MAP = {
  [DOC_URL]: { url: DOC_URL, title: '本文档' },
  [SIGNED_URL]: { url: SIGNED_URL, title: '签名引用' },
};

const COMMENT_PAGES = {
  first: [
    {
      comment_id: 'comment-1',
      quote: '第一页评论',
      is_solved: false,
      reply_list: [{ content: '回复一' }, { content: '' }],
    },
  ],
  second: [
    {
      comment_id: 'comment-2',
      quote: '第二页评论',
      is_solved: false,
      reply_list: [],
    },
  ],
};

const IMAGE_BYTES = (token) => Buffer.from(`image-bytes:${token}`, 'utf8');
const DEFAULT_ORIGINAL_BYTES = Buffer.from('xlsx-original-bytes-v1', 'utf8');
const WHITEBOARD_PREVIEW_BYTES = Buffer.from('whiteboard-preview-bytes', 'utf8');
const WHITEBOARD_NODES = [
  { id: 'node-1', text: '画板文字', token: MEDIA.whiteboard, url: SIGNED_URL },
  { id: 'node-2', text: '画板文字' },
  { id: 'node-3', text: '第二段' },
];
const WHITEBOARD_RAW_BYTES = () => Buffer.from(JSON.stringify({ nodes: WHITEBOARD_NODES }), 'utf8');
const WORKBOOK_HTML = (cell) => [
  '<html><body><table>',
  '<tr><td>A1</td><td>B1</td></tr>',
  `<tr><td>A2</td><td>${cell}</td></tr>`,
  '</table><script>secretScript()</script></body></html>',
].join('');

function ok(data) {
  return { code: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data }), stderr: '' };
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function sha256(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

// Builds the reader options from a fake `run` that speaks the Task 1 envelope
// shapes and writes real files for the production resource readers.
function platformFixture(overrides = {}) {
  const calls = [];
  const control = { ...overrides };
  const assetsDir = control.assetsDir ?? mkdtempSync(join(tmpdir(), 'planning-doc-'));
  const limits = {
    maxChars: 500_000,
    maxResources: 100,
    maxTotalBytes: 200 * 1024 * 1024,
    maxResourceBytes: 20 * 1024 * 1024,
    maxPages: 20,
    ...control.limits,
  };
  const state = {
    content: control.content ?? CONTENT,
    referenceMap: control.referenceMap ?? REFERENCE_MAP,
    commentPages: control.commentPages ?? COMMENT_PAGES,
    documentId: control.documentId ?? 'syntheticDocumentToken',
    revision: control.revision ?? '1583',
    workbookCell: control.workbookCell ?? 'B2原始值',
    originalBytes: control.originalBytes ?? DEFAULT_ORIGINAL_BYTES,
    sheetCsv: control.sheetCsv ?? 'A1,B1\nA2,B2',
  };

  const writeOutput = (output, bytes) => {
    if (control.writePreview === false) return;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes);
  };

  const run = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    if (cmd !== 'lark-cli') return { code: 1, stdout: '', stderr: 'unexpected command' };
    const [group, sub] = args;
    if (control.fetchResult !== undefined) return control.fetchResult;

    if (group === 'docs' && sub === '+fetch') {
      return ok({
        document: {
          content: state.content,
          document_id: state.documentId,
          revision_id: state.revision,
          reference_map: state.referenceMap,
        },
      });
    }

    if (group === 'drive' && sub === '+list-comments') {
      if (control.commentsResult !== undefined) return control.commentsResult;
      const pageToken = argValue(args, '--page-token');
      const pages = state.commentPages;
      if (!pageToken) {
        const hasSecond = Array.isArray(pages.second);
        return ok({
          items: pages.first,
          has_more: hasSecond,
          page_token: control.commentsNoToken ? null : (hasSecond ? 'comment-page-2' : ''),
          count: 2,
        });
      }
      return ok({ items: pages.second, has_more: false, page_token: '', count: 2 });
    }

    if (group === 'docs' && sub === '+media-preview') {
      const token = argValue(args, '--token');
      const output = argValue(args, '--output');
      if (control.failMediaToken === token) {
        return { code: 1, stdout: '', stderr: 'remote CLI failure with detail' };
      }
      const bytes = token === MEDIA.xlsx ? state.originalBytes : IMAGE_BYTES(token);
      writeOutput(output, bytes);
      return ok({
        saved_path: control.mediaSavedPath ?? output,
        size_bytes: bytes.length,
        content_type: token === MEDIA.xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'image/png',
      });
    }

    if (group === 'whiteboard' && sub === '+export') {
      if (control.whiteboardResult !== undefined) return control.whiteboardResult;
      const output = argValue(args, '--output');
      const type = argValue(args, '--output-type');
      const bytes = type === 'preview' ? WHITEBOARD_PREVIEW_BYTES : WHITEBOARD_RAW_BYTES();
      writeOutput(output, bytes);
      return ok({ saved_path: output, size_bytes: bytes.length });
    }

    if (group === 'sheets' && sub === '+csv-get') {
      if (control.sheetResult !== undefined) return control.sheetResult;
      return ok({
        annotated_csv: state.sheetCsv,
        revision: '7',
        has_more: control.sheetHasMore === true,
        row_count: 2,
        col_count: 2,
      });
    }

    if (group === 'drive' && sub === '+preview') {
      if (control.previewResult !== undefined) return control.previewResult;
      const output = argValue(args, '--output');
      const bytes = Buffer.from(WORKBOOK_HTML(state.workbookCell), 'utf8');
      writeOutput(output, bytes);
      return ok({ saved_path: output, size_bytes: bytes.length, status: 'READY' });
    }

    return { code: 1, stdout: '', stderr: 'unexpected lark-cli call' };
  };

  const productionReaders = createCliResourceReaders({ run, limits });
  const resourceReaders = { ...productionReaders };
  if (control.imageReadable === false) {
    resourceReaders.image = async () => {
      throw new Error('READ_FAILED');
    };
  }
  if (control.readerOverrides) Object.assign(resourceReaders, control.readerOverrides);

  return {
    run,
    resourceReaders,
    hosts: [HOST],
    assetsDir,
    limits,
    calls,
    state,
    setRevision(value) {
      state.revision = value;
    },
    setDocumentId(value) {
      state.documentId = value;
    },
    setContent(value) {
      state.content = value;
    },
    setCommentPages(pages) {
      state.commentPages = pages;
    },
    replaceWorkbookCell(value) {
      state.workbookCell = value;
    },
    setFetchResult(result) {
      control.fetchResult = result;
    },
    clearFetchResult() {
      delete control.fetchResult;
    },
    imageBytes: IMAGE_BYTES,
    whiteboardPreviewBytes: WHITEBOARD_PREVIEW_BYTES,
    whiteboardRawBytes: WHITEBOARD_RAW_BYTES,
    workbookBytes: () => state.originalBytes,
    workbookHtmlBytes: () => Buffer.from(WORKBOOK_HTML(state.workbookCell), 'utf8'),
    sha256,
  };
}

function dispose(fixture) {
  rmSync(fixture.assetsDir, { recursive: true, force: true });
}

test('unread media remains visible in the source manifest', async (t) => {
  const fixture = platformFixture({ imageReadable: false });
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testDocLink);
  assert.equal(snapshot.resources.find((r) => r.kind === 'image').status, 'pending');
  assert.ok(snapshot.blocks.some((b) => b.text.includes('table-page-2')));
});

test('reads a docx into ordered blocks, heading context, both comment pages and a fingerprint', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testDocLink);

  assert.equal(snapshot.documentId, 'syntheticDocumentToken');
  assert.equal(snapshot.url, DOC_URL);
  assert.equal(snapshot.title, '勋章挑战系统');
  assert.equal(snapshot.revision, '1583');
  assert.equal(snapshot.requestId, testDocLink.requestId);
  assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/);

  const ids = snapshot.blocks.map((block) => block.id);
  assert.equal(snapshot.blocks[0].kind, 'title');
  assert.equal(snapshot.blocks[0].text, '勋章挑战系统');
  assert.ok(ids.indexOf('chapter-1') < ids.indexOf('p-1'));
  assert.ok(ids.indexOf('p-1') < ids.indexOf('cell-1-1'));
  assert.ok(ids.indexOf('cell-1-1') < ids.indexOf('cell-2-1'));

  const list = snapshot.blocks.find((block) => block.id === 'li-1');
  assert.equal(list.kind, 'list');
  assert.equal(list.text, '列表项');
  assert.equal(list.heading, '第一章 入口');

  const firstCell = snapshot.blocks.find((block) => block.id === 'cell-1-1');
  assert.equal(firstCell.kind, 'cell');
  assert.equal(firstCell.heading, '第一章 入口');
  assert.equal(snapshot.blocks.find((block) => block.id === 'p-1').heading, '第一章 入口');

  const heading = snapshot.blocks.find((block) => block.id === 'chapter-2');
  assert.equal(heading.kind, 'heading');
  assert.equal(heading.heading, '第二章 表格');
  const secondCell = snapshot.blocks.find((block) => block.id === 'cell-2-1');
  assert.equal(secondCell.kind, 'cell');
  assert.equal(secondCell.text, 'table-page-2');
  assert.equal(secondCell.heading, '第二章 表格');

  // Every td is a cell block, including an empty one.
  const emptyCell = snapshot.blocks.find((block) => block.id === 'cell-1-3');
  assert.equal(emptyCell.kind, 'cell');
  assert.equal(emptyCell.text, '');
  assert.equal(emptyCell.heading, '第一章 入口');

  assert.equal(snapshot.comments[0].id, 'comment-1');
  assert.equal(snapshot.comments[0].text, '第一页评论\n回复一');
  assert.equal(snapshot.comments[0].sourceBlockId, null);
  assert.equal(snapshot.comments[1].id, 'comment-2');
  assert.equal(snapshot.comments[1].text, '第二页评论');
  assert.equal(snapshot.commentsComplete, true);

  const fetchCalls = fixture.calls.filter((call) => call.args[0] === 'docs' && call.args[1] === '+fetch');
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(fetchCalls[0].args, [
    'docs', '+fetch',
    '--doc', DOC_URL,
    '--as', 'user',
    '--detail', 'full',
    '--json',
  ]);

  const commentCalls = fixture.calls.filter((call) => call.args[1] === '+list-comments');
  assert.equal(commentCalls.length, 2);
  assert.equal(commentCalls[1].args[commentCalls[1].args.indexOf('--page-token') + 1], 'comment-page-2');
});

test('reads a wiki link without outline scope and uses document_id as the identity', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testWikiLink);

  assert.equal(snapshot.documentId, 'syntheticDocumentToken');
  assert.notEqual(snapshot.documentId, testWikiLink.token);
  assert.equal(snapshot.url, WIKI_URL);

  const fetchCall = fixture.calls.find((call) => call.args[0] === 'docs' && call.args[1] === '+fetch');
  assert.equal(fetchCall.args[fetchCall.args.indexOf('--doc') + 1], WIKI_URL);
  assert.ok(!fetchCall.args.includes('--scope'));
  assert.ok(!fetchCall.args.some((arg) => arg.includes('outline')));
});

async function expectReadFailure(t, fixture, code, link = testDocLink) {
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  await assert.rejects(reader.read(link), (error) => {
    assert.equal(error.message, code);
    assert.ok(!error.message.includes('remote'));
    return true;
  });
}

function envelopeFailure(error) {
  return {
    code: 1,
    stdout: JSON.stringify({ ok: false, identity: 'user', error }),
    stderr: '',
  };
}

test('maps CLI failures to fixed codes without remote text', async (t) => {
  await expectReadFailure(t, platformFixture({
    fetchResult: { code: 2, stdout: '', stderr: 'remote secret stderr' },
  }), 'SOURCE_READ_FAILED');
  await expectReadFailure(t, platformFixture({
    fetchResult: { code: 0, stdout: 'not json at all', stderr: '' },
  }), 'SOURCE_READ_FAILED');
  await expectReadFailure(t, platformFixture({
    fetchResult: { code: 0, stdout: JSON.stringify({ ok: false, error: { code: 1001, message: 'remote secret detail' } }) },
  }), 'SOURCE_READ_FAILED');
  await expectReadFailure(t, platformFixture({
    fetchResult: envelopeFailure({
      code: 99991663,
      missing_scopes: ['docx:document:readonly'],
      message: 'remote missing scope message',
    }),
  }), 'SOURCE_ACCESS_DENIED');
  await expectReadFailure(t, platformFixture({
    fetchResult: envelopeFailure({ code: 403, message: 'remote denied' }),
  }), 'SOURCE_ACCESS_DENIED');
  await expectReadFailure(t, platformFixture({
    fetchResult: { code: 0, stdout: JSON.stringify({ ok: true, data: {} }), truncated: true },
  }), 'SOURCE_TRUNCATED');
  await expectReadFailure(t, platformFixture({
    fetchResult: { code: 0, stdout: JSON.stringify({ ok: true, data: { document: {} } }) },
  }), 'SOURCE_READ_FAILED');
});

test('enforces character, resource, pagination and byte limits', async (t) => {
  await expectReadFailure(t, platformFixture({ limits: { maxChars: 20 } }), 'SOURCE_LIMIT_EXCEEDED');
  await expectReadFailure(t, platformFixture({
    limits: { maxChars: 300 },
    commentsResult: ok({
      items: [{ comment_id: 'long-comment', quote: 'x'.repeat(2000), reply_list: [] }],
      has_more: false,
      page_token: '',
      count: 1,
    }),
  }), 'SOURCE_LIMIT_EXCEEDED');
  await expectReadFailure(t, platformFixture({ limits: { maxResources: 2 } }), 'SOURCE_LIMIT_EXCEEDED');
  await expectReadFailure(t, platformFixture({ limits: { maxPages: 1 } }), 'SOURCE_LIMIT_EXCEEDED');
  await expectReadFailure(t, platformFixture({ limits: { maxTotalBytes: 10 } }), 'SOURCE_LIMIT_EXCEEDED');
  await expectReadFailure(t, platformFixture({ commentsNoToken: true }), 'SOURCE_READ_FAILED');
});

test('materializes readable resources and keeps every unread medium in the manifest', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testDocLink);
  const requestDir = resolve(fixture.assetsDir, testDocLink.requestId);

  const images = snapshot.resources.filter((resource) => resource.kind === 'image');
  assert.equal(images.length, 2);
  for (const image of images) {
    assert.equal(image.status, 'parsed');
    assert.equal(image.reason, null);
    assert.match(image.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(dirname(image.path), requestDir);
    assert.ok(existsSync(image.path));
  }
  assert.equal(images[0].fingerprint, fixture.sha256([fixture.imageBytes(MEDIA.image1)]));
  assert.deepEqual(images[0].sourceIds, ['img-1']);

  const whiteboard = snapshot.resources.find((resource) => resource.kind === 'whiteboard');
  assert.equal(whiteboard.status, 'parsed');
  assert.ok(whiteboard.text.includes('画板文字'));
  assert.equal(whiteboard.text.split('画板文字').length - 1, 1);

  const spreadsheet = snapshot.resources.find((resource) => resource.kind === 'spreadsheet');
  assert.equal(spreadsheet.status, 'parsed');
  assert.equal(spreadsheet.text, 'A1,B1\nA2,B2');
  assert.equal(spreadsheet.path, null);

  const workbook = snapshot.resources.find((resource) => resource.kind === 'workbook');
  assert.equal(workbook.status, 'parsed');
  assert.ok(workbook.text.includes('B2原始值'));
  assert.ok(workbook.text.includes('[读取限制]'));

  const video = snapshot.resources.find((resource) => resource.kind === 'video');
  assert.equal(video.status, 'pending');
  assert.equal(video.reason, 'NO_READER');
});

test('a failing image reader leaves other resources readable', async (t) => {
  const fixture = platformFixture({ imageReadable: false });
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testDocLink);

  for (const image of snapshot.resources.filter((resource) => resource.kind === 'image')) {
    assert.equal(image.status, 'pending');
    assert.equal(image.reason, 'READ_FAILED');
    assert.equal(image.path, null);
  }
  for (const kind of ['whiteboard', 'spreadsheet', 'workbook']) {
    assert.equal(snapshot.resources.find((resource) => resource.kind === kind).status, 'parsed', kind);
  }
});

test('a failed spreadsheet read stays pending with its fixed reason', async (t) => {
  for (const reason of ['RESOURCE_TRUNCATED', 'RESOURCE_TOO_LARGE']) {
    const fixture = platformFixture({
      readerOverrides: {
        spreadsheet: async () => {
          throw new Error(reason);
        },
      },
    });
    t.after(() => dispose(fixture));
    const reader = createPlanningDocumentReader(fixture);
    const snapshot = await reader.read(testDocLink);
    const sheet = snapshot.resources.find((resource) => resource.kind === 'spreadsheet');
    assert.equal(sheet.status, 'pending', reason);
    assert.equal(sheet.reason, reason);
    assert.equal(sheet.path, null);
    // The failure stays local to that resource.
    assert.equal(snapshot.resources.find((resource) => resource.kind === 'image').status, 'parsed');
  }
});

test('references stay pending and are never followed recursively', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testDocLink);

  const references = snapshot.resources.filter((resource) => resource.kind === 'reference');
  assert.equal(references.length, 3);
  for (const reference of references) {
    assert.equal(reference.status, 'pending');
    assert.equal(reference.reason, 'REFERENCE_NOT_FOLLOWED');
    assert.equal(reference.path, null);
  }
  // A self-reference (anchor and reference_map) must not trigger a second fetch.
  assert.equal(fixture.calls.filter((call) => call.args[1] === '+fetch').length, 1);
});

test('reference_map accepts a URL key whose value is only a label', async (t) => {
  const target = `https://${HOST}/docx/labeledReference`;
  const fixture = platformFixture({
    content: '<p id="p-ref">仅引用</p>',
    referenceMap: { [target]: '带标题的引用' },
  });
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testDocLink);

  const references = snapshot.resources.filter((resource) => resource.kind === 'reference');
  assert.equal(references.length, 1);
  assert.equal(references[0].text, '带标题的引用');
  assert.equal(references[0].status, 'pending');
  assert.equal(references[0].reason, 'REFERENCE_NOT_FOLLOWED');
});

test('the serialized snapshot keeps media tokens and signed URLs out', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testDocLink);
  const serialized = JSON.stringify(snapshot);

  for (const token of Object.values(MEDIA)) {
    assert.ok(!serialized.includes(token), `snapshot leaked ${token}`);
  }
  assert.ok(!serialized.includes('fakeSignatureValue'));
  assert.ok(!serialized.includes(SIGNED_URL));
  assert.equal(snapshot.url, DOC_URL);
  assert.equal(JSON.parse(serialized).documentId, 'syntheticDocumentToken');
});

test('rejects missing or unsafe request ids and inconsistent document links', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);

  for (const requestId of [undefined, '', '../escape', 'a/b', 'a b']) {
    await assert.rejects(reader.read({ ...testDocLink, requestId }), { message: 'INVALID_REQUEST_ID' });
  }
  await assert.rejects(reader.read({ ...testDocLink, token: 'otherToken' }), { message: 'INVALID_DOCUMENT_LINK' });
  await assert.rejects(reader.read({ ...testDocLink, kind: 'wiki' }), { message: 'INVALID_DOCUMENT_LINK' });
  await assert.rejects(
    reader.read({ ...testDocLink, url: 'https://evil.example/docx/docxToken123' }),
    { message: 'INVALID_DOCUMENT_LINK' },
  );
  assert.equal(fixture.calls.length, 0);
});

test('resource ids and remote names cannot escape the request directory', async (t) => {
  const content = [
    '<p id="p-1">x</p>',
    `<img id="../../evil" name="../../outside.png" src="${MEDIA.image1}" alt="evil"/>`,
  ].join('');
  const fixture = platformFixture({ content, referenceMap: {} });
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testDocLink);
  const requestDir = resolve(fixture.assetsDir, testDocLink.requestId);

  const image = snapshot.resources.find((resource) => resource.kind === 'image');
  assert.equal(image.status, 'parsed');
  assert.equal(dirname(image.path), requestDir);
  assert.ok(!image.id.includes('..'));

  const mediaCall = fixture.calls.find((call) => call.args[1] === '+media-preview');
  const output = mediaCall.args[mediaCall.args.indexOf('--output') + 1];
  assert.equal(resolve(dirname(output)), requestDir);
  assert.ok(!output.includes('outside'));
});

test('a reader path outside requestDir is refused and left pending', async (t) => {
  const outside = join(tmpdir(), `planning-outside-${process.pid}-${Date.now()}.png`);
  writeFileSync(outside, 'outside');
  t.after(() => rmSync(outside, { force: true }));
  const fixture = platformFixture({
    readerOverrides: {
      image: async () => ({
        text: 'x',
        fingerprint: 'a'.repeat(64),
        sourceIds: ['img-1'],
        path: outside,
      }),
    },
  });
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const snapshot = await reader.read(testDocLink);
  for (const image of snapshot.resources.filter((resource) => resource.kind === 'image')) {
    assert.equal(image.status, 'pending');
    assert.equal(image.reason, 'READ_FAILED');
    assert.equal(image.path, null);
  }
});

test('revalidate reports unchanged, resource and document changes', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const before = await reader.read(testDocLink);

  assert.deepEqual(await reader.revalidate(before), { unchanged: true, changes: [] });

  const workbook = before.resources.find((resource) => resource.kind === 'workbook');
  fixture.replaceWorkbookCell('B2已修改');
  const resourceDiff = await reader.revalidate(before);
  assert.equal(resourceDiff.unchanged, false);
  assert.ok(resourceDiff.changes.some(
    (change) => change.target === 'resources' && change.id === workbook.id,
  ));

  fixture.setRevision('1584');
  const revisionDiff = await reader.revalidate(before);
  assert.equal(revisionDiff.unchanged, false);
  assert.ok(revisionDiff.changes.some((change) => change.target === 'document'));

  fixture.setRevision('1583');
  fixture.setContent(fixture.state.content.replace('活动期间', '活动期间改'));
  const blockDiff = await reader.revalidate(before);
  assert.equal(blockDiff.unchanged, false);
  assert.ok(blockDiff.changes.some(
    (change) => change.target === 'blocks' && change.id === 'p-1',
  ));
});

test('revalidate reports comment edits and ignores derived resource fields', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const before = await reader.read(testDocLink);
  assert.deepEqual(await reader.revalidate(before), { unchanged: true, changes: [] });

  // sourceIds is derived and must not show up as a resource change even when
  // the stored snapshot carries a stale pointer set.
  const stale = structuredClone(before);
  stale.resources = stale.resources.map((resource) => ({
    ...resource,
    sourceIds: [...resource.sourceIds, 'stale-derived-pointer'],
  }));
  fixture.setCommentPages({
    first: [{
      comment_id: 'comment-1',
      quote: '第一页评论',
      is_solved: false,
      reply_list: [{ content: '回复二' }],
    }],
    second: COMMENT_PAGES.second,
  });

  const diff = await reader.revalidate(stale);
  assert.equal(diff.unchanged, false);
  assert.deepEqual(diff.changes, [{ target: 'comments', id: 'comment-1' }]);
});

test('revalidate never treats an unreadable, truncated or replaced source as unchanged', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const before = await reader.read(testDocLink);

  for (const result of [
    { code: 1, stdout: '', stderr: 'remote failure' },
    { code: 0, stdout: 'not json' },
    { code: 0, stdout: JSON.stringify({ ok: true, data: {} }), truncated: true },
    envelopeFailure({ code: 99991672, missing_scopes: ['docx:read'], message: 'remote' }),
  ]) {
    fixture.setFetchResult(result);
    await assert.rejects(reader.revalidate(before), { message: 'SOURCE_RECHECK_FAILED' });
  }

  fixture.clearFetchResult();
  fixture.setDocumentId('replacementDocumentToken');
  await assert.rejects(reader.revalidate(before), { message: 'SOURCE_RECHECK_FAILED' });

  for (const invalid of [
    { ...before, blocks: null },
    { ...before, requestId: '../escape' },
    { ...before, url: 'https://evil.example/docx/docxToken123' },
    { ...before, fingerprint: '' },
  ]) {
    await assert.rejects(reader.revalidate(invalid), { message: 'SOURCE_RECHECK_FAILED' });
  }
});

test('cleanup removes the request directory and rejects unsafe ids', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);

  await reader.read(testDocLink);
  const requestDir = resolve(fixture.assetsDir, testDocLink.requestId);
  assert.ok(existsSync(requestDir));
  reader.cleanup(testDocLink.requestId);
  assert.equal(existsSync(requestDir), false);

  assert.throws(() => reader.cleanup('../escape'), { message: 'INVALID_REQUEST_ID' });
  assert.throws(() => reader.cleanup(''), { message: 'INVALID_REQUEST_ID' });
  assert.doesNotThrow(() => reader.cleanup('req_missing_1'));
});

test('cleanup maps filesystem failures to a fixed code without echoing paths', (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  // A NUL byte makes rmSync itself reject on every platform, which exercises
  // the mapping without a platform-specific permission setup.
  const hostile = createPlanningDocumentReader({
    ...fixture,
    assetsDir: join(tmpdir(), 'planning-cleanup', 'bad\u0000dir'),
  });
  assert.throws(() => hostile.cleanup('req_cleanup_1'), (error) => {
    assert.equal(error.message, 'CLEANUP_FAILED');
    assert.ok(!error.message.includes(tmpdir()));
    assert.ok(!error.message.includes('bad'));
    return true;
  });
  assert.throws(() => hostile.cleanup('../escape'), { message: 'INVALID_REQUEST_ID' });
});

test('production resource readers match the verified argv and hash real bytes', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const requestDir = mkdtempSync(join(tmpdir(), 'planning-res-'));
  t.after(() => rmSync(requestDir, { recursive: true, force: true }));
  const readers = createCliResourceReaders({ run: fixture.run, limits: fixture.limits });

  const image = await readers.image({
    resource: {
      id: 'image-1',
      kind: 'image',
      sourceBlockId: 'img-1',
      text: 'alt text',
      token: MEDIA.image1,
    },
    requestDir,
  });
  assert.equal(image.path, join(requestDir, 'image-1'));
  assert.equal(image.fingerprint, fixture.sha256([fixture.imageBytes(MEDIA.image1)]));
  assert.equal(image.bytes, fixture.imageBytes(MEDIA.image1).length);
  assert.deepEqual(image.sourceIds, ['img-1']);
  const imageCall = fixture.calls.find(
    (call) => call.args[0] === 'docs' && call.args[1] === '+media-preview'
      && call.args.includes(MEDIA.image1),
  );
  assert.deepEqual(imageCall.args, [
    'docs', '+media-preview',
    '--token', MEDIA.image1,
    '--output', join(requestDir, 'image-1'),
    '--as', 'user', '--json', '--overwrite',
  ]);

  const whiteboard = await readers.whiteboard({
    resource: {
      id: 'wb-1',
      kind: 'whiteboard',
      sourceBlockId: 'wb-1',
      text: '',
      token: MEDIA.whiteboard,
    },
    requestDir,
  });
  assert.equal(whiteboard.fingerprint, fixture.sha256([
    fixture.whiteboardPreviewBytes,
    fixture.whiteboardRawBytes(),
  ]));
  assert.ok(whiteboard.text.includes('画板文字'));
  assert.equal(whiteboard.text.split('画板文字').length - 1, 1);
  assert.ok(whiteboard.text.includes('第二段'));
  assert.ok(!whiteboard.text.includes(MEDIA.whiteboard));
  assert.ok(!whiteboard.text.includes(SIGNED_URL));
  assert.equal(dirname(whiteboard.path), requestDir);
  const whiteboardCalls = fixture.calls.filter((call) => call.args[0] === 'whiteboard');
  assert.deepEqual(whiteboardCalls[0].args, [
    'whiteboard', '+export',
    '--whiteboard-token', MEDIA.whiteboard,
    '--output-type', 'preview',
    '--output', join(requestDir, 'wb-1-whiteboard'),
    '--as', 'user', '--json',
  ]);
  assert.deepEqual(whiteboardCalls[1].args, [
    'whiteboard', '+export',
    '--whiteboard-token', MEDIA.whiteboard,
    '--output-type', 'raw',
    '--output', join(requestDir, 'wb-1-whiteboard-nodes.json'),
    '--as', 'user', '--json',
  ]);

  const spreadsheet = await readers.spreadsheet({
    resource: {
      id: 'sheet-1',
      kind: 'spreadsheet',
      sourceBlockId: 'sheet-1',
      token: MEDIA.sheet,
      sheetId: 'sheetId01',
    },
    requestDir,
  });
  assert.equal(spreadsheet.text, 'A1,B1\nA2,B2');
  assert.equal(spreadsheet.path, null);
  assert.equal(spreadsheet.fingerprint, fixture.sha256(['7\nA1,B1\nA2,B2']));
  const sheetCall = fixture.calls.find((call) => call.args[0] === 'sheets');
  assert.deepEqual(sheetCall.args, [
    'sheets', '+csv-get',
    '--spreadsheet-token', MEDIA.sheet,
    '--sheet-id', 'sheetId01',
    '--max-chars', '30000',
    '--as', 'user', '--json',
  ]);

  const workbook = await readers.workbook({
    resource: {
      id: 'xlsx-1',
      kind: 'workbook',
      sourceBlockId: 'source-1',
      token: MEDIA.xlsx,
    },
    requestDir,
  });
  assert.equal(workbook.path, join(requestDir, 'xlsx-1-original'));
  assert.equal(workbook.fingerprint, fixture.sha256([
    fixture.workbookBytes(),
    Buffer.from('\n'),
    fixture.workbookHtmlBytes(),
  ]));
  assert.equal(workbook.bytes, fixture.workbookBytes().length + fixture.workbookHtmlBytes().length);
  assert.ok(workbook.text.includes('B2原始值'));
  assert.ok(workbook.text.includes('[读取限制]'));
  assert.ok(!workbook.text.includes('secretScript'));
  const previewCall = fixture.calls.find(
    (call) => call.args[0] === 'drive' && call.args[1] === '+preview',
  );
  assert.deepEqual(previewCall.args, [
    'drive', '+preview',
    '--file-token', MEDIA.xlsx,
    '--type', 'html',
    '--output', join(requestDir, 'xlsx-1-preview.html'),
    '--if-exists', 'overwrite',
    '--as', 'user', '--json',
  ]);
});

test('production reader failures use fixed codes and fail closed', async (t) => {
  const truncated = platformFixture({ sheetHasMore: true });
  t.after(() => dispose(truncated));
  const truncatedReaders = createCliResourceReaders({ run: truncated.run, limits: truncated.limits });
  await assert.rejects(truncatedReaders.spreadsheet({
    resource: {
      id: 'sheet-1',
      kind: 'spreadsheet',
      sourceBlockId: 'sheet-1',
      token: MEDIA.sheet,
      sheetId: 'sheetId01',
    },
    requestDir: truncated.assetsDir,
  }), { message: 'RESOURCE_TRUNCATED' });

  const oversized = platformFixture();
  t.after(() => dispose(oversized));
  const tiny = createCliResourceReaders({
    run: oversized.run,
    limits: { maxResourceBytes: 4 },
  });
  await assert.rejects(tiny.image({
    resource: { id: 'image-1', kind: 'image', sourceBlockId: 'img-1', token: MEDIA.image1 },
    requestDir: oversized.assetsDir,
  }), { message: 'RESOURCE_TOO_LARGE' });

  const missing = platformFixture({ writePreview: false });
  t.after(() => dispose(missing));
  const missingReaders = createCliResourceReaders({ run: missing.run, limits: missing.limits });
  await assert.rejects(missingReaders.image({
    resource: { id: 'image-1', kind: 'image', sourceBlockId: 'img-1', token: MEDIA.image1 },
    requestDir: missing.assetsDir,
  }), { message: 'READ_FAILED' });

  const failing = platformFixture({ failMediaToken: MEDIA.image1 });
  t.after(() => dispose(failing));
  const failingReaders = createCliResourceReaders({ run: failing.run, limits: failing.limits });
  await assert.rejects(failingReaders.image({
    resource: { id: 'image-1', kind: 'image', sourceBlockId: 'img-1', token: MEDIA.image1 },
    requestDir: failing.assetsDir,
  }), (error) => {
    assert.equal(error.message, 'SOURCE_READ_FAILED');
    assert.ok(!error.message.includes('remote'));
    return true;
  });

  // Whiteboard preview and raw are each under the cap, but the resource sum is
  // over it, so the resource must not be treated as parsed.
  const summed = platformFixture();
  t.after(() => dispose(summed));
  const previewLength = summed.whiteboardPreviewBytes.length;
  const rawLength = summed.whiteboardRawBytes().length;
  const whiteboardCapped = createCliResourceReaders({
    run: summed.run,
    limits: { maxResourceBytes: previewLength + rawLength - 1 },
  });
  await assert.rejects(whiteboardCapped.whiteboard({
    resource: {
      id: 'wb-1',
      kind: 'whiteboard',
      sourceBlockId: 'wb-1',
      token: MEDIA.whiteboard,
    },
    requestDir: summed.assetsDir,
  }), { message: 'RESOURCE_TOO_LARGE' });

  // The workbook original and its HTML preview are each under the cap, but
  // their combined bytes are not.
  const workbookCapped = createCliResourceReaders({
    run: summed.run,
    limits: {
      maxResourceBytes: summed.workbookBytes().length
        + summed.workbookHtmlBytes().length - 1,
    },
  });
  await assert.rejects(workbookCapped.workbook({
    resource: {
      id: 'xlsx-1',
      kind: 'workbook',
      sourceBlockId: 'source-1',
      token: MEDIA.xlsx,
    },
    requestDir: summed.assetsDir,
  }), { message: 'RESOURCE_TOO_LARGE' });
});

test('fingerprint is deterministic and independent of the request directory', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const first = await reader.read(testDocLink);
  const second = await reader.read(testDocLink);
  assert.equal(first.fingerprint, second.fingerprint);

  const otherAssets = mkdtempSync(join(tmpdir(), 'planning-doc-other-'));
  t.after(() => rmSync(otherAssets, { recursive: true, force: true }));
  const otherReader = createPlanningDocumentReader({ ...fixture, assetsDir: otherAssets });
  const third = await otherReader.read({ ...testDocLink, requestId: 'req_other_1' });
  assert.equal(third.fingerprint, first.fingerprint);

  const firstImage = first.resources.find((resource) => resource.kind === 'image');
  const thirdImage = third.resources.find((resource) => resource.kind === 'image');
  assert.notEqual(firstImage.path, thirdImage.path);
});

test('the fingerprint and diff ignore path, requestId and sourceIds', async (t) => {
  const fixture = platformFixture();
  t.after(() => dispose(fixture));
  const reader = createPlanningDocumentReader(fixture);
  const before = await reader.read(testDocLink);

  // A different requestId implies different local paths; both are derived and
  // must leave the stored fingerprint intact across a re-read.
  const relocated = structuredClone(before);
  relocated.requestId = 'req_relocated_1';
  relocated.resources = relocated.resources.map((resource) => ({
    ...resource,
    path: resource.path === null ? null : `${resource.path}.decoy`,
  }));
  assert.deepEqual(await reader.revalidate(relocated), { unchanged: true, changes: [] });

  // A reader that reports a different sourceIds set on the second read must
  // not perturb the fingerprint either.
  let round = 0;
  const churn = platformFixture({
    readerOverrides: {
      image: async ({ resource }) => {
        round += 1;
        return {
          text: '',
          fingerprint: 'b'.repeat(64),
          sourceIds: [`${resource.sourceBlockId}-derived-${round}`],
          path: null,
        };
      },
    },
  });
  t.after(() => dispose(churn));
  const churnReader = createPlanningDocumentReader(churn);
  const first = await churnReader.read({ ...testDocLink, requestId: 'req_source_1' });
  assert.deepEqual(await churnReader.revalidate(first), { unchanged: true, changes: [] });
});

test('saved_path is resolved inside the request directory before the cwd', async (t) => {
  const fixture = platformFixture({ mediaSavedPath: 'image-1' });
  t.after(() => dispose(fixture));
  const requestDir = mkdtempSync(join(tmpdir(), 'planning-saved-'));
  t.after(() => rmSync(requestDir, { recursive: true, force: true }));
  const cwdDir = mkdtempSync(join(tmpdir(), 'planning-cwd-'));
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    rmSync(cwdDir, { recursive: true, force: true });
  });

  // A same-named file in the process cwd must not shadow the real output.
  writeFileSync(join(cwdDir, 'image-1'), 'cwd decoy bytes');
  process.chdir(cwdDir);

  const readers = createCliResourceReaders({ run: fixture.run, limits: fixture.limits });
  const image = await readers.image({
    resource: { id: 'image-1', kind: 'image', sourceBlockId: 'img-1', token: MEDIA.image1 },
    requestDir,
  });
  assert.equal(image.path, join(requestDir, 'image-1'));
  assert.equal(image.fingerprint, fixture.sha256([fixture.imageBytes(MEDIA.image1)]));
  assert.equal(existsSync(join(cwdDir, 'image-1')), true);
});



