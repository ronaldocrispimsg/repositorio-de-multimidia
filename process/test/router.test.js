const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const sharp = require('sharp');

const {
  classifyAndValidateFile,
  processRouterMessage,
} = require('../router');
const { EVENTS } = require('../../shared/events');

// Helpers para criar buffers de arquivos com magic bytes reais
async function createValidPngFile(filePath, width = 64, height = 64) {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 25, g: 120, b: 220, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await fs.promises.writeFile(filePath, buf);
  return buf;
}

async function createValidJpegFile(filePath, width = 64, height = 64) {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 220, g: 90, b: 25 },
    },
  })
    .jpeg()
    .toBuffer();
  await fs.promises.writeFile(filePath, buf);
  return buf;
}

function createFakeMp3HeaderBuffer(size = 1024) {
  // ID3v2 header (10 bytes) + MPEG-1 Layer 3 frame sync (0xFF 0xFB 0x90 0x00)
  const buf = Buffer.alloc(size, 0);
  buf.write('ID3', 0, 'ascii');
  buf[3] = 0x03;
  buf[4] = 0x00;
  buf[10] = 0xff;
  buf[11] = 0xfb;
  buf[12] = 0x90;
  buf[13] = 0x00;
  return buf;
}

function createFakeMp4HeaderBuffer(size = 2048, brand = 'isom') {
  // ISO Base Media File Format: size(24) + 'ftyp' + major_brand(4) + minor_version(4) + compatible_brands
  const buf = Buffer.alloc(size, 0);
  buf.writeUInt32BE(24, 0);
  buf.write('ftyp', 4, 'ascii');
  buf.write(brand, 8, 'ascii');
  buf.writeUInt32BE(512, 12);
  buf.write('isom', 16, 'ascii');
  buf.write('mp42', 20, 'ascii');
  return buf;
}

function createGifHeaderBuffer() {
  // GIF89a minimal header
  return Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
}

test('Router: classifica imagem PNG e JPEG real -> image.uploaded', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videobox-router-img-'));
  try {
    const pngPath = path.join(tmpDir, 'sample.png');
    const jpgPath = path.join(tmpDir, 'sample.jpg');

    await createValidPngFile(pngPath);
    await createValidJpegFile(jpgPath);

    const pngDecision = await classifyAndValidateFile(pngPath);
    assert.equal(pngDecision.valid, true);
    assert.equal(pngDecision.type, 'image');
    assert.equal(pngDecision.mimeType, 'image/png');
    assert.equal(pngDecision.targetEvent, EVENTS.IMAGE_UPLOADED);

    const jpgDecision = await classifyAndValidateFile(jpgPath);
    assert.equal(jpgDecision.valid, true);
    assert.equal(jpgDecision.type, 'image');
    assert.equal(jpgDecision.mimeType, 'image/jpeg');
    assert.equal(jpgDecision.targetEvent, EVENTS.IMAGE_UPLOADED);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Router: classifica áudio MP3 (inclusive com capa attached_pic) -> audio.uploaded', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videobox-router-aud-'));
  try {
    const mp3Path = path.join(tmpDir, 'music.mp3');
    await fs.promises.writeFile(mp3Path, createFakeMp3HeaderBuffer(4096));

    const decision = await classifyAndValidateFile(mp3Path, {
      probeFn: async () => ({
        format: { format_name: 'mp3' },
        streams: [
          { codec_type: 'audio', codec_name: 'mp3', bit_rate: '128000' },
          { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        ],
      }),
    });

    assert.equal(decision.valid, true);
    assert.equal(decision.type, 'audio');
    assert.equal(decision.format, 'mp3');
    assert.equal(decision.mimeType, 'audio/mpeg');
    assert.equal(decision.targetEvent, EVENTS.AUDIO_UPLOADED);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Router: classifica vídeo MP4 com codec H264 e AV1 -> video.uploaded', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videobox-router-vid-'));
  try {
    const mp4Path = path.join(tmpDir, 'clip.mp4');
    await fs.promises.writeFile(mp4Path, createFakeMp4HeaderBuffer(8192));

    const h264Decision = await classifyAndValidateFile(mp4Path, {
      probeFn: async () => ({
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      }),
    });
    assert.equal(h264Decision.valid, true);
    assert.equal(h264Decision.type, 'video');
    assert.equal(h264Decision.codec, 'h264');
    assert.equal(h264Decision.targetEvent, EVENTS.VIDEO_UPLOADED);

    const av1Decision = await classifyAndValidateFile(mp4Path, {
      probeFn: async () => ({
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
        streams: [
          { codec_type: 'video', codec_name: 'av1', disposition: { attached_pic: 0 } },
        ],
      }),
    });
    assert.equal(av1Decision.valid, true);
    assert.equal(av1Decision.type, 'video');
    assert.equal(av1Decision.codec, 'av1');
    assert.equal(av1Decision.targetEvent, EVENTS.VIDEO_UPLOADED);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Router: rejeita arquivo com extensão trocada (.txt renomeado para .png), GIF, corrompido e acima do limite', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videobox-router-reject-'));
  try {
    // 1. .txt renomeado para .png
    const fakePngPath = path.join(tmpDir, 'fake.png');
    await fs.promises.writeFile(fakePngPath, 'Este arquivo eh texto puro disfarçado de PNG\n');
    const fakeDecision = await classifyAndValidateFile(fakePngPath);
    assert.equal(fakeDecision.valid, false);
    assert.match(fakeDecision.reason, /magic bytes/i);

    // 2. GIF rejeitado explicitamente
    const gifPath = path.join(tmpDir, 'anim.gif');
    await fs.promises.writeFile(gifPath, createGifHeaderBuffer());
    const gifDecision = await classifyAndValidateFile(gifPath);
    assert.equal(gifDecision.valid, false);
    assert.equal(gifDecision.type, 'image');
    assert.match(gifDecision.reason, /GIF/i);

    // 3. Imagem com header PNG mas payload truncado/corrompido
    const corruptPngPath = path.join(tmpDir, 'corrupt.png');
    const pngSignatureOnly = Buffer.from('89504e470d0a1a0a0000000d494844520000', 'hex');
    await fs.promises.writeFile(corruptPngPath, pngSignatureOnly);
    const corruptImgDecision = await classifyAndValidateFile(corruptPngPath);
    assert.equal(corruptImgDecision.valid, false);
    assert.match(corruptImgDecision.reason, /corrompida/i);

    // 4. Vídeo corrompido (ffprobe falha)
    const corruptMp4Path = path.join(tmpDir, 'corrupt.mp4');
    await fs.promises.writeFile(corruptMp4Path, createFakeMp4HeaderBuffer(512));
    const corruptVidDecision = await classifyAndValidateFile(corruptMp4Path, {
      probeFn: async () => {
        throw new Error('moov atom not found');
      },
    });
    assert.equal(corruptVidDecision.valid, false);
    assert.match(corruptVidDecision.reason, /moov atom not found/i);

    // 5. Imagem acima do limite de tamanho configurado
    const validPngPath = path.join(tmpDir, 'overlimit.png');
    await createValidPngFile(validPngPath, 100, 100);
    const overLimitImg = await classifyAndValidateFile(validPngPath, {
      maxImageBytes: 100, // 100 bytes
    });
    assert.equal(overLimitImg.valid, false);
    assert.match(overLimitImg.reason, /excede o limite/i);

    // 6. Áudio acima do limite
    const overLimitAudioPath = path.join(tmpDir, 'overlimit.mp3');
    await fs.promises.writeFile(overLimitAudioPath, createFakeMp3HeaderBuffer(2048));
    const overLimitAud = await classifyAndValidateFile(overLimitAudioPath, {
      maxAudioBytes: 512,
      probeFn: async () => ({
        format: { format_name: 'mp3' },
        streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
      }),
    });
    assert.equal(overLimitAud.valid, false);
    assert.match(overLimitAud.reason, /excede o limite/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Router: processRouterMessage apaga raw do Filer e publica file.rejected em arquivo inválido', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videobox-router-msg-'));
  try {
    const fileId = '550e8400-e29b-41d4-a716-446655440099';
    const storageKey = `raw/${fileId}/original`;
    const deletedKeys = [];
    const published = [];
    let acked = false;

    const fakeStorage = {
      isValidFileId: () => true,
      rawKey: (id) => `raw/${id}/original`,
      getStream: async () => ({
        stream: Readable.from(Buffer.from('texto puro nao eh imagem')),
      }),
      delete: async (key) => {
        deletedKeys.push(key);
        return true;
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
          filename: 'malicioso.png',
          storage_key: storageKey,
          original_size: 24,
        })
      ),
      properties: { headers: {} },
    };

    const result = await processRouterMessage(fakeChannel, msg, {
      tmpDir,
      storage: fakeStorage,
    });

    assert.equal(result.action, 'rejected');
    assert.equal(acked, true);
    assert.deepEqual(deletedKeys, [storageKey]);
    assert.equal(published.length, 1);
    assert.equal(published[0].routingKey, EVENTS.FILE_REJECTED);
    assert.equal(published[0].payload.file_id, fileId);
    assert.equal(published[0].payload.status, 'rejected');
    assert.ok(published[0].payload.error);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
