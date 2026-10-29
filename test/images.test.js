import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  clearImages,
  collectImages,
  imageDirFor,
  uniqueRefs,
} from '../src/images.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF = Buffer.from('GIF89a');
const WEBP = Buffer.from('RIFF0000WEBP');
const TEXT = Buffer.from('not an image at all');

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'images-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Stands in for lark-cli: the real command saves the bytes next to the path it
// was given and reports where they landed.
function downloader(bytes, { suffix = '.png', seen = [] } = {}) {
  return async ({ messageId, fileKey, outputPath }) => {
    seen.push({ messageId, fileKey, outputPath });
    const path = `${outputPath}${suffix}`;
    writeFileSync(path, bytes);
    return { path, size: bytes.length };
  };
}

test('collectImages downloads every reference into the job directory', async (t) => {
  const dir = join(workspace(t), 'job');
  const seen = [];
  const refs = [
    { messageId: 'om_1', fileKey: 'img_one' },
    { messageId: 'om_2', fileKey: 'img_two' },
  ];

  const images = await collectImages({
    refs,
    dir,
    download: async (request) => {
      seen.push(request);
      const path = `${request.outputPath}.png`;
      writeFileSync(path, PNG);
      return { path };
    },
  });

  assert.deepEqual(images.map((image) => [image.path, image.mime]), [
    [join(dir, 'image-1.png'), 'image/png'],
    [join(dir, 'image-2.png'), 'image/png'],
  ]);
  assert.deepEqual(seen.map(({ messageId, fileKey }) => [messageId, fileKey]), [
    ['om_1', 'img_one'],
    ['om_2', 'img_two'],
  ]);
  assert.match(seen[0].outputPath, /image-1$/);
});

test('collectImages detects the accepted image formats from their bytes', async (t) => {
  for (const [bytes, mime, suffix] of [
    [PNG, 'image/png', '.png'],
    [JPEG, 'image/jpeg', '.jpg'],
    [GIF, 'image/gif', '.gif'],
    [WEBP, 'image/webp', '.webp'],
  ]) {
    const images = await collectImages({
      refs: [{ messageId: 'om_1', fileKey: 'img_a' }],
      dir: join(workspace(t), 'job'),
      download: downloader(bytes, { suffix }),
    });
    assert.deepEqual(images.map((image) => image.mime), [mime]);
  }
});

test('collectImages skips duplicates, refs beyond the cap and incomplete refs', async (t) => {
  const refs = [
    { messageId: 'om_1', fileKey: 'img_same' },
    { messageId: 'om_1', fileKey: 'img_same' },
    { messageId: '', fileKey: 'img_no_message' },
    { messageId: 'om_2', fileKey: '' },
    ...Array.from({ length: MAX_IMAGES + 2 }, (_, i) => ({ messageId: `om_${i}`, fileKey: `img_${i}` })),
  ];
  const seen = [];
  const images = await collectImages({
    refs,
    dir: join(workspace(t), 'job'),
    download: downloader(PNG, { seen }),
  });

  assert.equal(images.length, MAX_IMAGES);
  assert.equal(seen.length, MAX_IMAGES);
  assert.equal(new Set(seen.map(({ fileKey }) => fileKey)).size, MAX_IMAGES);
});

test('collectImages skips failed downloads and unusable files instead of failing the job', async (t) => {
  const dir = join(workspace(t), 'job');
  const warnings = [];
  const log = { warn: (line) => warnings.push(line) };
  let call = 0;

  const download = async ({ outputPath }) => {
    call += 1;
    if (call === 1) throw new Error('network offline');
    const bytes = call === 2 ? PNG : TEXT;
    const path = `${outputPath}.bin`;
    writeFileSync(path, bytes);
    return call === 3 ? { path: '' } : { path };
  };

  const images = await collectImages({
    refs: Array.from({ length: 3 }, (_, i) => ({ messageId: `om_${i}`, fileKey: `img_${i}` })),
    dir,
    download,
    log,
  });

  assert.deepEqual(images.map((image) => image.path), [join(dir, 'image-2.bin')]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /network offline/);
  assert.match(warnings[1], /img_2/);
});

test('collectImages rejects oversized files and leaves nothing behind', async (t) => {
  const dir = join(workspace(t), 'job');
  const warnings = [];
  const huge = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES + 1)]);

  const images = await collectImages({
    refs: [{ messageId: 'om_1', fileKey: 'img_huge' }],
    dir,
    download: downloader(huge),
    log: { warn: (line) => warnings.push(line) },
  });

  assert.deepEqual(images, []);
  assert.equal(existsSync(join(dir, 'image-1.png')), false);
  assert.match(warnings[0], /过大/);
});

test('collectImages does not touch the disk when nothing was attached', async (t) => {
  const dir = join(workspace(t), 'job');
  let called = 0;
  const images = await collectImages({
    refs: [],
    dir,
    download: async () => {
      called += 1;
      return { path: '' };
    },
  });
  assert.deepEqual(images, []);
  assert.equal(called, 0);
  assert.equal(existsSync(dir), false);
});

test('collectImages without a downloader returns no images', async () => {
  assert.deepEqual(await collectImages({ refs: [{ messageId: 'om_1', fileKey: 'img_a' }], dir: 'unused' }), []);
});

test('clearImages removes the job directory and tolerates a missing one', (t) => {
  const dir = join(workspace(t), 'job');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'image-1.png'), PNG);
  clearImages(dir);
  assert.equal(existsSync(dir), false);
  assert.doesNotThrow(() => clearImages(dir));
});

test('uniqueRefs keeps the first copies and sanitizes the job directory name', () => {
  const refs = uniqueRefs([
    { messageId: 'om_1', fileKey: 'img_a' },
    { messageId: 'om_2', fileKey: 'img_a' },
    { messageId: 'om_3', fileKey: 'img_b' },
  ]);
  assert.deepEqual(refs, [
    { messageId: 'om_1', fileKey: 'img_a' },
    { messageId: 'om_3', fileKey: 'img_b' },
  ]);
  assert.equal(imageDirFor('C:/tmp/root', 'om_1/../x'), join('C:/tmp/root', 'om_1____x'));
});
