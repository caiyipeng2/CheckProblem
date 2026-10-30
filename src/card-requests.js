import { randomUUID } from 'node:crypto';
import { buildBranchOptions, buildQueryCard } from './cards.js';
import { matchProject } from './projects.js';
import { buildBugPayload } from './tapd.js';

const REPORT_LIMIT = 20;

export function createCardRequests({ config, state, lark, listBranches, clock, saveState, log, runJob, tapd = null }) {
  const queue = [];
  let draining = null;
  // A press is worth acting on the moment it arrives, so an accepted event
  // drains the queue from the event callback instead of waiting for the poll.
  const schedule = (action) => queueMicrotask(() => {
    // The receive time of this line, against the 查询中 line, is the whole
    // operator-visible latency: transport, queue and the card write.
    log?.info?.(`card action ${action} received`);
    processPending().catch((err) => log?.error?.(`card action failed: ${err?.message ?? err}`));
  });
  const entryFor = (projectId) => (tapd ? config.tapd?.workspaces?.[projectId] ?? null : null);
  const card = (job) => buildQueryCard({ job, projects: config.projects, tapd: entryFor(job.projectId) });
  const update = (job) => lark.updateCard(job.promptMessageId, card(job));

  async function publish(job) {
    job.cardNeedsUpdate = true;
    saveState(state);
    await update(job);
    delete job.cardNeedsUpdate;
    saveState(state);
  }

  async function retryTerminalUpdates() {
    for (const pending of [...(state.cardUpdates ?? [])]) {
      try {
        await lark.updateCard(pending.messageId, pending.card);
        state.cardUpdates = state.cardUpdates.filter((item) => item !== pending);
        saveState(state);
      } catch {
        log?.error?.('terminal card update failed; retained for retry');
      }
    }
  }

  function rememberReport(closed) {
    const previous = (Array.isArray(state.reports) ? state.reports : [])
      .filter((item) => item.requestId !== closed.requestId);
    const snapshot = { ...closed, finishedAt: clock() };
    state.reports = [...previous, snapshot].slice(-REPORT_LIMIT);
    return snapshot;
  }

  async function finish(job, status) {
    if (!job.card) return;
    let closed = { ...job, status, note: '', branches: job.branch ? [job.branch] : [], branchPage: 0 };
    // A completed job becomes the stored report object itself, so the card we
    // are about to PATCH and the report a later press finds are the same thing.
    if (status === 'completed') closed = rememberReport(closed);
    const pending = { messageId: closed.promptMessageId, card: card(closed) };
    state.cardUpdates = (state.cardUpdates ?? []).filter((item) => item.messageId !== pending.messageId);
    state.cardUpdates.push(pending);
    if (state.job?.requestId === job.requestId) state.job = null;
    saveState(state);
    await retryTerminalUpdates();
  }

  async function loadBranches(job) {
    job.branchPage = 0;
    job.branch = '';
    job.branches = [];
    job.note = '';
    const project = config.projects.find((p) => p.id === job.projectId);
    try {
      const branches = await listBranches(project);
      if (!Array.isArray(branches) || branches.length === 0) throw new Error('没有可选分支');
      job.branches = branches;
      job.branch = branches.includes(project.branch) ? project.branch : branches[0];
    } catch (err) {
      job.note = '远端分支获取失败，请重新选择项目重试，或取消。';
      log?.warn?.(`branch listing failed for ${project.id}: ${err.message}`);
    }
  }

  async function create({ triggerMessageId, question, context, images = [] }) {
    const job = {
      card: true, requestId: randomUUID(), revision: 0, status: 'awaiting',
      triggerMessageId, question, context, images, confirmer: null, timeoutSec: config.confirmTimeoutSec,
      projectId: matchProject(config.projects, question) ?? config.defaultProjectId ?? config.projects[0].id,
      branch: '', branches: [], note: '',
    };
    await loadBranches(job);
    const prompt = await lark.replyCard(triggerMessageId, card(job));
    if (!prompt?.messageId) throw new Error('飞书未返回卡片消息 ID');
    job.promptMessageId = prompt.messageId;
    job.expiresAt = clock() + config.confirmTimeoutSec * 1000;
    return job;
  }

  // Everything that must hold for any card action, regardless of which job it
  // belongs to: same chat, a plausible operator, and a parseable action value.
  function readEvent(event) {
    if (event?.type !== 'card.action.trigger') return null;
    if (event.chat_id !== config.chatId) return null;
    if (typeof event.operator_id !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(event.operator_id)) return null;
    if (typeof event.event_id !== 'string' || !event.event_id || event.event_id.length > 200) return null;
    if (typeof event.action_value !== 'string' || event.action_value.length > 1000) return null;
    if (event.option !== undefined && (typeof event.option !== 'string' || event.option.length > 500)) return null;
    try {
      const action = JSON.parse(event.action_value);
      if (!action || typeof action.requestId !== 'string' || !Number.isSafeInteger(action.revision)) return null;
      return { action, event };
    } catch {
      return null;
    }
  }

  function enqueue(event) {
    const read = readEvent(event);
    if (!read) return false;
    const { action, event: cardEvent } = read;
    if (queue.length >= 100) throw new Error('卡片事件队列已满，停止接收以避免丢失操作');

    if (action.action === 'tapd') {
      if (!tapd || cardEvent.action_tag !== 'button') return false;
      const report = (state.reports ?? []).find((item) => item.requestId === action.requestId);
      if (!report || report.status !== 'completed') return false;
      if (cardEvent.message_id !== report.promptMessageId) return false;
      // The revision is the idempotency key: the card we are looking at is the
      // one that rendered this number, and a press consumes it.
      if (action.revision !== report.revision) return false;
      // A `submitting` report is deliberately let through: submitTapd refuses
      // it by status, so the queued press cannot file a second ticket. Only a
      // finished report is refused here, because its card no longer has a button.
      if (report.tapd?.status === 'done') return false;
      queue.push({ action: 'tapd', requestId: action.requestId, revision: action.revision, operatorId: cardEvent.operator_id });
      schedule(action.action);
      return true;
    }

    const job = state.job;
    if (!job?.card || job.status !== 'awaiting') return false;
    if (cardEvent.message_id !== job.promptMessageId) return false;
    const expectedTag = ['project', 'branch'].includes(action.action) ? 'select_static' : 'button';
    if (!['project', 'branch', 'start', 'cancel'].includes(action.action) || cardEvent.action_tag !== expectedTag) return false;
    if (action.requestId !== job.requestId) return false;
    queue.push({ action: action.action, requestId: action.requestId, revision: action.revision,
      projectId: action.projectId, branch: action.branch,
      option: cardEvent.option, operatorId: cardEvent.operator_id });
    schedule(action.action);
    return true;
  }

  async function cancelPending() {
    const current = state.job;
    // Cancelling an older visible revision remains safe when its replacement cannot be published.
    if (current?.card && current.status === 'awaiting' && queue.some((event) =>
      event.action === 'cancel' && event.requestId === current.requestId
      && event.revision >= 0 && event.revision <= current.revision)) {
      queue.length = 0;
      await finish(current, 'cancelled');
      return true;
    }
    return false;
  }

  async function publishCard(report) {
    const pending = { messageId: report.promptMessageId, card: card(report) };
    state.cardUpdates = (state.cardUpdates ?? []).filter((item) => item.messageId !== pending.messageId);
    state.cardUpdates.push(pending);
    saveState(state);
    await retryTerminalUpdates();
  }

  async function submitTapd(event) {
    const report = (state.reports ?? []).find((item) => item.requestId === event.requestId);
    if (!report) return;
    const entry = entryFor(report.projectId);
    if (!entry) return;
    if (report.revision !== event.revision || report.tapd?.status === 'done' || report.tapd?.status === 'submitting') return;

    // Book the press before the network call: a second click on the old card
    // revision is now rejected, and a crash mid-request leaves `submitting`
    // rather than a silent second ticket.
    report.revision += 1;
    report.tapd = { status: 'submitting' };
    saveState(state);
    // Persist the disabled card through the same retry queue before the write:
    // if the process dies during the request, the card can still say the state
    // is unknown after the restart instead of silently offering the button.
    await publishCard(report);
    try {
      const { bugId, url } = await tapd.createBug(
        buildBugPayload({ report, entry, projects: config.projects }),
        { tokenFile: entry.tokenFile },
      );
      report.tapd = { status: 'done', bugId, url, at: clock() };
      log?.info?.(`tapd: ${report.triggerMessageId} -> bug ${bugId}`);
    } catch (err) {
      // Only the client's own pre-request failures carry `unsent`; anything
      // thrown during the request may have reached TAPD and keeps the honest
      // "outcome unknown" wording.
      report.tapd = {
        status: 'failed',
        unsent: err?.unsent === true,
        error: String(err?.message ?? err).slice(0, 200),
      };
      log?.warn?.(`tapd submit failed for ${report.triggerMessageId}: ${report.tapd.error}`);
    }
    saveState(state);
    await publishCard(report);
  }

  async function processPending() {
    // One consumer at a time: a press starts the drain from the event callback,
    // and the poll tick joins the same run instead of racing it.
    if (draining) return draining;
    draining = drain().finally(() => { draining = null; });
    return draining;
  }

  async function drain() {
    if (await cancelPending()) return;
    await retryTerminalUpdates();
    if (state.job?.cardNeedsUpdate) await publish(state.job);
    while (queue.length) {
      if (await cancelPending()) return;
      const event = queue.shift();
      if (event.action === 'tapd') {
        await submitTapd(event);
        continue;
      }
      const job = state.job;
      if (!job?.card || job.status !== 'awaiting' || job.requestId !== event.requestId) continue;
      if (clock() > job.expiresAt) continue;
      if (job.revision !== event.revision) {
        // The card on screen may not have refreshed yet, so its revision is
        // behind. A start that names the project and branch still shown is the
        // press the operator meant; anything else would reinterpret a control
        // that has since moved.
        const sameSelection = event.action === 'start'
          && event.projectId === job.projectId && event.branch === job.branch;
        if (!sameSelection) {
          log?.warn?.('ignoring an action on an outdated card revision');
          continue;
        }
      }
      if (event.action === 'project') {
        if (!config.projects.some((p) => p.id === event.option)) continue;
        const candidate = { ...job, projectId: event.option, revision: job.revision + 1 };
        await loadBranches(candidate);
        card(candidate);
        Object.assign(job, candidate);
        await publish(job);
      } else if (event.action === 'branch') {
        if (!buildBranchOptions(job).some((option) => option.value === event.option)) continue;
        const candidate = { ...job, revision: job.revision + 1 };
        if (event.option.startsWith(':page:')) candidate.branchPage = Number(event.option.slice(6));
        else candidate.branch = event.option;
        card(candidate);
        Object.assign(job, candidate);
        await publish(job);
      } else if (event.action === 'start') {
        const project = config.projects.find((p) => p.id === job.projectId);
        if (!project || !job.branch || !job.branches.includes(job.branch)) continue;
        await runJob({ sender: { id: event.operatorId } }, { ...project, branch: job.branch });
      }
    }
  }

  return { create, enqueue, processPending, update, finish };
}
