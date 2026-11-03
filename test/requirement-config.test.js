import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { normalizeRequirements, requirementTargets } from '../src/requirement-config.js';

const projects = [
  { id: 'weapon', name: '武器店' },
  { id: 'gear', name: '齿轮' },
];
const tapd = {
  workspaces: {
    weapon: { workspaceId: '59180547' },
    gear: { workspaceId: '47943302' },
  },
};
const CHAT_ATTEMPT = {
  kind: 'chat',
  label: 'chat',
  baseUrl: 'https://api.example.com/v1',
  model: 'vision',
  apiKeyFile: 'C:/secrets/chat.key',
  apiKeyEnv: '',
  timeoutSec: 120,
};
const analyze = [
  CHAT_ATTEMPT,
  { label: 'codex-fast', command: 'codex', timeoutSec: 240 },
];
const ROOT = join('tmp', 'service-root');

const base = () => ({
  allowedSenders: ['ou_test'],
  reviewers: ['ou_reviewer'],
  documentHosts: ['Hellowd.Feishu.CN'],
  modelAttempt: 0,
  projects: {
    weapon: {
      parentTypeId: 'parent-type',
      childTypeId: 'child-type',
      templateId: 'template',
      owners: ['owner-a'],
      iterationIds: ['0', 'iteration-a'],
    },
  },
});
const options = (extra = {}) => ({ projects, tapd, analyze, root: ROOT, ...extra });

function messageOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  assert.fail('expected configuration to be rejected');
}

function withoutField(attempt, key) {
  const copy = { ...attempt };
  delete copy[key];
  return copy;
}

function assertFieldError(fn, field, forbidden = []) {
  const message = messageOf(fn);
  assert.match(message, /^config: requirements\./);
  assert.ok(message.includes(field), message);
  for (const value of forbidden) assert.equal(message.includes(value), false, message);
  return message;
}

test('a valid requirements block is normalized and derives its paths', () => {
  const result = normalizeRequirements(base(), options());
  assert.deepEqual(result.allowedSenders, ['ou_test']);
  assert.deepEqual(result.reviewers, ['ou_reviewer']);
  assert.deepEqual(result.documentHosts, ['hellowd.feishu.cn']);
  assert.equal(result.modelAttempt, 0);
  assert.equal(result.attempt, CHAT_ATTEMPT);
  assert.deepEqual(result.projects, {
    weapon: {
      parentTypeId: 'parent-type',
      childTypeId: 'child-type',
      templateId: 'template',
      owners: ['owner-a'],
      iterationIds: ['0', 'iteration-a'],
    },
  });
  assert.deepEqual(result.paths, {
    stateFile: join(ROOT, 'state', 'requirements.json'),
    assetsDir: join(ROOT, 'state', 'requirement-assets'),
  });
});

test('an absent requirements block leaves the feature completely off', () => {
  assert.equal(normalizeRequirements(undefined, options()), undefined);
});

test('the requirements block itself must be a plain object', () => {
  for (const raw of [null, [], 'on', 1]) {
    assert.equal(messageOf(() => normalizeRequirements(raw, options())),
      'config: requirements must be an object');
  }
});

test('allowedSenders is required and non-empty', () => {
  for (const allowedSenders of [undefined, [], [''], ['  '], ['ou_ok', 1], 'ou_test']) {
    const raw = base();
    raw.allowedSenders = allowedSenders;
    assertFieldError(() => normalizeRequirements(raw, options()), 'allowedSenders');
  }
});

test('reviewers default to an empty list and empty reviewers are valid', () => {
  const omitted = base();
  delete omitted.reviewers;
  assert.deepEqual(normalizeRequirements(omitted, options()).reviewers, []);

  const empty = base();
  empty.reviewers = [];
  assert.deepEqual(normalizeRequirements(empty, options()).reviewers, []);
});

test('reviewers are trimmed and de-duplicated', () => {
  const raw = base();
  raw.reviewers = [' ou_a ', 'ou_a', 'ou_b'];
  assert.deepEqual(normalizeRequirements(raw, options()).reviewers, ['ou_a', 'ou_b']);
});

test('reviewers reject malformed entries', () => {
  for (const reviewers of ['ou_a', [''], ['  '], [null], [42], null]) {
    const raw = base();
    raw.reviewers = reviewers;
    assertFieldError(() => normalizeRequirements(raw, options()), 'reviewers');
  }
});

test('documentHosts must be bare lowercaseable hostnames and are de-duplicated', () => {
  const raw = base();
  raw.documentHosts = [' Hellowd.Feishu.CN ', 'hellowd.feishu.cn', 'docs.example.com'];
  assert.deepEqual(
    normalizeRequirements(raw, options()).documentHosts,
    ['hellowd.feishu.cn', 'docs.example.com'],
  );
});

test('documentHosts reject non-allowlisted or malformed entries without echoing them', () => {
  for (const documentHosts of [
    undefined,
    [],
    [''],
    ['https://hellowd.feishu.cn'],
    ['hellowd.feishu.cn/docx'],
    ['hellowd.feishu.cn:443'],
    ['*.feishu.cn'],
    ['user@hellowd.feishu.cn'],
    ['hello world'],
    ['a..b'],
    ['-a.com'],
    ['a-.com'],
    ['a.com.'],
    ['hellowd.feishu.cn', 42],
  ]) {
    const raw = base();
    raw.documentHosts = documentHosts;
    assertFieldError(
      () => normalizeRequirements(raw, options()),
      'documentHosts',
      ['https://', 'user@', 'hello world'],
    );
  }
});

test('modelAttempt must be an integer index into the resolved attempts', () => {
  for (const modelAttempt of [undefined, 2, -1, 1.5, '0', null]) {
    const raw = base();
    raw.modelAttempt = modelAttempt;
    assertFieldError(() => normalizeRequirements(raw, options()), 'modelAttempt');
  }
});

test('modelAttempt rejects command-type attempts', () => {
  const raw = base();
  raw.modelAttempt = 1;
  assertFieldError(
    () => normalizeRequirements(raw, options()),
    'modelAttempt',
    ['codex', 'command'],
  );
});

test('modelAttempt must be an explicit file-only chat endpoint', () => {
  for (const attempt of [
    withoutField(CHAT_ATTEMPT, 'apiKeyEnv'),
    { ...CHAT_ATTEMPT, apiKeyEnv: null },
    withoutField(CHAT_ATTEMPT, 'kind'),
    { ...CHAT_ATTEMPT, kind: 'codex' },
    withoutField(CHAT_ATTEMPT, 'baseUrl'),
    { ...CHAT_ATTEMPT, baseUrl: '   ' },
    withoutField(CHAT_ATTEMPT, 'model'),
    { ...CHAT_ATTEMPT, model: '  ' },
  ]) {
    assertFieldError(
      () => normalizeRequirements(base(), options({ analyze: [attempt] })),
      'modelAttempt',
      ['api.example.com', 'vision', 'C:/secrets/chat.key', 'OPENAI_API_KEY', 'codex'],
    );
  }
});

test('modelAttempt requires an apiKeyFile and the empty apiKeyEnv form', () => {
  const missing = base();
  const missingKey = { ...withoutField(CHAT_ATTEMPT, 'apiKeyFile'), label: 'no-key' };
  assertFieldError(
    () => normalizeRequirements(missing, options({ analyze: [missingKey] })),
    'modelAttempt',
    ['chat.key', missingKey.label],
  );

  const wrongEnv = base();
  const envAttempt = { ...CHAT_ATTEMPT, apiKeyEnv: 'OPENAI_API_KEY' };
  assertFieldError(
    () => normalizeRequirements(wrongEnv, options({ analyze: [envAttempt] })),
    'modelAttempt',
    ['OPENAI_API_KEY', 'C:/secrets/chat.key'],
  );
});

test('analyze may be the resolved attempts array or its config object', () => {
  const attempt = { ...CHAT_ATTEMPT };
  const direct = normalizeRequirements(base(), options({ analyze: [attempt] }));
  assert.equal(direct.attempt, attempt);
  assert.equal(direct.modelAttempt, 0);

  const wrapped = normalizeRequirements(base(), options({ analyze: { attempts: [attempt] } }));
  assert.equal(wrapped.attempt, attempt);
  assert.equal(wrapped.modelAttempt, 0);
});

test('modelAttempt without an attempts list is rejected', () => {
  assertFieldError(
    () => normalizeRequirements(base(), options({ analyze: [] })),
    'modelAttempt',
  );
});

test('projects must be a non-empty object', () => {
  for (const value of [undefined, null, {}, []]) {
    const raw = base();
    raw.projects = value;
    assertFieldError(() => normalizeRequirements(raw, options()), 'projects');
  }
});

test('an unknown project is rejected', () => {
  const raw = base();
  raw.projects.nope = raw.projects.weapon;
  assertFieldError(
    () => normalizeRequirements(raw, options()),
    'projects.nope',
  );
});

test('a project without a TAPD workspace mapping is rejected', () => {
  const raw = base();
  raw.projects.gear = raw.projects.weapon;
  const message = assertFieldError(
    () => normalizeRequirements(raw, options({ tapd: { workspaces: { weapon: { workspaceId: '1' } } } })),
    'projects.gear',
  );
  assert.match(message, /TAPD workspace mapping/);

  assertFieldError(
    () => normalizeRequirements(base(), options({ tapd: undefined })),
    'projects.weapon',
  );
});

test('project entries require their IDs as non-empty strings', () => {
  for (const key of ['parentTypeId', 'childTypeId', 'templateId']) {
    const raw = base();
    raw.projects.weapon[key] = key === 'templateId' ? '  ' : 42;
    assertFieldError(
      () => normalizeRequirements(raw, options()),
      `projects.weapon.${key}`,
    );
  }
});

test('owners must be a non-empty array of non-empty strings', () => {
  for (const owners of [undefined, [], [''], ['  '], ['ok', 1], 'owner']) {
    const raw = base();
    raw.projects.weapon.owners = owners;
    assertFieldError(
      () => normalizeRequirements(raw, options()),
      'projects.weapon.owners',
    );
  }
});

test('iterationIds is an array of non-empty strings that may itself be empty', () => {
  const empty = base();
  empty.projects.weapon.iterationIds = [];
  assert.deepEqual(
    normalizeRequirements(empty, options()).projects.weapon.iterationIds,
    [],
  );

  for (const iterationIds of [undefined, ['0', ''], [0], '0']) {
    const raw = base();
    raw.projects.weapon.iterationIds = iterationIds;
    assertFieldError(
      () => normalizeRequirements(raw, options()),
      'projects.weapon.iterationIds',
    );
  }
});

test('project entries must be objects', () => {
  const raw = base();
  raw.projects.weapon = 'weapon';
  assertFieldError(() => normalizeRequirements(raw, options()), 'projects.weapon');
});

test('an existing parent story id is optional but must look like a TAPD id', () => {
  const withParent = normalizeRequirements(
    { ...base(), projects: { weapon: { ...base().projects.weapon, parentStoryId: '1159180547001004412' } } },
    { projects, tapd, analyze, root: ROOT },
  );
  assert.equal(withParent.projects.weapon.parentStoryId, '1159180547001004412');

  const without = normalizeRequirements(base(), { projects, tapd, analyze, root: ROOT });
  assert.equal(without.projects.weapon.parentStoryId, undefined, 'absent stays absent');

  for (const bad of ['', 'abc', '123', '1159180547001004412112345678901234567890123']) {
    assert.throws(
      () => normalizeRequirements(
        { ...base(), projects: { weapon: { ...base().projects.weapon, parentStoryId: bad } } },
        { projects, tapd, analyze, root: ROOT },
      ),
      /parentStoryId/,
      bad,
    );
  }
});

test('the submitter target carries the types and template the payload needs', () => {
  const normalized = normalizeRequirements(
    { ...base(), projects: { weapon: { ...base().projects.weapon, parentStoryId: '1159180547001004412' } } },
    { projects, tapd, analyze, root: ROOT },
  );
  const targets = requirementTargets({ tapd, requirements: normalized });

  assert.deepEqual(targets.weapon, {
    workspaceId: '59180547',
    parentTypeId: 'parent-type',
    childTypeId: 'child-type',
    templateId: 'template',
    parent: { mode: 'bind', storyId: '1159180547001004412' },
  });

  const withoutParent = requirementTargets({
    tapd,
    requirements: normalizeRequirements(base(), { projects, tapd, analyze, root: ROOT }),
  });
  assert.equal(withoutParent.weapon.parent, undefined, 'no configured parent, no bind entry');
  assert.equal(withoutParent.weapon.childTypeId, 'child-type');
});

test('the parent half of the target is independent and optional', () => {
  const withParent = {
    ...base(),
    projects: {
      weapon: {
        ...base().projects.weapon,
        parentOwner: 'parent-owner',
        parentIterationId: 'parent-iteration',
      },
    },
  };
  const normalized = normalizeRequirements(withParent, options());
  assert.equal(normalized.projects.weapon.parentOwner, 'parent-owner');
  assert.equal(normalized.projects.weapon.parentIterationId, 'parent-iteration');

  const targets = requirementTargets({ tapd, requirements: normalized });
  assert.deepEqual(targets.weapon.parent, { owner: 'parent-owner', iterationId: 'parent-iteration' },
    'a created parent gets its own owner and iteration, not the child defaults');
  assert.equal(targets.weapon.childTypeId, 'child-type', 'the rest of the target is unchanged');

  for (const bad of ['', '   ', 7]) {
    assert.throws(
      () => normalizeRequirements(
        { ...withParent, projects: { weapon: { ...withParent.projects.weapon, parentOwner: bad } } },
        options(),
      ),
      /parentOwner/,
      String(bad),
    );
  }
});

test('a configured title prefix reaches both the entry and the submitter target', () => {
  const raw = {
    ...base(),
    projects: {
      weapon: { ...base().projects.weapon, titlePrefix: '实验自测' },
    },
  };
  const normalized = normalizeRequirements(raw, options());
  assert.equal(normalized.projects.weapon.titlePrefix, '实验自测');

  const targets = requirementTargets({ tapd, requirements: normalized });
  assert.equal(targets.weapon.titlePrefix, '实验自测', 'the payload builder reads it from the target');
  assert.equal(targets.weapon.workspaceId, '59180547');

  for (const bad of ['', '   ', 7, null]) {
    assert.throws(
      () => normalizeRequirements(
        { ...raw, projects: { weapon: { ...raw.projects.weapon, titlePrefix: bad } } },
        options(),
      ),
      /titlePrefix/,
      String(bad),
    );
  }
});
