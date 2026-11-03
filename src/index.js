// Poll-loop state machine: turns group messages into confirmation prompts and
// runs at most one analysis job at a time. Every side effect (Feishu, git,
// codex, disk) is injected, so the whole loop runs offline in tests.
//
// Two invariants shape `tick`:
// - at most one tick runs at a time: an analysis can take minutes while the
//   poll interval keeps firing;
// - the cursor only moves forward, and only over messages that were actually
//   examined, so unrelated chatter is not re-read forever.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPlainText, extractImageKeys, hasTrigger, classifyConfirmation, isUnseen } from './trigger.js';
import { markSeen } from './state.js';
import { buildPrompt } from './analyze.js';
import {
  CONFIRM_PROMPT, TIMEOUT_NOTICE, CANCELLED_NOTICE, BUSY_NOTICE, WORK_BUSY_NOTICE, clipForReply,
} from './reply.js';
import { createCardRequests } from './card-requests.js';
import { clearImages, collectImages, imageDirFor, uniqueRefs } from './images.js';
import { createWorkSlot } from './work-slot.js';

// Enough for a busy chat plus the context window. The brief's
// max(20, contextMessages + 5) was replaced by a fixed page: context never
// exceeds a handful of lines and a wider page keeps the cursor honest.
const PAGE_SIZE = 50;

// One group line must not dominate the prompt.
const CONTEXT_LINE_CHARS = 200;

const INTERRUPTED_NOTICE = '上次分析中断，请重新发起';

function senderId(msg) {
  return msg?.sender?.id ?? msg?.sender?.open_id ?? '';
}

// Context lines use the display name already carried by the message when the
// adapter provided one; resolving names per line would cost an API call per
// message on every trigger.
function contextLine(msg) {
  const name = msg?.sender?.name;
  const who = typeof name === 'string' && name.trim() !== '' ? name : senderId(msg);
  return `${who}: ${extractPlainText(msg).trim().slice(0, CONTEXT_LINE_CHARS)}`;
}

export function createEngine({
  config, lark, syncRepo, runAnalysis, state, clock, log, saveState, retrieve, listBranches,
  tapd = null, slot = null, requirements = null,
}) {
  // One heavy-work slot for the whole process: 故障排查 and 需求拆分 share it, so
  // the entry point creates it once and hands the very same object to both.
  const workSlot = slot ?? createWorkSlot({ log });
  // A card press accepted before the crash-recovery pass of this process has run
  // would flip the job to `running` and be mistaken for an interrupted one. The
  // cards stay idle on `start` until the pass below opens the gate.
  let startReady = false;
  const cards = config.projects ? createCardRequests({
    config, state, lark, listBranches, clock, saveState, log, runJob, tapd,
    slot: workSlot, canStart: () => startReady,
  }) : null;

  // Analyses started from the poll loop run in the background (one tick must not
  // block the group for minutes), so the engine keeps their promises for
  // whenIdle() — once mode and shutdown wait here.
  const runTasks = new Set();
  function trackRun(done) {
    const settled = Promise.resolve(done).then(() => true, (err) => {
      log?.error?.(`analysis job failed: ${err?.message ?? err}`);
      return false;
    });
    runTasks.add(settled);
    settled.then(() => runTasks.delete(settled));
    return settled;
  }
  const isServiceMessage = (message) => cards
    ? message?.sender?.sender_type === 'app'
    : senderId(message) === config.selfOpenId;

  // Screenshots are captured by reference only: the bytes stay on Feishu until
  // the operator starts the query, so a cancelled or expired card costs nothing.
  const imageRefsOf = (message) => (isServiceMessage(message) ? [] : extractImageKeys(message)
    .map((fileKey) => ({ messageId: message.message_id, fileKey })));

  function attachImages(job, message) {
    if (!job) return 0;
    const before = job.images?.length ?? 0;
    job.images = uniqueRefs([...(job.images ?? []), ...imageRefsOf(message)]);
    return job.images.length - before;
  }

  // A planning command belongs to 需求拆分 only. The coordinator consumes it when
  // it can act on it; when it cannot (no document, sender not allowed, feature
  // not configured) the message must still never open a 故障排查 card, so the
  // command prefix itself is checked before the group trigger rules run.
  const PLANNING_COMMAND = /^(拆分需求|修改拆分)/;
  // A command is often typed with a separator (`蔡龙：拆分需求`) or a politeness
  // word (`蔡龙 请拆分需求`). Those belong to the sentence, not to the command:
  // they are stripped before the prefix test, while a question such as
  // `请问拆分需求是什么` still fails the test after `请` is removed (`问…`).
  const LEADING_SEPARATORS = /^[\s:：,，、。.；;！!？?~～\-—…]+/u;
  const POLITE_PREFIX = /^(?:请|帮我|帮忙|麻烦)+/u;
  function planningCommand(message) {
    let text = extractPlainText(message).replace(/@_user_\d+/g, ' ').trim();
    const keyword = config.triggerKeyword;
    if (typeof keyword === 'string' && keyword !== '' && text.startsWith(keyword)) {
      text = text.slice(keyword.length).trim();
    }
    text = text.replace(LEADING_SEPARATORS, '');
    text = text.replace(POLITE_PREFIX, '');
    text = text.replace(LEADING_SEPARATORS, '');
    return PLANNING_COMMAND.test(text);
  }

  // Every unread message is offered to the requirement coordinator first: it is
  // the only owner of that workflow, and `true` means it consumed the message.
  async function requirementConsumed(message) {
    if (!requirements || typeof requirements.handleMessage !== 'function') return false;
    try {
      return (await requirements.handleMessage(message)) === true;
    } catch (err) {
      // A broken requirement step must not cost the bug flow its poll; the
      // planning-command guard below still keeps the command out of it.
      log?.error?.(`requirement message handling failed: ${err?.message ?? err}`);
      return false;
    }
  }
  let inFlight = false;
  let firstTick = true;
  // Boundary of the running tick, and whether one skipped tick has already
  // been reported for this overlap.
  let tickStartedAt = 0;
  let overlapWarned = false;

  // The adapter never throws here, but a broken lookup must not cost us the
  // analysis: fall back to the raw open_id.
  async function confirmerFor(msg) {
    const openId = senderId(msg);
    try {
      if (typeof lark.getSenderName !== 'function') return openId;
      const name = await lark.getSenderName(openId);
      return name || openId;
    } catch (err) {
      log?.warn?.(`confirmer lookup failed for ${openId}: ${err?.message ?? err}`);
      return openId;
    }
  }

  // A notice is advisory: a recalled trigger or a flaky API must never change
  // control flow, so callers clear and save the job before asking for it.
  async function notice(messageId, text) {
    try {
      await lark.reply(messageId, text);
    } catch (err) {
      log?.error?.(`cannot deliver notice to ${messageId}: ${err?.message ?? err}`);
    }
  }

  async function runJob(msg, repo) {
    const job = state.job;
    const triggerMessageId = job.triggerMessageId;
    const imagesDir = imageDirFor(config.paths.imagesDir, triggerMessageId);
    job.status = 'running';
    saveState(state);

    try {
      // Both cost a subprocess call, so they overlap. The card still has to be
      // visibly 查询中 before the query starts — a press that cannot be shown
      // must not launch a hidden one — but the confirmer name is only needed
      // for the reply at the end.
      let runningCardError = null;
      const runningCard = job.card
        ? cards.update(job).catch((err) => { runningCardError = err; })
        : null;
      const confirmer = await confirmerFor(msg);
      if (runningCard) await runningCard;
      if (runningCardError) throw runningCardError;
      log?.info?.('card shows 查询中');
      job.confirmer = confirmer;
      saveState(state);
      log?.info?.(`confirmed by ${confirmer}, question=${job.question}`);

      const { provenance } = await syncRepo(repo);
      job.provenance = provenance;
      // The clone moved, so the search runs after the sync. A failed search only
      // costs precision: the model still gets the question.
      let evidence = '';
      if (typeof retrieve === 'function') {
        try {
          const found = await retrieve(job.question, repo);
          evidence = found?.digest ?? '';
          log?.info?.(`search: ${found?.terms?.length ?? 0} terms, ${found?.files?.length ?? 0} files${found?.note ? ` (${found.note})` : ''}`);
        } catch (err) {
          log?.warn?.(`search failed: ${err?.message ?? err}`);
        }
      }

      const images = await collectImages({
        refs: job.images,
        dir: imagesDir,
        download: lark.downloadImage,
        log,
      });
      if (job.images?.length) log?.info?.(`screenshots: ${images.length}/${job.images.length} attached`);

      const analysisProvenance = repo ? `${repo.name} · ${provenance}` : provenance;
      const prompt = buildPrompt({
        question: job.question,
        context: job.context,
        evidence,
        provenance: analysisProvenance,
        imageCount: images.length,
      });
      const { text } = await runAnalysis(prompt, repo, { images });
      // The finished report is rendered from this text, so it has to be the
      // model's own answer, not the reply clipped to `maxReplyChars`.
      job.analysis = text;
      saveState(state);
      const { text: body, truncated, full } = clipForReply({
        analysis: text,
        provenance: analysisProvenance,
        confirmer,
        maxChars: config.maxReplyChars,
      });

      // The group answer is the product; the log file is an extra. Reply first,
      // and never let a failed archive turn a delivered answer into an error
      // reply after the fact.
      await lark.reply(triggerMessageId, body);
      if (truncated) {
        try {
          mkdirSync(config.paths.jobsDir, { recursive: true });
          writeFileSync(join(config.paths.jobsDir, `${triggerMessageId}.md`), full);
        } catch (err) {
          log?.error?.(`cannot archive full analysis: ${err?.message ?? err}`);
        }
      }
      log?.info?.(`analysis for ${triggerMessageId} delivered at ${provenance}`);
      await cards?.finish(job, 'completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.error?.(`analysis failed for ${triggerMessageId}: ${message}`);
      await cards?.finish(job, 'failed');
      await lark.reply(triggerMessageId, `分析失败：${message.slice(0, 200)}`);
    } finally {
      clearImages(imagesDir);
      // Only this job may clear the slot in the state file: a finished analysis
      // must never wipe a job that was created after it (the background run no
      // longer holds the poll loop, so that interleaving is now reachable).
      if (state.job === job) {
        state.job = null;
        saveState(state);
      }
    }
  }

  // The legacy (text-confirm) flow takes the very same slot as the card flow:
  // the reservation comes first, and only an accepted one lets the job leave
  // `awaiting`. A refusal keeps the confirmation pending and says why.
  function startLegacyJob(message) {
    const job = state.job;
    const owner = `bug:${job?.requestId ?? job?.triggerMessageId ?? 'legacy'}`;
    const reservation = workSlot.tryStart(owner, () => runJob(message));
    if (!reservation?.accepted) return false;
    job.status = 'running';
    saveState(state);
    trackRun(reservation.done);
    return true;
  }

  async function tick() {
    if (inFlight) {
      // A stalled child would otherwise stall the service silently: the timer
      // keeps firing, every tick returns instantly and nothing is written.
      // One line per overlap makes that visible without flooding the log, and
      // a legitimately running analysis is not a stall at all.
      if (!overlapWarned && state.job?.status !== 'running') {
        overlapWarned = true;
        log?.warn?.(`poll still running after ${Math.max(0, clock() - tickStartedAt)}ms, skipping this tick`);
      }
      return;
    }
    inFlight = true;
    tickStartedAt = clock();

    try {
      const now = clock();

      // A `running` job can only survive in the state file if the process died
      // mid-analysis: the result is unrecoverable, so say so once and move on.
      if (firstTick) {
        if (state.job?.status === 'running') {
          const job = state.job;
          const { triggerMessageId } = job;
          log?.warn?.(`recovering interrupted analysis of ${triggerMessageId}`);
          if (job.card && cards) await cards.finish(job, 'interrupted');
          else {
            state.job = null;
            saveState(state);
          }
          await notice(triggerMessageId, INTERRUPTED_NOTICE);
        }
        // The requirement ledger recovers once, before any card event or poll may
        // start new work for it. `flush` is idempotent and never waits for a
        // heavy operation, so it is safe to run on the first tick even when the
        // entry point already ran it before opening the event stream.
        if (requirements) {
          try {
            await requirements.flush?.();
          } catch (err) {
            log?.error?.(`requirement flush failed: ${err?.message ?? err}`);
          }
        }
        firstTick = false;
        // Only now may a card press start an analysis: the crash-recovery check
        // above has already run, so a live `running` job is never misread.
        startReady = true;
      }

      if (state.job?.status === 'awaiting' && now > state.job.expiresAt) {
        const job = state.job;
        const { triggerMessageId } = job;
        log?.info?.(`confirmation for ${triggerMessageId} timed out`);
        if (job.card && cards) await cards.finish(job, 'expired');
        else {
          state.job = null;
          saveState(state);
        }
        await notice(triggerMessageId, TIMEOUT_NOTICE);
      }

      await cards?.processPending();
      const messages = await lark.listMessages(config.chatId, { pageSize: PAGE_SIZE });
      const batch = Array.isArray(messages) ? messages : [];
      const unseen = batch.filter((m) => isUnseen(state.lastSeen, m));

      if (state.job?.status === 'awaiting') {
        let busyNotified = false;
        for (const message of unseen) {
          // The requirement workflow is offered every message before the bug
          // flow looks at it; a consumed message is simply seen.
          if (await requirementConsumed(message)) {
            markSeen(state, message);
            saveState(state);
            continue;
          }
          // A screenshot that answers the pending question is still useful after
          // the trigger, so it joins the job until the operator starts it.
          if (attachImages(state.job, message) > 0) {
            if (state.job.card) state.job.cardNeedsUpdate = true;
            saveState(state);
          }
          const kind = state.job.card ? null : classifyConfirmation(extractPlainText(message).trim());
          if (kind === 'confirm') {
            log?.info?.(`confirmation from ${senderId(message)} for ${state.job.triggerMessageId}`);
            // The analysis runs behind the work slot, not inside the tick: a
            // long query would otherwise freeze the poll and every review.
            const started = startLegacyJob(message);
            markSeen(state, message);
            saveState(state);
            if (!started) await notice(state.job?.triggerMessageId ?? message.message_id, WORK_BUSY_NOTICE);
            return;
          }
          if (kind === 'cancel') {
            const { triggerMessageId } = state.job;
            log?.info?.(`cancel from ${senderId(message)} for ${triggerMessageId}`);
            state.job = null;
            markSeen(state, message);
            saveState(state);
            await notice(triggerMessageId, CANCELLED_NOTICE);
            return;
          }
          // A second question must not vanish silently while one is pending, but
          // one notice per tick is enough; ordinary chatter stays ignored.
          if (
            !busyNotified &&
            !isServiceMessage(message) &&
            hasTrigger(message, config.triggerKeyword)
          ) {
            busyNotified = true;
            await notice(message.message_id, BUSY_NOTICE);
          }
          // Keep scanning so a 确认 later in the same batch is still honoured.
        }

        // Never start a second job while one is awaiting, but still advance the
        // cursor over the chatter we just read.
        if (unseen.length) {
          markSeen(state, unseen.at(-1));
          saveState(state);
        }
        return;
      }

      // A background analysis owns the group's single job: a new question must
      // be told to wait instead of silently replacing the running job (whose
      // `finally` would then wipe the replacement).
      const running = state.job?.status === 'running';
      let runningNotified = false;
      for (const message of unseen) {
        if (await requirementConsumed(message)) {
          markSeen(state, message);
          saveState(state);
          continue;
        }
        if (isServiceMessage(message)) continue;
        if (!hasTrigger(message, config.triggerKeyword)) continue;
        if (planningCommand(message)) {
          // 拆分需求/修改拆分 never belongs to the bug-query flow, even when the
          // coordinator could not act on it (no document, sender not allowed).
          log?.info?.(`planning command left to the requirement flow: ${message.message_id}`);
          markSeen(state, message);
          saveState(state);
          continue;
        }
        if (running) {
          if (!runningNotified) {
            runningNotified = true;
            await notice(message.message_id, WORK_BUSY_NOTICE);
          }
          markSeen(state, message);
          saveState(state);
          continue;
        }

        const index = batch.indexOf(message);
        const contextMessages = batch.slice(Math.max(0, index - config.contextMessages), index);
        const context = contextMessages.map(contextLine);
        const images = uniqueRefs([...contextMessages, message].flatMap(imageRefsOf));
        const question = extractPlainText(message).trim();
        if (cards) {
          state.job = await cards.create({ triggerMessageId: message.message_id, question, context, images });
        } else {
          const prompt = await lark.reply(message.message_id, CONFIRM_PROMPT);
          state.job = {
            status: 'awaiting',
            triggerMessageId: message.message_id,
            question,
            context,
            images,
            promptMessageId: prompt?.messageId ?? '',
            expiresAt: clock() + config.confirmTimeoutSec * 1000,
            confirmer: null,
          };
        }
        markSeen(state, message);
        saveState(state);
        log?.info?.(`awaiting confirmation for ${message.message_id}`);
        return;
      }

      if (unseen.length) {
        markSeen(state, unseen.at(-1));
        saveState(state);
      }
    } finally {
      inFlight = false;
      overlapWarned = false;
    }
  }

  // Settles when no heavy operation, requirement step or card-queue drain is
  // pending. The entry point uses it for once mode and the bounded shutdown.
  async function whenIdle() {
    let guard = 0;
    while (guard < 1000) {
      guard += 1;
      await Promise.allSettled([...runTasks]);
      await requirements?.whenIdle?.();
      await cards?.whenIdle?.();
      if (runTasks.size === 0 && !workSlot.isBusy()) return;
      await workSlot.whenIdle();
    }
    throw new Error('engine work did not settle');
  }

  // Legacy cards carry no workflow key, so only an explicit namespace routes a
  // press to the requirement flow. A namespace this build does not know is
  // refused outright: trying the old cards afterwards could execute a press
  // the new flow already rejected.
  function workflowOf(event) {
    let value = event?.action_value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return typeof value.workflow === 'string' ? value.workflow : null;
  }

  return {
    tick,
    whenIdle,
    enqueueCardAction: (event) => {
      const workflow = workflowOf(event);
      if (workflow !== null) {
        if (workflow !== 'requirements') return false;
        return requirements ? requirements.enqueue(event) === true : false;
      }
      return cards?.enqueue(event) ?? false;
    },
  };
}
