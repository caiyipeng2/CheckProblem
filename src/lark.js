// Feishu adapter. Every lark-cli invocation lives here so the rest of the
// service deals in plain data only.
//
// The `im +chat-messages-list` / `im +messages-reply` shortcuts statically
// require the `im:message.reactions:read` scope even with `--no-reactions`, and
// that scope cannot be granted in our tenant. The raw `lark-cli api` escape
// hatch uses scopes we already hold, so all message access goes through it.

const IDENTITY = ['--as', 'user', '--json'];

const MESSAGES_PATH = '/open-apis/im/v1/messages';

export class LarkError extends Error {
  constructor(message, { code = null, missingScopes = [] } = {}) {
    super(message);
    this.name = 'LarkError';
    this.code = code;
    this.missingScopes = missingScopes;
  }
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
      const data = await call([
        'api',
        'GET',
        MESSAGES_PATH,
        '--params',
        JSON.stringify({
          container_id_type: 'chat',
          container_id: chatId,
          page_size: pageSize,
          sort_type: 'ByCreateTimeAsc',
        }),
      ]);
      // Already ascending by create_time; never re-sort client-side.
      return data.items ?? [];
    },

    async reply(messageId, text) {
      if (dryRun) {
        log?.info?.(`[dry-run] reply ${messageId}: ${String(text).slice(0, 80)}`);
        return { messageId: 'dry-run' };
      }
      const data = await call([
        'api',
        'POST',
        `${MESSAGES_PATH}/${messageId}/reply`,
        // `content` is a JSON string, not an object.
        '--data',
        JSON.stringify({ content: textContent(text), msg_type: 'text' }),
      ]);
      return { messageId: data.message_id ?? '' };
    },

    async send(chatId, text) {
      if (dryRun) {
        log?.info?.(`[dry-run] send ${chatId}: ${String(text).slice(0, 80)}`);
        return { messageId: 'dry-run' };
      }
      const data = await call([
        'api',
        'POST',
        MESSAGES_PATH,
        '--params',
        JSON.stringify({ receive_id_type: 'chat_id' }),
        '--data',
        JSON.stringify({ receive_id: chatId, msg_type: 'text', content: textContent(text) }),
      ]);
      return { messageId: data.message_id ?? '' };
    },

    // Best effort display name; the engine falls back to the raw open_id.
    async getSenderName(openId) {
      if (!openId) return '';
      try {
        const data = await call(['contact', '+get-user', '--user-id', openId]);
        const name = data?.user?.name;
        if (typeof name !== 'string' || name === '') {
          log?.warn?.(`[lark] no display name for ${openId}`);
          return '';
        }
        return name;
      } catch (err) {
        log?.warn?.(`[lark] cannot resolve display name for ${openId}: ${err?.message ?? err}`);
        return '';
      }
    },
  };
}
