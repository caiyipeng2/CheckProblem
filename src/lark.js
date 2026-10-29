// Feishu adapter. Every lark-cli invocation lives here so the rest of the
// service deals in plain data only.
//
// The `im +chat-messages-list` / `im +messages-reply` shortcuts statically
// require the `im:message.reactions:read` scope even with `--no-reactions`, and
// that scope cannot be granted in our tenant. The raw `lark-cli api` escape
// hatch uses scopes we already hold, so all message access goes through it.

const IDENTITY = ['--as', 'user', '--json'];
const BOT_IDENTITY = ['--as', 'bot', '--json'];

const MESSAGES_PATH = '/open-apis/im/v1/messages';

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class LarkError extends Error {
  constructor(message, { code = null, missingScopes = [] } = {}) {
    super(message);
    this.name = 'LarkError';
    this.code = code;
    this.missingScopes = missingScopes;
  }
}

// Ids come from the network and are interpolated into CLI arguments and the API
// path, so accept only the character set Feishu actually uses.
function requireSafeId(field, value) {
  if (typeof value === 'string' && SAFE_ID.test(value)) return value;
  throw new LarkError(`invalid ${field}: ${String(value).slice(0, 40)}`);
}

// A failed call still prints its failure envelope on stdout, so stdout is
// always the primary signal; stderr only matters when stdout is empty.
function parseEnvelope(stdout) {
  let env;
  try {
    env = JSON.parse(stdout);
  } catch {
    throw new LarkError(`lark-cli returned unparseable output: ${String(stdout).slice(0, 200)}`);
  }
  if (env?.ok !== true) {
    const err = env?.error ?? {};
    throw new LarkError(err.message ?? 'lark-cli call failed', {
      code: err.code ?? null,
      missingScopes: err.missing_scopes ?? [],
    });
  }
  return env.data ?? {};
}

export function createLark({ run, dryRun = false, log = null, botReplies = false }) {
  // Reads always execute, even under dryRun, so `--dry-run` still exercises
  // real polling against Feishu.
  //
  // Free-form bodies must not travel in argv: on Windows the CLI is an npm
  // `.cmd` shim, so the runner needs `shell: true`, and long Chinese bodies can
  // also exceed the command-line limit. Bodies go through stdin instead.
  //
  // No explicit timeout: the runner bounds every call with its own default, so
  // a hung lark-cli cannot leave the poll tick pending forever.
  const call = async (args, stdin, identity = IDENTITY) => {
    const opts = stdin === undefined ? {} : { stdin };
    const res = (await run('lark-cli', [...args, ...identity], opts)) ?? {};
    const stdout = typeof res.stdout === 'string' ? res.stdout : '';
    if (stdout.trim() === '') {
      // stderr may be undefined/empty; the exit code still tells the story.
      throw new LarkError(
        `lark-cli exited ${res.code ?? 'unknown'} with no output: ${String(res.stderr ?? '').slice(0, 300)}`,
      );
    }
    return parseEnvelope(stdout);
  };

  const textContent = (text) => JSON.stringify({ text });
  const cardContent = (card) => {
    let content;
    try {
      content = JSON.stringify(card);
    } catch {
      throw new LarkError('card must be JSON serializable');
    }
    if (typeof content !== 'string') throw new LarkError('card must be JSON serializable');
    if (Buffer.byteLength(content, 'utf8') > 30 * 1024) {
      throw new LarkError('card serialized content exceeds 30 KiB');
    }
    return content;
  };

  return {
    async replyCard(messageId, card) {
      const safeMessageId = requireSafeId('messageId', messageId);
      const content = cardContent(card);
      if (dryRun) {
        log?.info?.(`[dry-run] replyCard ${safeMessageId}`);
        return { messageId: 'dry-run' };
      }
      const data = await call(
        ['api', 'POST', `${MESSAGES_PATH}/${safeMessageId}/reply`, '--data', '-'],
        JSON.stringify({ msg_type: 'interactive', content }),
        BOT_IDENTITY,
      );
      return { messageId: data.message_id ?? '' };
    },

    async updateCard(messageId, card) {
      const safeMessageId = requireSafeId('messageId', messageId);
      const content = cardContent(card);
      if (dryRun) {
        log?.info?.(`[dry-run] updateCard ${safeMessageId}`);
        return;
      }
      await call(
        ['api', 'PATCH', `${MESSAGES_PATH}/${safeMessageId}`, '--data', '-'],
        JSON.stringify({ content }),
        BOT_IDENTITY,
      );
    },

    async sendCard(chatId, card) {
      const safeChatId = requireSafeId('chatId', chatId);
      const content = cardContent(card);
      if (dryRun) {
        log?.info?.(`[dry-run] sendCard ${safeChatId}`);
        return { messageId: 'dry-run' };
      }
      const data = await call(
        ['api', 'POST', MESSAGES_PATH, '--params', JSON.stringify({ receive_id_type: 'chat_id' }), '--data', '-'],
        JSON.stringify({ receive_id: safeChatId, msg_type: 'interactive', content }),
        BOT_IDENTITY,
      );
      return { messageId: data.message_id ?? '' };
    },

    async listMessages(chatId, { pageSize = 20 } = {}) {
      const safeChatId = requireSafeId('chatId', chatId);
      const data = await call([
        'api',
        'GET',
        MESSAGES_PATH,
        '--params',
        JSON.stringify({
          container_id_type: 'chat',
          container_id: safeChatId,
          page_size: pageSize,
          // Asc returns the chat's oldest page, so a single-page poll would
          // never observe new messages once the chat exceeds one page.
          sort_type: 'ByCreateTimeDesc',
        }),
      ]);
      // The page arrives newest-first; callers (and the poll cursor) depend on
      // ascending create_time order, so flip it back.
      return [...(data.items ?? [])].reverse();
    },

    // The CLI writes the binary itself and reports where; nothing binary ever
    // crosses the runner, whose stdout is decoded as UTF-8. `--output` must
    // live under the account temp directory (see config.paths.imagesDir).
    async downloadImage({ messageId, fileKey, outputPath }) {
      const safeMessageId = requireSafeId('messageId', messageId);
      const safeFileKey = requireSafeId('fileKey', fileKey);
      if (typeof outputPath !== 'string' || outputPath === '') {
        throw new LarkError('invalid screenshot output path');
      }
      if (dryRun) {
        log?.info?.(`[dry-run] downloadImage ${safeMessageId} ${safeFileKey}`);
        return { path: '' };
      }
      const data = await call([
        'im',
        '+messages-resources-download',
        '--message-id',
        safeMessageId,
        '--file-key',
        safeFileKey,
        '--type',
        'image',
        '--output',
        outputPath,
      ]);
      return {
        path: typeof data.saved_path === 'string' ? data.saved_path : '',
        size: Number.isFinite(data.size_bytes) ? data.size_bytes : 0,
      };
    },

    async reply(messageId, text) {
      const safeMessageId = requireSafeId('messageId', messageId);
      if (dryRun) {
        log?.info?.(`[dry-run] reply ${safeMessageId}: ${String(text).slice(0, 80)}`);
        return { messageId: 'dry-run' };
      }
      const data = await call(
        [
          'api',
          'POST',
          `${MESSAGES_PATH}/${safeMessageId}/reply`,
          // `-` tells the CLI to read the body from stdin.
          '--data',
          '-',
        ],
        // `content` is a JSON string, not an object.
        JSON.stringify({ content: textContent(text), msg_type: 'text' }),
        botReplies ? BOT_IDENTITY : IDENTITY,
      );
      return { messageId: data.message_id ?? '' };
    },

    async send(chatId, text) {
      const safeChatId = requireSafeId('chatId', chatId);
      if (dryRun) {
        log?.info?.(`[dry-run] send ${safeChatId}: ${String(text).slice(0, 80)}`);
        return { messageId: 'dry-run' };
      }
      const data = await call(
        [
          'api',
          'POST',
          MESSAGES_PATH,
          '--params',
          JSON.stringify({ receive_id_type: 'chat_id' }),
          '--data',
          '-',
        ],
        JSON.stringify({ receive_id: safeChatId, msg_type: 'text', content: textContent(text) }),
      );
      return { messageId: data.message_id ?? '' };
    },

    // Best effort display name; the engine falls back to the raw open_id.
    async getSenderName(openId) {
      let safeOpenId;
      try {
        safeOpenId = requireSafeId('openId', openId);
      } catch (err) {
        log?.warn?.(`[lark] skipping display name lookup: ${err?.message ?? err}`);
        return '';
      }
      try {
        const data = await call(['contact', '+get-user', '--user-id', safeOpenId]);
        const name = data?.user?.name;
        if (typeof name !== 'string' || name === '') {
          log?.warn?.(`[lark] no display name for ${safeOpenId}`);
          return '';
        }
        return name;
      } catch (err) {
        log?.warn?.(`[lark] cannot resolve display name for ${safeOpenId}: ${err?.message ?? err}`);
        return '';
      }
    },
  };
}
