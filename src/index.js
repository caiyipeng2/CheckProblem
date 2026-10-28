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
import { extractPlainText, hasTrigger, classifyConfirmation, isUnseen } from './trigger.js';
import { markSeen } from './state.js';
import { buildPrompt } from './analyze.js';
import { CONFIRM_PROMPT, TIMEOUT_NOTICE, CANCELLED_NOTICE, BUSY_NOTICE, clipForReply } from './reply.js';

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

export function createEngine({ config, lark, syncRepo, runAnalysis, state, clock, log, saveState }) {
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

  async function runJob(msg) {
    const job = state.job;
    const triggerMessageId = job.triggerMessageId;
    const confirmer = await confirmerFor(msg);

    job.status = 'running';
    job.confirmer = confirmer;
    saveState(state);
    log?.info?.(`confirmed by ${confirmer}, question=${job.question}`);

    try {
      const { commit } = await syncRepo();
      const prompt = buildPrompt({ question: job.question, context: job.context });
      const { text } = await runAnalysis(prompt);
      const { text: body, truncated, full } = clipForReply({
        analysis: text,
        commit,
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
      log?.info?.(`analysis for ${triggerMessageId} delivered at ${commit}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.error?.(`analysis failed for ${triggerMessageId}: ${message}`);
      await lark.reply(triggerMessageId, `分析失败：${message.slice(0, 200)}`);
    } finally {
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
          const { triggerMessageId } = state.job;
          log?.warn?.(`recovering interrupted analysis of ${triggerMessageId}`);
          state.job = null;
          saveState(state);
          await notice(triggerMessageId, INTERRUPTED_NOTICE);
        }
        firstTick = false;
      }

      if (state.job?.status === 'awaiting' && now > state.job.expiresAt) {
        const { triggerMessageId } = state.job;
        log?.info?.(`confirmation for ${triggerMessageId} timed out`);
        state.job = null;
        saveState(state);
        await notice(triggerMessageId, TIMEOUT_NOTICE);
      }

      const messages = await lark.listMessages(config.chatId, { pageSize: PAGE_SIZE });
      const batch = Array.isArray(messages) ? messages : [];
      const unseen = batch.filter((m) => isUnseen(state.lastSeen, m));

      if (state.job?.status === 'awaiting') {
        let busyNotified = false;
        for (const message of unseen) {
          const kind = classifyConfirmation(extractPlainText(message).trim());
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
            senderId(message) !== config.selfOpenId &&
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
        if (senderId(message) === config.selfOpenId) continue;
        if (!hasTrigger(message, config.triggerKeyword)) continue;

        const index = batch.indexOf(message);
        const context = batch
          .slice(Math.max(0, index - config.contextMessages), index)
          .map(contextLine);
        const question = extractPlainText(message).trim();
        const prompt = await lark.reply(message.message_id, CONFIRM_PROMPT);

        state.job = {
          status: 'awaiting',
          triggerMessageId: message.message_id,
          question,
          context,
          promptMessageId: prompt?.messageId ?? '',
          expiresAt: clock() + config.confirmTimeoutSec * 1000,
          confirmer: null,
        };
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

  return { tick };
}
