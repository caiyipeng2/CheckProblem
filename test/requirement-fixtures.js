// Shared fixtures for the planning-document decomposition tests. Overrides are
// shallow so later tasks can replace whole arrays/objects without the factory
// silently merging into the sample data.

export function makeSnapshot(overrides = {}) {
  return {
    documentId: 'docx_abc',
    url: 'https://example.feishu.cn/docx/docx_abc',
    title: '勋章挑战系统',
    revision: 'rev-1',
    fingerprint: 'sha256:doc-1',
    blocks: [
      {
        id: 'b_m01',
        heading: '大厅入口',
        kind: 'text',
        text: '活动期间，大厅显示勋章挑战入口，开启前显示倒计时。',
      },
      {
        id: 'b_m02',
        heading: '活动周期',
        kind: 'text',
        text: '挑战活动持续 14 天，结束后关闭入口。',
      },
    ],
    resources: [
      {
        id: 'r_img',
        kind: 'image',
        sourceBlockId: 'b_m01',
        status: 'parsed',
        fingerprint: 'sha256:img-1',
        text: '大厅入口示意图',
        reason: null,
      },
      {
        id: 'r_video',
        kind: 'video',
        sourceBlockId: 'b_m02',
        status: 'pending',
        fingerprint: 'sha256:video-1',
        text: null,
        reason: null,
      },
    ],
    comments: [
      { id: 'c_1', sourceBlockId: 'b_m01', text: '入口倒计时需要显示剩余次数。' },
    ],
    commentsComplete: true,
    ...overrides,
  };
}

export function makeDraft(overrides = {}) {
  return {
    version: 1,
    facts: [
      {
        id: 'F1',
        sourceIds: ['b_m01'],
        text: '活动期间，大厅显示勋章挑战入口。',
        kind: 'source',
      },
      {
        id: 'F2',
        sourceIds: ['b_m02'],
        text: '挑战活动持续 14 天，结束后关闭入口。',
        kind: 'source',
      },
    ],
    stories: [
      {
        key: 'M01',
        title: '系统开放与大厅入口',
        rules: [
          {
            text: '活动期间显示大厅入口；开启前显示倒计时，开启后可进入活动大厅。',
            factIds: ['F1', 'F2'],
          },
        ],
        acceptance: [
          {
            text: '开启前可见倒计时；开启后可从大厅进入活动。',
            factIds: ['F1', 'F2'],
          },
        ],
        sourceIds: ['b_m01', 'b_m02', 'r_img', 'c_1'],
        factIds: ['F1', 'F2'],
        dependencies: [],
        issueIds: [],
        owner: null,
        disposition: 'proposed',
      },
    ],
    issues: [],
    exclusions: [],
    decisions: [],
    resourceDecisions: [],
    ...overrides,
  };
}

export function makeRequest(overrides = {}) {
  return {
    id: 'req_1',
    chatId: 'oc_test',
    triggerMessageId: 'om_trigger',
    cardMessageIds: ['om_card'],
    initiatorId: 'ou_initiator',
    reviewerIds: ['ou_reviewer'],
    projectId: 'weapon',
    status: 'draft',
    snapshot: makeSnapshot(),
    draft: makeDraft(),
    parentStoryId: null,
    submissions: [],
    viewByActor: {},
    ...overrides,
  };
}
