const plain = (content) => ({ tag: 'plain_text', content });
const text = (content) => ({ tag: 'div', text: plain(content) });
const column = (elements, weight = 1) => ({ tag: 'column', width: 'weighted', weight, elements });
const row = (columns) => ({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', columns });

const LABELS = {
  awaiting: '待确认', running: '查询中', completed: '查询完成',
  cancelled: '已取消', expired: '已超时', failed: '查询失败', interrupted: '查询中断',
};

export function buildBranchOptions(job) {
  const pages = [[]];
  let bytes = 0;
  for (const branch of job.branches) {
    const option = { text: plain(branch), value: branch };
    const size = Buffer.byteLength(JSON.stringify(option));
    if (pages.at(-1).length && (pages.at(-1).length >= 90 || bytes + size > 12000)) {
      pages.push([]);
      bytes = 0;
    }
    pages.at(-1).push(option);
    bytes += size;
  }
  const page = Math.min(Math.max(job.branchPage ?? 0, 0), pages.length - 1);
  const options = [...pages[page]];
  if (job.branch && !options.some((o) => o.value === job.branch)) {
    options.unshift({ text: plain(job.branch), value: job.branch });
  }
  if (page > 0) options.push({ text: plain(`上一页（${page}/${pages.length}）`), value: `:page:${page - 1}` });
  if (page < pages.length - 1) options.push({ text: plain(`下一页（${page + 2}/${pages.length}）`), value: `:page:${page + 1}` });
  return options;
}

export function buildQueryCard({ job, projects, tapd = null }) {
  const active = job.status === 'awaiting';
  const callback = (action, extra) => [{
    type: 'callback', value: { requestId: job.requestId, revision: job.revision, action, ...extra },
  }];
  const selectedProject = projects.find((p) => p.id === job.projectId);
  const projectSelect = {
    tag: 'select_static', name: 'project', width: 'fill', disabled: !active,
    initial_option: job.projectId, placeholder: plain('选择项目'),
    options: projects.map((p) => ({ text: plain(p.name), value: p.id })),
    behaviors: callback('project'),
  };
  const branchSelect = {
    tag: 'select_static', name: 'branch', width: 'fill',
    disabled: !active || !job.branches.length,
    placeholder: plain('选择远端分支'),
    options: buildBranchOptions(job),
    behaviors: callback('branch'),
    ...(job.branch ? { initial_option: job.branch } : {}),
  };
  const status = LABELS[job.status] ?? '不可用';
  const note = job.note || (active
    ? `选择变更会同步给所有成员。请等卡片刷新后再开始；${Math.ceil((job.timeoutSec ?? 600) / 60)} 分钟内有效。`
    : job.status === 'running' ? '正在获取所选分支最新远端代码，请勿重复提交。' : '此请求已关闭，请通过新消息发起下一次查询。');
  const submitted = job.tapd?.status === 'done' ? job.tapd : null;
  const showTapd = Boolean(tapd) && job.status === 'completed' && !submitted;
  const tapdRow = showTapd ? row([column([{
    tag: 'button',
    name: 'tapd',
    text: plain(job.tapd?.status === 'submitting'
      ? '提交中…'
      : job.tapd?.status === 'failed' ? '重试提交 TAPD 缺陷单' : '提交 TAPD 缺陷单'),
    type: 'default',
    width: 'fill',
    disabled: job.tapd?.status === 'submitting',
    behaviors: callback('tapd'),
  }])]) : null;
  // A press is booked before the request goes out, so `submitting` also covers
  // "the process died mid-request": the note tells the operator to look at TAPD
  // rather than trust the card. A `failed` note says the same thing for a
  // different reason: TAPD has no idempotency key, so a timeout or 5xx after
  // the write landed is indistinguishable from a total failure, and a blind
  // retry would file the one ticket nobody can delete. The retry button stays
  // live; the operator checks TAPD first, the card just says so. The one
  // exception is a failure raised before any request was sent (`unsent`):
  // there is nothing to check, so saying "outcome unknown" would send the
  // operator on a useless trip and only the safe-retry fact is true.
  const tapdNote = job.tapd?.status === 'failed'
    ? job.tapd.unsent === true
      ? text(`未提交：${String(job.tapd.error).slice(0, 200)}（没有向 TAPD 发出请求，可直接重试）`)
      : text(`TAPD 提单失败：${String(job.tapd.error).slice(0, 200)}\n提交结果可能未知：若上一次请求已发出，请先在 TAPD 确认没有重复单再重试。`)
    : job.tapd?.status === 'submitting'
      ? text('若服务已重启，请先在 TAPD 确认是否已建单，避免重复提交。')
      : null;
  const card = {
    schema: '2.0',
    config: { update_multi: true, enable_forward: false, width_mode: 'default', summary: { content: `蔡龙问题查询 · ${status}` } },
    header: {
      title: plain('蔡龙问题查询'), template: 'blue',
      subtitle: plain(status), icon: { tag: 'standard_icon', token: 'file-form_colorful' },
    },
    body: {
      direction: 'vertical', padding: '12px', vertical_spacing: '12px',
      elements: [
        row([column([
          row([column([text('项目')]), column([projectSelect], 4)]),
          row([column([text('分支')]), column([branchSelect], 4)]),
        ])]),
        { ...row([column([
          { tag: 'markdown', content: '**原问题**' },
          text(String(job.question).slice(0, 600)),
          ...(job.images?.length ? [text(`截图 ${job.images.length} 张（查询时一并分析）`)] : []),
        ])]), background_style: 'grey-50' },
        text(`${note}${job.provenance ? `\n${selectedProject?.name ?? ''} · ${job.provenance}` : ''}`),
        row([
          column([{
            tag: 'button', name: 'start', text: plain('开始查询'), type: 'primary_filled',
            // A card that has not refreshed yet still carries the selection it
            // shows, so the press is trustworthy even when its revision is old.
            width: 'fill', disabled: !active || !job.branch,
            behaviors: callback('start', { projectId: job.projectId, branch: job.branch }),
          }]),
          column([{
            tag: 'button', name: 'cancel', text: plain('取消'), type: 'default',
            width: 'fill', disabled: !active, behaviors: callback('cancel'),
          }]),
        ]),
        ...(tapdRow ? [tapdRow] : []),
        ...(submitted ? [{ tag: 'markdown', content: `已提单：[TAPD ${submitted.bugId}](${submitted.url})` }] : []),
        ...(tapdNote ? [tapdNote] : []),
      ],
    },
  };
  if (Buffer.byteLength(JSON.stringify(card)) > 30 * 1024) throw new Error('卡片内容超过 30 KiB');
  return card;
}
