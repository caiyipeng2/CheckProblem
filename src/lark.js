// Feishu adapter. Every lark-cli invocation lives here so the rest of the
// service deals in plain data only.
//
// The `im +chat-messages-list` / `im +messages-reply` shortcuts statically
// require the `im:message.reactions:read` scope even with `--no-reactions`, and
// that scope cannot be granted in our tenant. The raw `lark-cli api` escape
// hatch uses scopes we already hold, so all message access goes through it.

const IDENTITY = ['--as', 'user', '--json'];

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

export function createLark({ run, dryRun = false, log = null }) {
  // Reads always execute, even under dryRun, so `--dry-run` still exercises
  // real polling against Feishu.
  const call = async (args) => {
    const res = (await run('lark-cli', [...args, ...IDENTITY])) ?? {};
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

  return {
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
          sort_type: 'ByCreateTimeAsc',
        }),
      ]);
      // Already ascending by create_time; never re-sort client-side.
      return data.items ?? [];
    },

    async reply(messageId, text) {
      const safeMessageId = requireSafeId('messageId', messageId);
      if (dryRun) {
        log?.info?.(`[dry-run] reply ${safeMessageId}: ${String(text).slice(0, 80)}`);
        return { messageId: 'dry-run' };
      }
      const data = await call([
        'api',
        'POST',
        `${MESSAGES_PATH}/${safeMessageId}/reply`,
        // `content` is a JSON string, not an object.
        '--data',
        JSON.stringify({ content: textContent(text), msg_type: 'text' }),
      ]);
      return { messageId: data.message_id ?? '' };
    },

    async send(chatId, text) {
      const safeChatId = requireSafeId('chatId', chatId);
      if (dryRun) {
        log?.info?.(`[dry-run] send ${safeChatId}: ${String(text).slice(0, 80)}`);
        return { messageId: 'dry-run' };
      }
      const data = await call([
        'api',
        'POST',
        MESSAGES_PATH,
        '--params',
        JSON.stringify({ receive_id_type: 'chat_id' }),
        '--data',
        JSON.stringify({ receive_id: safeChatId, msg_type: 'text', content: textContent(text) }),
      ]);
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
