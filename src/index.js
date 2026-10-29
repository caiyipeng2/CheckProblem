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
import { CONFIRM_PROMPT, TIMEOUT_NOTICE, CANCELLED_NOTICE, BUSY_NOTICE, clipForReply } from './reply.js';
import { createCardRequests } from './card-requests.js';
import { clearImages, collectImages, imageDirFor, uniqueRefs } from './images.js';

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

export function createEngine({ config, lark, syncRepo, runAnalysis, state, clock, log, saveState, retrieve, listBranches }) {
  const cards = config.projects ? createCardRequests({
    config, state, lark, listBranches, clock, saveState, log, runJob,
  }) : null;
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
    const confirmer = await confirmerFor(msg);
    job.confirmer = confirmer;
    saveState(state);
    log?.info?.(`confirmed by ${confirmer}, question=${job.question}`);

    try {
      if (job.card) await cards.update(job);
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
      state.job = null;
      saveState(state);
    }
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
        firstTick = false;
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
          // A screenshot that answers the pending question is still useful after
          // the trigger, so it joins the job until the operator starts it.
          if (attachImages(state.job, message) > 0) {
            if (state.job.card) state.job.cardNeedsUpdate = true;
            saveState(state);
          }
          const kind = state.job.card ? null : classifyConfirmation(extractPlainText(message).trim());
          if (kind === 'confirm') {
            log?.info?.(`confirmation from ${senderId(message)} for ${state.job.triggerMessageId}`);
            await runJob(message);
            markSeen(state, message);
            saveState(state);
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

      for (const message of unseen) {
        if (isServiceMessage(message)) continue;
        if (!hasTrigger(message, config.triggerKeyword)) continue;

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

  return { tick, enqueueCardAction: (event) => cards?.enqueue(event) ?? false };
}
