// Local pre-search. The analysed repo is a multi-gigabyte Unity project, so a
// model that has to explore it from scratch burns its whole budget before it
// finds anything. One `git grep` pass over the tracked sources narrows the
// question to a handful of files, and the model then only has to read them.
//
// Patterns travel in a UTF-8 file (`git grep -f`), never in argv: the runner
// goes through cmd.exe, whose code page would mangle Chinese keywords.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only text sources and config: prefabs, assets and art would drown the result.
const PATHSPECS = [
  '*.cs',
  '*.lua',
  '*.py',
  '*.ts',
  '*.js',
  '*.json',
  '*.xml',
  '*.yaml',
  '*.yml',
  '*.txt',
  '*.csv',
  '*.md',
];

const CJK = /[\u4e00-\u9fff]/;
const MAX_TERMS = 12;
const MAX_FILES = 8;
const GREP_LINES_PER_FILE = 8;
const DIGEST_LINES_PER_FILE = 3;
const MAX_LINE_CHARS = 200;
const MAX_DIGEST_CHARS = 6000;

// Function words that make a bigram useless as a search term: every file
// contains 没有/这个/一下, and a term that matches everything ranks nothing.
const STOP_CHARS = new Set(
  '的了没吗呢我你他她它们是在和与就都也还要会下个这那上中到给让把被不很会能对从为以有'.split(''),
);

// ASCII identifiers are the strongest signal; CJK bigrams are the fallback,
// because Chinese has no word boundaries and "reward_1001" pins a config row
// while 奖励 alone may appear in hundreds of files.
export function extractTerms(question, { max = MAX_TERMS } = {}) {
  const text = String(question ?? '');
  const ascii = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)].map((m) => m[0]);

  const runs = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const bigrams = [];
  for (const run of runs) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (STOP_CHARS.has(gram[0]) || STOP_CHARS.has(gram[1])) continue;
      bigrams.push(gram);
    }
  }

  const seen = new Set();
  const terms = [];
  for (const term of [...ascii, ...bigrams]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= max) break;
  }
  return terms;
}

// `path:line:text`, with the path taken non-greedily so paths containing a
// colon still parse. git prints CRLF on Windows, and `.` does not match `\r`,
// so the split must consume it or the trailing `$` never matches.
function parseGrep(stdout) {
  const byPath = new Map();
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const match = /^(.*?):(\d+):(.*)$/.exec(raw);
    if (!match) continue;
    const [, path, lineNo, text] = match;
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push({ line: Number(lineNo), text: text.trim().slice(0, MAX_LINE_CHARS) });
  }
  return byPath;
}

// Rank by how many *different* keywords a file matches, so a file that holds the
// specific identifier outranks one that merely mentions a common word a lot.
function rank(byPath, terms) {
  const scored = [...byPath.entries()].map(([path, lines]) => {
    const matched = terms.filter((term) => lines.some((hit) => hit.text.includes(term)));
    const ordered = lines
      .map((hit) => ({ hit, weight: terms.filter((term) => hit.text.includes(term)).length }))
      .sort((a, b) => b.weight - a.weight || a.hit.line - b.hit.line)
      .slice(0, DIGEST_LINES_PER_FILE)
      .map((entry) => entry.hit);
    return { path, matched: matched.length, hits: lines.length, lines: ordered };
  });
  return scored
    .filter((file) => file.matched > 0)
    .sort((a, b) => b.matched - a.matched || b.hits - a.hits || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
}

export async function collectEvidence({
  question,
  repoDir,
  run,
  timeoutMs = 60_000,
  log = null,
  readFile = readFileSync,
}) {
  const terms = extractTerms(question);
  if (terms.length === 0) return { terms, files: [], digest: '', note: '问题里没有可检索的词' };

  const dir = mkdtempSync(join(tmpdir(), 'checkproblem-search-'));
  const patternFile = join(dir, 'patterns.txt');
  try {
    writeFileSync(patternFile, `${terms.join('\n')}\n`);

    const res = await run(
      'git',
      ['-C', repoDir, 'grep', '-n', '-I', '-F', '-m', String(GREP_LINES_PER_FILE), '-f', patternFile, '--', ...PATHSPECS],
      { timeoutMs },
    );

    // 1 means "no match", which is a normal answer.
    if (res.code !== 0 && res.code !== 1) {
      const detail = String(res.stderr ?? '').trim().slice(-200);
      log?.warn?.(`git grep failed (exit ${res.code}): ${detail}`);
      return { terms, files: [], digest: '', note: '本地检索失败' };
    }

    const byPath = parseGrep(res.stdout);
    let files = rank(byPath, terms).map((file) => ({
      ...file,
      snippet: snippetFor(repoDir, file, readFile),
    }));

    let total = files.reduce((n, f) => n + f.lines.length, 0);
    if (total === 0) return { terms, files: [], digest: '', note: '没有命中' };

    // Keep the digest inside the prompt budget by dropping whole files first.
    for (;;) {
      const digest = renderDigest(terms, files);
      if (digest.length <= MAX_DIGEST_CHARS || files.length <= 1) return { terms, files, digest, note: '' };
      files = files.slice(0, -1);
      total = files.reduce((n, f) => n + f.lines.length, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderDigest(terms, files) {
  const lines = [terms.length ? `命中关键词：${terms.join('、')}` : '', ''];
  for (const file of files) {
    lines.push(file.path);
    if (file.snippet) {
      lines.push(file.snippet);
    } else {
      for (const hit of file.lines) lines.push(`  ${hit.line}: ${hit.text}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

const SNIPPET_RADIUS = 20;
const SNIPPET_MAX_PER_FILE = 4000;

// Code around each hit, because a model reasoning over a window beats a model
// that has to grep for itself. The radius is small enough that eight files stay
// inside the prompt budget.
function snippetFor(repoDir, file, readFile) {
  let text;
  try {
    text = readFile(join(repoDir, file.path), 'utf8');
  } catch {
    return '';
  }
  const all = String(text).split(/\r?\n/);
  const wanted = new Set();
  for (const hit of file.lines) {
    const from = Math.max(1, hit.line - SNIPPET_RADIUS);
    const to = Math.min(all.length, hit.line + SNIPPET_RADIUS);
    for (let n = from; n <= to; n += 1) wanted.add(n);
  }

  const out = [];
  let previous = 0;
  for (const n of [...wanted].sort((a, b) => a - b)) {
    if (previous !== 0 && n !== previous + 1) out.push('  …');
    out.push(`${n}: ${all[n - 1]}`);
    previous = n;
  }
  return out.join('\n').slice(0, SNIPPET_MAX_PER_FILE);
}
