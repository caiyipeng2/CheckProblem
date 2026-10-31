import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChildFields, buildParentFields, createTapdStories } from '../src/tapd-stories.js';
import { makeDraft, makeRequest } from './requirement-fixtures.js';

const TOKEN = 'tapd-story-test-token';
const MARKER = 'req-r1-M01';
const BASE_URL = 'https://api.tapd.cn';

const target = {
  workspaceId: '59180547',
  parentTypeId: '1159180547001000025',
  childTypeId: '1159180547001000027',
  templateId: '1159180547001000039',
  childDefaults: { owner: 'default_owner', iterationId: '1159180547001000128' },
  parent: {
    title: '勋章挑战系统（总单）',
    owner: 'parent_owner',
    iterationId: '1159180547001000111',
  },
};

// The flat draft-story view Task 8 will build from a frozen story.fields.
function flatStory(overrides = {}) {
  return {
    key: 'M01',
    title: '大厅入口',
    rules: [{ text: '活动期间显示大厅入口。', factIds: ['F1'] }],
    acceptance: [{ text: '可从大厅进入活动。', factIds: ['F1'] }],
    factIds: ['F1'],
    sourceIds: ['b_m01', 'b_m02', 'r_img', 'r_video', 'c_1'],
    issueIds: ['Q1', 'Q2'],
    owner: null,
    iterationId: undefined,
    dependencies: ['M02'],
    ...overrides,
  };
}

function childRequest() {
  const base = makeDraft().stories[0];
  return makeRequest({
    draft: makeDraft({
      stories: [{
        ...base,
        key: 'M01',
        title: '大厅入口',
        dependencies: ['M02'],
        sourceIds: ['b_m01', 'b_m02', 'r_img', 'r_video', 'c_1'],
        issueIds: ['Q1', 'Q2'],
      }],
      issues: [
        {
          id: 'Q1',
          question: '是否允许 <script> 倒计时？',
          storyKeys: ['M01'],
          blocking: true,
          resolvedBy: null,
        },
        {
          id: 'Q2',
          question: '已经解决的问题不应出现',
          storyKeys: ['M01'],
          blocking: false,
          resolvedBy: { actorId: 'ou_reviewer', text: '已确认', at: '2026-01-01T00:00:00.000Z' },
        },
      ],
    }),
  });
}

function parentRequest() {
  const base = makeDraft().stories[0];
  return makeRequest({
    draft: makeDraft({
      stories: [
        { ...base, disposition: 'approved', title: '大厅入口 <b>一期</b>' },
        { ...base, key: 'M02', disposition: 'deferred', title: '延期：排行 & 奖励' },
      ],
      issues: [
        {
          id: 'Q1',
          question: '倒计时是否 <script> 可配置？',
          storyKeys: ['M01', 'M02'],
          blocking: true,
          resolvedBy: null,
        },
        {
          id: 'Q2',
          question: '已经解决的问题不应出现',
          storyKeys: ['M01'],
          blocking: false,
          resolvedBy: { actorId: 'ou_reviewer', text: '已确认', at: '2026-01-01T00:00:00.000Z' },
        },
      ],
      exclusions: [
        { factIds: ['F2'], reason: '本期不做 "二期" <活动>', approvedBy: 'ou_reviewer' },
      ],
    }),
  });
}

// The plan's RED case: escaping, parent binding and no bug fields.
test('child fields escape text and keep the given parent', () => {
  const fields = buildChildFields({
    story: flatStory({ title: '<img onerror=x>' }),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1159180547001000777' },
    marker: MARKER,
  });
  assert.equal(fields.parent_id, 'P1');
  assert.ok(!fields.description.includes('<img onerror=x>'));
  assert.ok(fields.description.includes(MARKER));
  assert.equal(Object.hasOwn(fields, 'current_owner'), false);
});

test('parent template carries the document identity and the approved scope', () => {
  const fields = buildParentFields({ request: parentRequest(), target, marker: MARKER });
  assert.equal(fields.workspace_id, '59180547');
  assert.equal(fields.name, '勋章挑战系统（总单）');
  assert.equal(fields.workitem_type_id, '1159180547001000025');
  assert.equal(fields.templated_id, '1159180547001000039');
  assert.equal(fields.owner, 'parent_owner');
  assert.equal(fields.iteration_id, '1159180547001000111');
  assert.ok(fields.description.includes('https://example.feishu.cn/docx/docx_abc'));
  assert.ok(fields.description.includes('rev-1'));
  assert.ok(fields.description.includes('sha256:doc-1'));
  assert.ok(fields.description.includes('大厅入口 &lt;b&gt;一期&lt;/b&gt;'));
  assert.ok(fields.description.includes('延期：排行 &amp; 奖励'));
  assert.ok(fields.description.includes('本期不做 &quot;二期&quot; &lt;活动&gt;'));
  assert.ok(fields.description.includes('[阻塞] 倒计时是否 &lt;script&gt; 可配置？'));
  assert.ok(!fields.description.includes('已经解决的问题不应出现'));
  assert.ok(fields.description.includes('本单不附带飞书附件，来源见需求文档链接'));
  assert.deepEqual(fields.description.split('<br />').at(-1), `【追踪标识】${MARKER}`);
  for (const key of [
    'status', 'priority_label', 'current_owner', 'os', 'cc', 'creator', 'developer',
    'apply_template', 'is_apply_template_default_value',
  ]) {
    assert.equal(Object.hasOwn(fields, key), false, `${key} is not a story-template field`);
  }
});

test('parent fields keep the document id discoverable when the wiki url token differs', async () => {
  const documentId = 'doxcn_doc_999';
  const request = parentRequest();
  request.snapshot.documentId = documentId;
  request.snapshot.url = 'https://example.feishu.cn/wiki/wikcn_node_777';
  const fields = buildParentFields({ request, target, marker: MARKER });
  assert.ok(fields.description.includes('wikcn_node_777'));
  assert.ok(fields.description.includes(
    `（文档 ID：${documentId}；本单不附带飞书附件，来源见需求文档链接）`,
  ));

  const { client } = createClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return response({
      status: 1,
      data: page === 1
        ? [storyItem({
          id: 'P1',
          name: fields.name,
          parent_id: '0',
          description: fields.description,
        })]
        : [],
    });
  });
  const found = await client.findParents({
    workspaceId: '59180547',
    name: fields.name,
    documentId,
  });
  assert.equal(found.complete, true);
  assert.deepEqual(found.items.map((story) => story.id), ['P1']);

  const other = await client.findParents({
    workspaceId: '59180547',
    name: fields.name,
    documentId: 'doxcn_other_111',
  });
  assert.deepEqual(other.items, []);
});

test('parent template omits owner and iteration unless configured and falls back to the snapshot title', () => {
  const fields = buildParentFields({
    request: parentRequest(),
    target: { ...target, parent: undefined },
    marker: MARKER,
  });
  assert.equal(fields.name, '勋章挑战系统');
  assert.equal(Object.hasOwn(fields, 'owner'), false);
  assert.equal(Object.hasOwn(fields, 'iteration_id'), false);
});

test('parent title drops control characters and is clipped to 100 characters', () => {
  const long = `标\n题${'字'.repeat(200)}`;
  const fields = buildParentFields({
    request: parentRequest(),
    target: { ...target, parent: { title: long } },
    marker: MARKER,
  });
  assert.equal(fields.name.length, 100);
  assert.ok(!fields.name.includes('\n'));
});

test('title clipping never splits a surrogate pair', () => {
  const fields = buildParentFields({
    request: parentRequest(),
    target: { ...target, parent: { title: `${'a'.repeat(99)}𝌆${'b'.repeat(20)}` } },
    marker: MARKER,
  });
  assert.equal(fields.name.length, 99);
  assert.ok(!/[\uD800-\uDFFF]/.test(fields.name));
});

test('parent template keeps the marker last when exclusions overflow the description', () => {
  const request = parentRequest();
  request.draft.exclusions[0].reason = '长'.repeat(9000);
  const fields = buildParentFields({ request, target, marker: MARKER });
  assert.ok(fields.description.length <= 6000);
  assert.deepEqual(fields.description.split('<br />').at(-1), `【追踪标识】${MARKER}`);
});

test('child template renders rules before acceptance, dependencies and sources', () => {
  const fields = buildChildFields({
    story: flatStory(),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1159180547001000777' },
    marker: MARKER,
  });
  const description = fields.description;
  const positions = [
    '【功能规则】',
    '【验收条件】',
    '【依赖】',
    '【需求来源】',
    '【待确认/范围说明】',
  ].map((label) => description.indexOf(label));
  assert.ok(positions.every((position) => position >= 0), 'every section is present');
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.ok(description.includes('M02（TAPD #1159180547001000777）'));
  assert.ok(description.includes('来源块：b_m01、b_m02'));
  assert.ok(description.includes('评论：c_1'));
  assert.ok(description.includes('r_video（未读取）'));
  assert.ok(!description.includes('r_img'), 'parsed resources are not named in the ticket');
  assert.ok(!description.includes('C:/assets'), 'no local path leaks into the ticket');
  assert.ok(!description.includes('r_img.jpg'));
  assert.ok(description.includes('是否允许 &lt;script&gt; 倒计时？'));
  assert.ok(!description.includes('已经解决的问题不应出现'));
  assert.ok(!description.includes('<script>'));
  assert.deepEqual(description.split('<br />').at(-1), `【追踪标识】${MARKER}`);
});

test('child template escapes every rule, acceptance and title fragment', () => {
  const fields = buildChildFields({
    story: flatStory({
      title: '<img onerror=x>',
      rules: [{ text: '规则 <b>加粗</b> & "引号" \'单引\'', factIds: ['F1'] }],
      acceptance: [{ text: '验收 <script>alert(1)</script>', factIds: ['F1'] }],
    }),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1159180547001000777' },
    marker: MARKER,
  });
  assert.ok(!fields.description.includes('<b>'));
  assert.ok(fields.description.includes('&lt;b&gt;加粗&lt;/b&gt; &amp; &quot;引号&quot; &#39;单引&#39;'));
  assert.ok(!fields.description.includes('<script>'));
  assert.ok(fields.description.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(fields.name, '<img onerror=x>');
});

test('child title drops control characters and is clipped to 100 characters', () => {
  const fields = buildChildFields({
    story: flatStory({ title: `标\n题${'字'.repeat(200)}` }),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1' },
    marker: MARKER,
  });
  assert.equal(fields.name.length, 100);
  assert.ok(!fields.name.includes('\n'));
});

test('child template carries the document link, revision, fingerprint and attachment declaration', () => {
  const fields = buildChildFields({
    story: flatStory(),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1' },
    marker: MARKER,
  });
  const description = fields.description;
  assert.ok(description.includes(
    '<a href="https://example.feishu.cn/docx/docx_abc">'
      + 'https://example.feishu.cn/docx/docx_abc</a>',
  ));
  assert.ok(description.includes('版本：rev-1（指纹 sha256:doc-1）'));
  assert.ok(description.includes('本单不附带飞书附件'));
});

test('child template keeps the marker last when rules overflow the description', () => {
  const rules = Array.from({ length: 10 }, () => ({ text: '规'.repeat(2000), factIds: ['F1'] }));
  const fields = buildChildFields({
    story: flatStory({ rules }),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1' },
    marker: MARKER,
  });
  assert.ok(fields.description.length <= 6000);
  assert.deepEqual(fields.description.split('<br />').at(-1), `【追踪标识】${MARKER}`);
});

test('clipped descriptions stay well formed around the document link', () => {
  const fillers = [
    { label: 'bmp', step: 1, fill: (length) => '字'.repeat(length) },
    { label: 'ampersand', step: 1, fill: (length) => '&'.repeat(length) },
    { label: 'astral', step: 7, fill: (length) => '𝌆'.repeat(Math.ceil(length / 2)) },
  ];
  const tail = `【追踪标识】${MARKER}`;
  for (const { label, step, fill } of fillers) {
    for (let length = 4700; length <= 6000; length += step) {
      const where = `${label} rule length ${length}`;
      const fields = buildChildFields({
        story: flatStory({ rules: [{ text: fill(length), factIds: ['F1'] }] }),
        request: childRequest(),
        target,
        parentId: 'P1',
        dependencyIds: { M02: '1' },
        marker: MARKER,
      });
      const description = fields.description;
      assert.ok(description.length <= 6000, `limit at ${where}`);
      assert.deepEqual(description.split('<br />').at(-1), tail, `marker last at ${where}`);
      const body = description.slice(0, description.length - tail.length - '<br />'.length);
      assert.ok(!/&[A-Za-z#0-9]*$/.test(body), `entity fragment at ${where}`);
      assert.ok(!/<[^>]*$/.test(body), `tag fragment at ${where}`);
      const opens = (description.match(/<a /g) ?? []).length;
      const closes = (description.match(/<\/a>/g) ?? []).length;
      assert.equal(opens, closes, `balanced anchors at ${where}`);
      const tags = description.match(/<a |<\/a>/g) ?? [];
      let depth = 0;
      for (const tag of tags) {
        depth += tag === '<a ' ? 1 : -1;
        assert.ok(depth >= 0, `stray closer at ${where}`);
      }
      assert.equal(depth, 0, `anchor left open at ${where}`);
      assert.ok(!/^<\/a>/.test(description), `leading closer at ${where}`);
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(description), `lone high at ${where}`);
      assert.ok(!/[^\uD800-\uDBFF][\uDC00-\uDFFF]/.test(description), `lone low at ${where}`);
    }
  }
});

test('child owner and iteration prefer the story and fall back to child defaults', () => {
  const fallback = buildChildFields({
    story: flatStory({ owner: null, iterationId: undefined }),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1' },
    marker: MARKER,
  });
  assert.equal(fallback.owner, 'default_owner');
  assert.equal(fallback.iteration_id, '1159180547001000128');

  const explicit = buildChildFields({
    story: flatStory({ owner: 'story_owner', iterationId: '1159180547001000999' }),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1' },
    marker: MARKER,
  });
  assert.equal(explicit.owner, 'story_owner');
  assert.equal(explicit.iteration_id, '1159180547001000999');

  const none = buildChildFields({
    story: flatStory({ owner: null, iterationId: undefined }),
    request: childRequest(),
    target: { ...target, childDefaults: undefined },
    parentId: 'P1',
    dependencyIds: { M02: '1' },
    marker: MARKER,
  });
  assert.equal(Object.hasOwn(none, 'owner'), false);
  assert.equal(Object.hasOwn(none, 'iteration_id'), false);
});

test('child fields never carry bug-client fields', () => {
  const fields = buildChildFields({
    story: flatStory(),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1' },
    marker: MARKER,
  });
  for (const key of [
    'current_owner', 'os', 'status', 'priority_label', 'cc', 'creator', 'developer',
    'apply_template', 'is_apply_template_default_value',
  ]) {
    assert.equal(Object.hasOwn(fields, key), false, `${key} is not a story-template field`);
  }
});

test('a dependency without a TAPD id is refused as INVALID_DEPENDENCY', () => {
  assert.throws(
    () => buildChildFields({
      story: flatStory({ dependencies: ['M02'] }),
      request: childRequest(),
      target,
      parentId: 'P1',
      dependencyIds: {},
      marker: MARKER,
    }),
    (error) => error.code === 'INVALID_DEPENDENCY',
  );
});

test('no dependencies renders 无', () => {
  const fields = buildChildFields({
    story: flatStory({ dependencies: [] }),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: {},
    marker: MARKER,
  });
  assert.ok(fields.description.includes('【依赖】<br />无<br />'));
});

test('both template builders reject an invalid marker', () => {
  for (const marker of ['bad marker', '', 'a'.repeat(65), '中文追踪']) {
    assert.throws(
      () => buildParentFields({ request: parentRequest(), target, marker }),
      (error) => error.code === 'INVALID_MARKER',
    );
    assert.throws(
      () => buildChildFields({
        story: flatStory(),
        request: childRequest(),
        target,
        parentId: 'P1',
        dependencyIds: { M02: '1' },
        marker,
      }),
      (error) => error.code === 'INVALID_MARKER',
    );
  }
});

test('description templates refuse non-http document links', () => {
  const parent = parentRequest();
  parent.snapshot.url = 'javascript:alert(1)';
  const parentFields = buildParentFields({ request: parent, target, marker: MARKER });
  assert.ok(!parentFields.description.includes('javascript'));

  const child = childRequest();
  child.snapshot.url = 'javascript:alert(1)';
  const childFields = buildChildFields({
    story: flatStory(),
    request: child,
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1' },
    marker: MARKER,
  });
  assert.ok(!childFields.description.includes('javascript'));
});

test('newlines in dynamic text become html breaks', () => {
  const fields = buildChildFields({
    story: flatStory({ rules: [{ text: '第一行\n第二行', factIds: ['F1'] }] }),
    request: childRequest(),
    target,
    parentId: 'P1',
    dependencyIds: { M02: '1' },
    marker: MARKER,
  });
  assert.ok(fields.description.includes('1. 第一行<br />第二行'));
});

// ---- HTTP adapter -------------------------------------------------------

function response(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function createClient(handler, { token = TOKEN, readFile } = {}) {
  const calls = [];
  const client = createTapdStories({
    tokenFile: 'C:/secrets/tapd.token',
    readFile: readFile ?? (() => `key：${token}\n`),
    request: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
    timeoutMs: 1000,
  });
  return { client, calls };
}

function storyItem(overrides = {}) {
  return {
    Story: {
      id: '1159180547001000001',
      workspace_id: '59180547',
      name: '总单',
      parent_id: '0',
      children_id: '||1159180547001000002|1159180547001000003',
      ancestor_id: '1159180547001000001',
      level: '0',
      workitem_type_id: '1159180547001000025',
      templated_id: '1159180547001000039',
      iteration_id: '1159180547001000128',
      description: '<p>正文</p>',
      ...overrides,
    },
  };
}

function listItem(id, overrides = {}) {
  return storyItem({
    id,
    name: `子单 ${id}`,
    parent_id: 'P1',
    children_id: '|',
    ancestor_id: 'P1',
    level: '1',
    ...overrides,
  });
}

test('createStory posts every field as a form body with a forced workspace', async () => {
  const { client, calls } = createClient(() => response({
    status: 1,
    info: 'success',
    data: { Story: { id: '1159180547001000001' } },
  }));
  const result = await client.createStory({
    workspaceId: '59180547',
    fields: {
      workspace_id: '99999999',
      name: '子单标题',
      parent_id: '1159180547001000025',
      workitem_type_id: '1159180547001000027',
      templated_id: '1159180547001000039',
      description: '描述正文',
      owner: 'someone',
      iteration_id: '1159180547001000128',
    },
  });

  assert.deepEqual(result, { id: '1159180547001000001' });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${BASE_URL}/stories`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal, 'every request carries a timeout signal');

  const body = new URLSearchParams(init.body);
  assert.equal(body.get('workspace_id'), '59180547', 'the workspace argument wins over fields');
  assert.equal(body.get('name'), '子单标题');
  assert.equal(body.get('parent_id'), '1159180547001000025');
  assert.equal(body.get('workitem_type_id'), '1159180547001000027');
  assert.equal(body.get('templated_id'), '1159180547001000039');
  assert.equal(body.get('description'), '描述正文');
  assert.equal(body.get('owner'), 'someone');
  assert.equal(body.get('iteration_id'), '1159180547001000128');
  assert.ok(!url.includes(TOKEN), 'the token stays in the Authorization header');
  assert.ok(!init.body.includes(TOKEN));
});

test('a story id above 2^53 keeps every digit in the form body', async () => {
  const { client, calls } = createClient(() => response({
    status: 1,
    data: { Story: { id: '1159180547001000001' } },
  }));
  await client.createStory({
    workspaceId: '59180547',
    fields: {
      name: 'N',
      parent_id: '1159180547001000025',
      templated_id: '1159180547001000039',
    },
  });
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('parent_id'), '1159180547001000025');
  assert.equal(body.get('templated_id'), '1159180547001000039');
  assert.ok(!calls[0].init.body.includes('e+'));
});

test('createStory reports UNSENT and never calls fetch without a token', async () => {
  const { client, calls } = createClient(
    () => response({ status: 1, data: { Story: { id: '1' } } }),
    { readFile: () => { throw new Error('ENOENT'); } },
  );
  const error = await client.createStory({ workspaceId: '1', fields: { name: 'N' } })
    .catch((caught) => caught);
  assert.equal(error.code, 'UNSENT');
  assert.deepEqual(calls, []);
  assert.ok(!error.message.includes(TOKEN));
});

test('an explicit status:0 rejection is REJECTED and keeps the response text out of the message', async () => {
  const info = '标题不能为空';
  const { client } = createClient(() => response({ status: 0, info, data: [] }, 400));
  const error = await client.createStory({
    workspaceId: '1',
    fields: { name: 'N', description: 'secret description' },
  }).catch((caught) => caught);
  assert.equal(error.code, 'REJECTED');
  assert.equal(error.status, 400);
  assert.match(error.message, /HTTP 400/);
  assert.ok(!error.message.includes(info));
  assert.ok(!error.message.includes('secret description'));
  assert.ok(!error.message.includes(TOKEN));
});

test('ambiguous create failures are UNKNOWN and sanitized', async () => {
  const cases = [
    {
      label: 'non json body',
      handler: () => response('<html>login</html>'),
    },
    {
      label: 'http 500 even with a story shape',
      handler: () => response({ status: 1, data: { Story: { id: '1' } } }, 500),
    },
    {
      label: 'success without a story id',
      handler: () => response({ status: 1, info: 'success', data: [] }),
    },
    {
      label: 'status 0 without info',
      handler: () => response({ status: 0, data: [] }),
    },
    {
      label: 'network reset',
      handler: () => { throw new Error('socket hang up'); },
    },
    {
      label: 'timeout',
      handler: () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
  ];

  for (const { label, handler } of cases) {
    const { client } = createClient(handler);
    const error = await client.createStory({
      workspaceId: '1',
      fields: { name: 'N', description: 'secret description' },
    }).catch((caught) => caught);
    assert.equal(error.code, 'UNKNOWN', `${label} is not provably rejected`);
    assert.ok(!error.message.includes('secret description'), label);
    assert.ok(!error.message.includes(TOKEN), label);
    assert.ok(!error.message.includes('login'), label);
    assert.ok(!error.message.includes('socket hang up'), label);
    assert.ok(!error.message.includes('aborted'), label);
  }
});

test('a non tapd base url is refused at construction without echoing secrets', () => {
  for (const baseUrl of ['http://api.tapd.cn', 'https://evil.example.com', 'https://api.tapd.cn.evil.com']) {
    assert.throws(
      () => createTapdStories({
        tokenFile: 'C:/secrets/tapd.token',
        baseUrl,
        request: async () => response({ status: 1 }),
      }),
      (error) => error.code === 'INVALID_BASE_URL' && !error.message.includes(TOKEN),
    );
  }
});

test('getStory normalizes the story and splits children ids as strings', async () => {
  const { client, calls } = createClient(() => response({
    status: 1,
    info: 'success',
    data: [storyItem()],
  }));
  const story = await client.getStory({ workspaceId: '59180547', id: '1159180547001000001' });
  assert.deepEqual(story, {
    id: '1159180547001000001',
    workspaceId: '59180547',
    name: '总单',
    parentId: '0',
    childrenIds: ['1159180547001000002', '1159180547001000003'],
    ancestorId: '1159180547001000001',
    level: '0',
    workitemTypeId: '1159180547001000025',
    templatedId: '1159180547001000039',
    iterationId: '1159180547001000128',
    description: '<p>正文</p>',
  });
  assert.equal(typeof story.id, 'string');

  const { url, init } = calls[0];
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  const params = new URL(url).searchParams;
  assert.equal(params.get('workspace_id'), '59180547');
  assert.equal(params.get('id'), '1159180547001000001');
  assert.ok(url.startsWith(`${BASE_URL}/stories?`));
  assert.ok(!url.includes(TOKEN), 'the token stays in the Authorization header');
});

test('getStory maps empty data, read failures and missing tokens to fixed codes', async () => {
  const missing = createClient(() => response({ status: 1, data: [] }));
  const notFound = await missing.client.getStory({ workspaceId: '1', id: '2' }).catch((error) => error);
  assert.equal(notFound.code, 'NOT_FOUND');

  for (const handler of [
    () => response('<html>login</html>'),
    () => response({ status: 0, info: 'denied', data: [] }),
    () => response({ status: 1, data: [] }, 500),
    () => { throw new Error('socket hang up'); },
  ]) {
    const { client } = createClient(handler);
    const error = await client.getStory({ workspaceId: '1', id: '2' }).catch((caught) => caught);
    assert.equal(error.code, 'READ_FAILED');
    assert.ok(!error.message.includes('login'));
    assert.ok(!error.message.includes('denied'));
  }

  const { client, calls } = createClient(
    () => response({ status: 1, data: [] }),
    { readFile: () => '' },
  );
  const unsent = await client.getStory({ workspaceId: '1', id: '2' }).catch((error) => error);
  assert.equal(unsent.code, 'UNSENT');
  assert.deepEqual(calls, []);
});

test('listChildren merges pages until an empty page and reports completeness', async () => {
  const { client, calls } = createClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 1) {
      return response({
        status: 1,
        data: Array.from(
          { length: 200 },
          (_, index) => listItem(String(1159180547001000000n + BigInt(index))),
        ),
      });
    }
    return response({ status: 1, data: [] });
  });
  const result = await client.listChildren({ workspaceId: '59180547', parentId: 'P1' });
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 200);
  assert.equal(result.items[0].parentId, 'P1');
  assert.equal(calls.length, 2);

  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('workspace_id'), '59180547');
  assert.equal(params.get('parent_id'), 'P1');
  assert.equal(params.get('page'), '1');
  assert.equal(params.get('limit'), '200');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('listChildren returns what it has and complete:false when a later page fails', async () => {
  const { client } = createClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return page === 1
      ? response({ status: 1, data: [listItem('1')] })
      : response({ status: 0, info: 'denied', data: [] }, 500);
  });
  const result = await client.listChildren({ workspaceId: '59180547', parentId: 'P1' });
  assert.equal(result.items.length, 1);
  assert.equal(result.complete, false);
});

test('listChildren stops at the page cap with complete:false', async () => {
  const { client, calls } = createClient(() => response({ status: 1, data: [listItem('1')] }));
  const result = await client.listChildren({ workspaceId: '59180547', parentId: 'P1' });
  assert.equal(result.complete, false);
  assert.equal(calls.length, 100);
});

test('listChildren refuses to search without a token', async () => {
  const { client, calls } = createClient(
    () => response({ status: 1, data: [] }),
    { readFile: () => '  \n' },
  );
  const error = await client.listChildren({ workspaceId: '1', parentId: 'P1' })
    .catch((caught) => caught);
  assert.equal(error.code, 'UNSENT');
  assert.deepEqual(calls, []);
});

test('findParents keeps only exact names with parent_id 0 and the document id in the body', async () => {
  const name = '勋章挑战系统';
  const { client, calls } = createClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page !== 1) return response({ status: 1, data: [] });
    return response({
      status: 1,
      data: [
        storyItem({
          id: 'P1',
          name,
          parent_id: '0',
          description: '<p>见 <a href="https://example.feishu.cn/docx/docx_abc">docx_abc</a></p>',
        }),
        storyItem({ id: 'C1', name, parent_id: 'P1', description: 'docx_abc' }),
        storyItem({ id: 'P2', name, parent_id: '0', description: '标题相同但正文没有文档 id' }),
        storyItem({ id: 'P3', name, parent_id: '0', description: 'docx_abc2 只是前缀' }),
        storyItem({ id: 'P4', name: `${name}（旧）`, parent_id: '0', description: 'docx_abc' }),
        storyItem({ id: 'P5', name, parent_id: '0', description: 'docx_abc' }),
      ],
    });
  });
  const result = await client.findParents({
    workspaceId: '59180547',
    name,
    documentId: 'docx_abc',
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((story) => story.id), ['P1', 'P5']);

  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('workspace_id'), '59180547');
  assert.equal(params.get('name'), name);
  assert.equal(params.get('page'), '1');
  assert.equal(params.get('limit'), '200');
});

test('findParents reports incomplete when the search cannot be finished', async () => {
  const { client } = createClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return page === 1
      ? response({
        status: 1,
        data: [storyItem({ id: 'P1', name: '总单', parent_id: '0', description: 'docx_abc' })],
      })
      : response('<html>login</html>');
  });
  const result = await client.findParents({
    workspaceId: '59180547',
    name: '总单',
    documentId: 'docx_abc',
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.items.map((story) => story.id), ['P1']);
});

test('findParents searches with the cleaned title so long raw titles reconcile', async () => {
  const rawTitle = `标\n题${'字'.repeat(120)}`;
  const fields = buildParentFields({
    request: parentRequest(),
    target: { ...target, parent: { title: rawTitle } },
    marker: MARKER,
  });
  assert.equal(fields.name.length, 100);
  const { client, calls } = createClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return response({
      status: 1,
      data: page === 1
        ? [storyItem({
          id: 'P1',
          name: fields.name,
          parent_id: '0',
          description: fields.description,
        })]
        : [],
    });
  });
  const result = await client.findParents({
    workspaceId: '59180547',
    name: rawTitle,
    documentId: 'docx_abc',
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((story) => story.id), ['P1']);
  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('name'), fields.name);
  assert.equal(params.get('name').length, 100);
});

test('findByMarker matches only the exact token for the requested parent', async () => {
  const marker = 'req-r1-M01';
  const { client, calls } = createClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page !== 1) return response({ status: 1, data: [] });
    return response({
      status: 1,
      data: [
        listItem('C1', { id: 'C1', description: `<p>【追踪标识】${marker}</p>` }),
        listItem('C2', { id: 'C2', description: `【追踪标识】${marker}x` }),
        listItem('C3', { id: 'C3', description: `【追踪标识】x${marker}` }),
        listItem('C4', { id: 'C4', parent_id: 'P2', description: `【追踪标识】${marker}` }),
        listItem('C5', { id: 'C5', description: `【追踪标识】${marker} ` }),
      ],
    });
  });
  const result = await client.findByMarker({ workspaceId: '59180547', parentId: 'P1', marker });
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((story) => story.id), ['C1', 'C5']);

  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('workspace_id'), '59180547');
  assert.equal(params.get('parent_id'), 'P1');
  assert.equal(params.get('page'), '1');
  assert.equal(params.get('limit'), '200');
});

test('findByMarker reports incomplete pages as complete:false', async () => {
  const { client } = createClient((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return page === 1
      ? response({ status: 1, data: [listItem('C1', { description: '【追踪标识】req-r1-M01' })] })
      : response({ status: 0, info: 'denied', data: [] });
  });
  const result = await client.findByMarker({
    workspaceId: '59180547',
    parentId: 'P1',
    marker: 'req-r1-M01',
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.items.map((story) => story.id), ['C1']);
});

test('findByMarker rejects an invalid marker before any request', async () => {
  for (const marker of ['bad marker', '', 'a'.repeat(65), '中文']) {
    const { client, calls } = createClient(() => response({ status: 1, data: [] }));
    const error = await client.findByMarker({ workspaceId: '1', parentId: 'P1', marker })
      .catch((caught) => caught);
    assert.equal(error.code, 'INVALID_MARKER');
    assert.deepEqual(calls, []);
  }
});

test('template builders refuse missing ids as INVALID_ARGUMENT', () => {
  const parent = parentRequest();
  const child = childRequest();
  const parentCases = [
    {
      label: 'parent workspaceId',
      run: () => buildParentFields({ request: parent, target: { ...target, workspaceId: undefined }, marker: MARKER }),
    },
    {
      label: 'parent parentTypeId',
      run: () => buildParentFields({ request: parent, target: { ...target, parentTypeId: '' }, marker: MARKER }),
    },
    {
      label: 'parent templateId',
      run: () => buildParentFields({ request: parent, target: { ...target, templateId: undefined }, marker: MARKER }),
    },
    {
      label: 'parent documentId',
      run: () => buildParentFields({
        request: { ...parent, snapshot: { ...parent.snapshot, documentId: '' } },
        target,
        marker: MARKER,
      }),
    },
  ];
  const childCases = [
    {
      label: 'child workspaceId',
      run: () => buildChildFields({ story: flatStory(), request: child, target: { ...target, workspaceId: undefined }, parentId: 'P1', dependencyIds: { M02: '1' }, marker: MARKER }),
    },
    {
      label: 'child childTypeId',
      run: () => buildChildFields({ story: flatStory(), request: child, target: { ...target, childTypeId: '' }, parentId: 'P1', dependencyIds: { M02: '1' }, marker: MARKER }),
    },
    {
      label: 'child templateId',
      run: () => buildChildFields({ story: flatStory(), request: child, target: { ...target, templateId: undefined }, parentId: 'P1', dependencyIds: { M02: '1' }, marker: MARKER }),
    },
    {
      label: 'child parentId',
      run: () => buildChildFields({ story: flatStory(), request: child, target, parentId: '', dependencyIds: { M02: '1' }, marker: MARKER }),
    },
  ];
  for (const { label, run } of [...parentCases, ...childCases]) {
    assert.throws(
      run,
      (error) => error.code === 'INVALID_ARGUMENT' && !error.message.includes('undefined'),
      label,
    );
  }
});

test('adapter entry points refuse missing ids before any request', async () => {
  const cases = [
    { label: 'getStory workspaceId', run: (client) => client.getStory({ id: '1' }) },
    { label: 'getStory id', run: (client) => client.getStory({ workspaceId: '1' }) },
    { label: 'listChildren workspaceId', run: (client) => client.listChildren({ parentId: 'P1' }) },
    { label: 'listChildren parentId', run: (client) => client.listChildren({ workspaceId: '1' }) },
    {
      label: 'findParents workspaceId',
      run: (client) => client.findParents({ name: '总单', documentId: 'docx_abc' }),
    },
    {
      label: 'findParents name',
      run: (client) => client.findParents({ workspaceId: '1', name: '', documentId: 'docx_abc' }),
    },
    {
      label: 'findParents cleaned name',
      run: (client) => client.findParents({ workspaceId: '1', name: '\n\u0001', documentId: 'docx_abc' }),
    },
    {
      label: 'findParents documentId',
      run: (client) => client.findParents({ workspaceId: '1', name: '总单' }),
    },
    {
      label: 'findByMarker workspaceId',
      run: (client) => client.findByMarker({ parentId: 'P1', marker: MARKER }),
    },
    {
      label: 'findByMarker parentId',
      run: (client) => client.findByMarker({ workspaceId: '1', marker: MARKER }),
    },
    {
      label: 'createStory workspaceId',
      run: (client) => client.createStory({ fields: { name: 'N' } }),
    },
  ];
  for (const { label, run } of cases) {
    const { client, calls } = createClient(() => response({ status: 1, data: [] }));
    const error = await run(client).catch((caught) => caught);
    assert.equal(error.code, 'INVALID_ARGUMENT', label);
    assert.deepEqual(calls, [], label);
  }
});
