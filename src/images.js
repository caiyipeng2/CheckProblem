// Screenshot pipeline: the only place that turns a job's image references into
// files on disk, and the only place that removes them again.
//
// The bytes never travel through the runner: its stdout is decoded as UTF-8, so
// the downloader writes the file itself and reports the saved path. Every file
// is validated by its magic bytes because the name the CLI picks is inferred
// from the server response.

import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Enough screenshots to cover a report without blowing up the model payload.
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

// Chat engines accept these four; anything else (SVG, HEIC, stickers) is not
// worth risking on a model gateway we do not control.
export function imageMime(head) {
  if (!head || head.length < 3) return '';
  if (head.subarray(0, 4).equals(Buffer.from(PNG_SIGNATURE))) return 'image/png';
  if (head.subarray(0, 3).equals(Buffer.from(JPEG_SIGNATURE))) return 'image/jpeg';
  const ascii = head.subarray(0, 12).toString('latin1');
  if (ascii.startsWith('GIF8')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  return '';
}

export function uniqueRefs(refs, max = MAX_IMAGES) {
  const seen = new Set();
  const out = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const messageId = typeof ref?.messageId === 'string' ? ref.messageId : '';
    const fileKey = typeof ref?.fileKey === 'string' ? ref.fileKey : '';
    if (!messageId || !fileKey || seen.has(fileKey)) continue;
    seen.add(fileKey);
    out.push({ messageId, fileKey });
    if (out.length === max) break;
  }
  return out;
}

// The message id becomes a directory name, so keep it to characters that cannot
// climb out of the image root.
export function imageDirFor(root, jobId) {
  const name = String(jobId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'job';
  return join(root, name);
}

export async function collectImages({ refs, dir, download, log = null, maxBytes = MAX_IMAGE_BYTES }) {
  const wanted = uniqueRefs(refs);
  if (wanted.length === 0 || typeof download !== 'function') return [];

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log?.warn?.(`cannot create the screenshot directory: ${err?.message ?? err}`);
    return [];
  }

  const saved = [];
  for (const [index, ref] of wanted.entries()) {
    try {
      const result = await download({ ...ref, outputPath: join(dir, `image-${index + 1}`) });
      const path = typeof result?.path === 'string' ? result.path : '';
      if (!path) {
        log?.warn?.(`screenshot ${ref.fileKey}: 下载未返回文件路径`);
        continue;
      }
      if (statSync(path).size > maxBytes) {
        log?.warn?.(`screenshot ${ref.fileKey}: 图片过大，已跳过`);
        rmSync(path, { force: true });
        continue;
      }
      const mime = imageMime(readFileSync(path).subarray(0, 12));
      if (!mime) {
        log?.warn?.(`screenshot ${ref.fileKey}: 不是受支持的图片格式，已跳过`);
        rmSync(path, { force: true });
        continue;
      }
      saved.push({ path, mime });
    } catch (err) {
      log?.warn?.(`screenshot ${ref.fileKey} skipped: ${err?.message ?? err}`);
    }
  }
  return saved;
}

// Best effort: a leftover temp directory must not turn a delivered answer into
// a failed job.
export function clearImages(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
