const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  extractAudioMetadata,
  decideAudioTranscodePlan,
  processAudioMessage,
} = require('../audio');
const { EVENTS } = require('../../shared/events');

test('Audio: Ramo 1 - MP3 <= 128k faz apenas remux (-vn -c:a copy) mantendo .mp3', () => {
  const probeData = {
    format: {
      format_name: 'mp3',
      duration: '185.42',
      tags: { TITLE: 'Sinfonia Digital', ARTIST: 'Ronaldo' },
    },
    streams: [
      {
        codec_type: 'audio',
        codec_name: 'mp3',
        bit_rate: '128000',
      },
      {
        codec_type: 'video',
        codec_name: 'mjpeg',
        disposition: { attached_pic: 1 },
      },
    ],
  };

  const meta = extractAudioMetadata(probeData);
  assert.equal(meta.codec, 'mp3');
  assert.equal(meta.bitrate, 128000);
  assert.equal(meta.durationSec, 185.42);
  assert.deepEqual(meta.tags, { title: 'Sinfonia Digital', artist: 'Ronaldo' });

  const plan = decideAudioTranscodePlan(meta);
  assert.equal(plan.mode, 'copy_mp3');
  assert.equal(plan.outputExt, 'mp3');
  assert.equal(plan.outputFormat, 'mp3');
  assert.equal(plan.contentType, 'audio/mpeg');
  assert.deepEqual(plan.ffmpegArgs, ['-vn', '-c:a', 'copy']);
});

test('Audio: Ramo 2 - AAC (M4A) <= 128k faz apenas remux (-vn -c:a copy -movflags +faststart) mantendo .m4a', () => {
  const probeData = {
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '42.10',
    },
    streams: [
      {
        codec_type: 'audio',
        codec_name: 'aac',
        bit_rate: '96000',
        tags: { title: 'Podcast Episodio 1' },
      },
    ],
  };

  const meta = extractAudioMetadata(probeData);
  assert.equal(meta.codec, 'aac');
  assert.equal(meta.bitrate, 96000);
  assert.equal(meta.durationSec, 42.1);
  assert.deepEqual(meta.tags, { title: 'Podcast Episodio 1' });

  const plan = decideAudioTranscodePlan(meta);
  assert.equal(plan.mode, 'copy_m4a');
  assert.equal(plan.outputExt, 'm4a');
  assert.equal(plan.outputFormat, 'm4a');
  assert.equal(plan.contentType, 'audio/mp4');
  assert.deepEqual(plan.ffmpegArgs, ['-vn', '-c:a', 'copy', '-movflags', '+faststart']);
});

test('Audio: Ramo 3 - WAV, FLAC, OGG ou MP3/AAC > 128k reencoda para AAC 128k (.m4a com +faststart)', () => {
  // Caso 3a: WAV PCM (1411 kbps)
  const wavMeta = extractAudioMetadata({
    format: { format_name: 'wav', duration: '12.5' },
    streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', bit_rate: '1411200' }],
  });
  const wavPlan = decideAudioTranscodePlan(wavMeta);
  assert.equal(wavPlan.mode, 'transcode_aac_128k');
  assert.equal(wavPlan.outputExt, 'm4a');
  assert.deepEqual(wavPlan.ffmpegArgs, ['-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']);

  // Caso 3b: MP3 320 kbps (> 128k)
  const mp3HighMeta = extractAudioMetadata({
    format: { format_name: 'mp3', duration: '210.0' },
    streams: [{ codec_type: 'audio', codec_name: 'mp3', bit_rate: '320000' }],
  });
  const mp3HighPlan = decideAudioTranscodePlan(mp3HighMeta);
  assert.equal(mp3HighPlan.mode, 'transcode_aac_128k');
  assert.equal(mp3HighPlan.outputExt, 'm4a');

  // Caso 3c: FLAC sem bit_rate explícito no stream
  const flacMeta = extractAudioMetadata({
    format: { format_name: 'flac', duration: '95.8' },
    streams: [{ codec_type: 'audio', codec_name: 'flac' }],
  });
  const flacPlan = decideAudioTranscodePlan(flacMeta);
  assert.equal(flacPlan.mode, 'transcode_aac_128k');
  assert.equal(flacPlan.outputExt, 'm4a');
});

test('Audio: processAudioMessage publica audio.processing -> audio.ready com duration_sec e tags, e remove o raw', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videobox-aud-worker-'));
  try {
    const fileId = '880e8400-e29b-41d4-a716-446655440002';
    const rawKey = `raw/${fileId}/original`;
    const fakeInputBytes = Buffer.from('ID3-fake-audio-input-content');
    const fakeOutputBytes = Buffer.from('M4A-fake-transcoded-output');

    const storedObjects = new Map();
    const deletedKeys = [];
    const published = [];
    let acked = false;
    let capturedFfmpegArgs = null;

    const fakeStorage = {
      isValidFileId: () => true,
      rawKey: (id) => `raw/${id}/original`,
      audioKey: (id, ext) => `processed/audio/${id}.${ext}`,
      getStream: async () => ({
        stream: Readable.from(fakeInputBytes),
      }),
      put: async (key, streamOrBuf, opts) => {
        const chunks = [];
        for await (const chunk of streamOrBuf) {
          chunks.push(Buffer.from(chunk));
        }
        storedObjects.set(key, { buf: Buffer.concat(chunks), opts });
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
          type: 'audio',
          filename: 'faixa_original.wav',
          storage_key: rawKey,
          mime_type: 'audio/wav',
          original_size: fakeInputBytes.length,
        })
      ),
      properties: { headers: {} },
    };

    const res = await processAudioMessage(fakeChannel, msg, {
      tmpDir,
      storage: fakeStorage,
      probeFn: async () => ({
        format: {
          format_name: 'wav',
          duration: '64.25',
          tags: { title: 'Faixa Teste', artist: 'Banda Local' },
        },
        streams: [
          {
            codec_type: 'audio',
            codec_name: 'pcm_s16le',
            bit_rate: '1411200',
          },
        ],
      }),
      ffmpegFn: async (_inPath, outPath, args) => {
        capturedFfmpegArgs = args;
        await fs.promises.writeFile(outPath, fakeOutputBytes);
      },
    });

    assert.equal(res.action, 'ready');
    assert.equal(acked, true);
    assert.deepEqual(capturedFfmpegArgs, ['-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']);
    assert.equal(published.length, 2);
    assert.equal(published[0].routingKey, EVENTS.AUDIO_PROCESSING);
    assert.equal(published[1].routingKey, EVENTS.AUDIO_READY);
    assert.equal(published[1].payload.result.url, `/media/audio/${fileId}.m4a`);
    assert.equal(published[1].payload.result.format, 'm4a');
    assert.equal(published[1].payload.result.duration_sec, 64.25);
    assert.deepEqual(published[1].payload.result.tags, { title: 'Faixa Teste', artist: 'Banda Local' });
    assert.ok(storedObjects.has(`processed/audio/${fileId}.m4a`));
    assert.deepEqual(deletedKeys, [rawKey]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
