const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const sharp = require('sharp');

const {
  MAX_WEBP_BYTES,
  compressImageToWebp,
  processImageMessage,
} = require('../image');
const { EVENTS } = require('../../shared/events');

test('Image: converte imagem grande e ruidosa para WebP <= 300 KB com redimensionamento progressivo', async () => {
  // Cria uma imagem 2600x1800 com ruído colorido pseudoaleatório para forçar compressão e loop de qualidade/dimensão
  const width = 2600;
  const height = 1800;
  const rawPixels = Buffer.alloc(width * height * 3);
  let seed = 1337;
  for (let i = 0; i < rawPixels.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rawPixels[i] = seed & 0xff;
  }

  const inputPng = await sharp(rawPixels, {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 1 })
    .toBuffer();

  assert.ok(inputPng.length > MAX_WEBP_BYTES, 'Imagem de entrada deve ser maior que 300 KB');

  const out = await compressImageToWebp(inputPng);
  assert.equal(out.format, 'webp');
  assert.ok(out.size <= MAX_WEBP_BYTES, `WebP gerado (${out.size} bytes) deve ser <= ${MAX_WEBP_BYTES}`);
  assert.ok(out.width <= 2048);
  assert.ok(out.height <= 2048);
  assert.ok(out.width >= 320 || out.height >= 320);

  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, out.width);
  assert.equal(meta.height, out.height);
});

test('Image: preserva canal alpha (transparência) em PNG transparente', async () => {
  const width = 400;
  const height = 300;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = 20;
    rgba[i * 4 + 1] = 180;
    rgba[i * 4 + 2] = 240;
    rgba[i * 4 + 3] = i % 2 === 0 ? 0 : 180; // transparência parcial e total
  }

  const pngWithAlpha = await sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  const out = await compressImageToWebp(pngWithAlpha);
  assert.equal(out.format, 'webp');
  assert.equal(out.hasAlpha, true);
  assert.ok(out.size <= MAX_WEBP_BYTES);

  const outMeta = await sharp(out.buffer).metadata();
  assert.equal(outMeta.hasAlpha, true);
  assert.equal(outMeta.channels, 4);
});

test('Image: aplica orientação EXIF (rotate) e remove metadados EXIF do WebP final', async () => {
  // Cria imagem 600x200 com EXIF Orientation = 6 (90° CW -> deve virar 200x600 após auto-orientação)
  const rawJpeg = await sharp({
    create: {
      width: 600,
      height: 200,
      channels: 3,
      background: { r: 200, g: 50, b: 80 },
    },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

  const inputMeta = await sharp(rawJpeg).metadata();
  assert.equal(inputMeta.orientation, 6);

  const out = await compressImageToWebp(rawJpeg);
  assert.equal(out.width, 200);
  assert.equal(out.height, 600);

  const outMeta = await sharp(out.buffer).metadata();
  assert.equal(outMeta.width, 200);
  assert.equal(outMeta.height, 600);
  assert.equal(outMeta.orientation, undefined);
  assert.equal(outMeta.exif, undefined);
});

test('Image: rejeita GIF animado/estático', async () => {
  const gifBuffer = Buffer.from(
    '47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b',
    'hex'
  );

  await assert.rejects(
    async () => compressImageToWebp(gifBuffer),
    /GIF/i
  );
});

test('Image: processImageMessage publica image.processing -> image.ready e apaga o raw do Filer', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videobox-img-worker-'));
  try {
    const fileId = '770e8400-e29b-41d4-a716-446655440001';
    const rawKey = `raw/${fileId}/original`;
    const pngBuf = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 4,
        background: { r: 40, g: 160, b: 90, alpha: 0.8 },
      },
    })
      .png()
      .toBuffer();

    const storedObjects = new Map();
    const deletedKeys = [];
    const published = [];
    let acked = false;

    const fakeStorage = {
      isValidFileId: () => true,
      rawKey: (id) => `raw/${id}/original`,
      imageKey: (id) => `processed/images/${id}.webp`,
      getStream: async () => ({
        stream: Readable.from(pngBuf),
      }),
      put: async (key, buf, opts) => {
        storedObjects.set(key, { buf, opts });
        return { storage_key: key, status: 201 };
      },
      delete: async (key) => {
        deletedKeys.push(key);
        return { storage_key: key, deleted: true };
      },
    };

    const fakeChannel = {
      publish: (exchange, routingKey, content) => {
        published.push({
          exchange,
          routingKey,
          payload: JSON.parse(content.toString()),
        });
        return true;
      },
      ack: () => {
        acked = true;
      },
    };

    const msg = {
      content: Buffer.from(
        JSON.stringify({
          file_id: fileId,
          type: 'image',
          filename: 'foto_transparente.png',
          storage_key: rawKey,
          mime_type: 'image/png',
          original_size: pngBuf.length,
        })
      ),
      properties: { headers: {} },
    };

    const res = await processImageMessage(fakeChannel, msg, {
      tmpDir,
      storage: fakeStorage,
    });

    assert.equal(res.action, 'ready');
    assert.equal(acked, true);
    assert.equal(published.length, 2);
    assert.equal(published[0].routingKey, EVENTS.IMAGE_PROCESSING);
    assert.equal(published[1].routingKey, EVENTS.IMAGE_READY);
    assert.equal(published[1].payload.result.url, `/media/images/${fileId}.webp`);
    assert.equal(published[1].payload.result.format, 'webp');
    assert.equal(published[1].payload.result.width, 800);
    assert.equal(published[1].payload.result.height, 600);
    assert.ok(published[1].payload.result.size <= MAX_WEBP_BYTES);
    assert.ok(storedObjects.has(`processed/images/${fileId}.webp`));
    assert.deepEqual(deletedKeys, [rawKey]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

