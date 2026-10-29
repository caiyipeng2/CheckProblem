import { randomUUID } from 'node:crypto';
import { buildBranchOptions, buildQueryCard } from './cards.js';

export function createCardRequests({ config, state, lark, listBranches, clock, saveState, log, runJob }) {
  const queue = [];
  const card = (job) => buildQueryCard({ job, projects: config.projects });
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

  async function finish(job, status) {
    if (!job.card) return;
    const closed = { ...job, status, note: '', branches: job.branch ? [job.branch] : [], branchPage: 0 };
    const pending = { messageId: job.promptMessageId, card: card(closed) };
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
      projectId: config.defaultProjectId ?? config.projects[0].id,
      branch: '', branches: [], note: '',
    };
    await loadBranches(job);
    const prompt = await lark.replyCard(triggerMessageId, card(job));
    if (!prompt?.messageId) throw new Error('飞书未返回卡片消息 ID');
    job.promptMessageId = prompt.messageId;
    job.expiresAt = clock() + config.confirmTimeoutSec * 1000;
    return job;
  }

  function enqueue(event) {
    const job = state.job;
    if (event?.type !== 'card.action.trigger' || !job?.card || job.status !== 'awaiting') return false;
    if (event.chat_id !== config.chatId || event.message_id !== job.promptMessageId) return false;
    if (typeof event.operator_id !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(event.operator_id)) return false;
    if (typeof event.event_id !== 'string' || !event.event_id || event.event_id.length > 200) return false;
    if (typeof event.action_value !== 'string' || event.action_value.length > 1000) return false;
    if (event.option !== undefined && (typeof event.option !== 'string' || event.option.length > 500)) return false;
    let action;
    try { action = JSON.parse(event.action_value); } catch { return false; }
    if (!action || action.requestId !== job.requestId || !Number.isSafeInteger(action.revision)) return false;
    const expectedTag = ['project', 'branch'].includes(action.action) ? 'select_static' : 'button';
    if (!['project', 'branch', 'start', 'cancel'].includes(action.action) || event.action_tag !== expectedTag) return false;
    if (queue.length >= 100) throw new Error('卡片事件队列已满，停止接收以避免丢失操作');
    queue.push({ action: action.action, requestId: action.requestId, revision: action.revision,
      option: event.option, operatorId: event.operator_id });
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

  async function processPending() {
    if (await cancelPending()) return;
    await retryTerminalUpdates();
    if (state.job?.cardNeedsUpdate) await publish(state.job);
    while (queue.length) {
      if (await cancelPending()) return;
      const event = queue.shift();
      const job = state.job;
      if (!job?.card || job.status !== 'awaiting' || job.requestId !== event.requestId) continue;
      if (clock() > job.expiresAt) continue;
      if (job.revision !== event.revision) {
        log?.warn?.('ignoring an action on an outdated card revision');
        continue;
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
