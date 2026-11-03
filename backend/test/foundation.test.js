const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createStore } = require('../store');
const {
  EVENTS,
  BACKEND_BINDINGS,
  WORKER_QUEUES,
  EXCHANGE_EVENTS,
  EXCHANGE_RETRY,
  QUEUE_RETRY_WAIT,
  QUEUE_BACKEND,
  setupTopology,
  buildEventPayload,
  publishEvent,
  handleWorkerRetryOrFail,
} = require('../../shared/events');
const {
  createStorage,
  sanitizeFilename,
  rawKey,
  videoKey,
  imageKey,
  audioKey,
  resolveSafeKey,
} = require('../storage');

test('store: progressão normal, bloqueio de transições regressivas e idempotência', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repositorio-multimidia-store-test-'));
  const stateFile = path.join(tmpDir, 'videos_state.json');

  try {
    const store = createStore({ stateFile });
    const fileId = crypto.randomUUID();

    // 1. Criação com uploaded
    const r1 = await store.upsert(fileId, {
      type: 'video',
      filename: 'aula.mp4',
      storage_key: `raw/${fileId}/original`,
      mime_type: 'video/mp4',
      original_size: 102400,
      status: 'uploaded',
    });
    assert.equal(r1.updated, true);
    assert.equal(r1.item.status, 'uploaded');

    // 2. Evolução para processing
    const r2 = await store.upsert(fileId, { status: 'processing' });
    assert.equal(r2.updated, true);
    assert.equal(r2.item.status, 'processing');

    // 3. Transição regressiva processing -> uploaded deve ser ignorada
    const rReg1 = await store.upsert(fileId, { status: 'uploaded' });
    assert.equal(rReg1.updated, false);
    assert.equal(store.get(fileId).status, 'processing');

    // 4. Evolução para ready
    const resultObj = {
      url: `/streams/${fileId}/playlist.m3u8`,
      format: 'hls',
      size: 98000,
    };
    const r3 = await store.upsert(fileId, {
      status: 'ready',
      result: resultObj,
    });
    assert.equal(r3.updated, true);
    assert.equal(r3.item.status, 'ready');
    assert.equal(r3.item.stream_url, `/streams/${fileId}/playlist.m3u8`);

    // 5. Transições regressivas a partir de ready (ready -> processing, ready -> uploaded, ready -> failed) ignoradas
    const rReg2 = await store.upsert(fileId, { status: 'processing' });
    assert.equal(rReg2.updated, false);
    assert.equal(store.get(fileId).status, 'ready');

    const rReg3 = await store.upsert(fileId, { status: 'uploaded' });
    assert.equal(rReg3.updated, false);
    assert.equal(store.get(fileId).status, 'ready');

    const rReg4 = await store.upsert(fileId, { status: 'failed', error: 'atrasado' });
    assert.equal(rReg4.updated, false);
    assert.equal(store.get(fileId).status, 'ready');
    assert.equal(store.get(fileId).error, null);

    // 6. Reprocessamento idempotente do mesmo file_id (ready -> ready sobrescreve sem duplicar)
    const rIdemp = await store.upsert(fileId, {
      status: 'ready',
      result: { url: `/streams/${fileId}/playlist.m3u8`, format: 'hls', size: 99000 },
    });
    assert.equal(rIdemp.updated, true);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(fileId).result.size, 99000);

    // 7. Persistência atômica em disco
    assert.equal(fs.existsSync(`${stateFile}.tmp`), false);
    const reloaded = createStore({ stateFile });
    assert.equal(reloaded.get(fileId).status, 'ready');

    // 8. Filtro por tipo e status em store.list({ type, status })
    const imgId = crypto.randomUUID();
    const audId = crypto.randomUUID();
    await reloaded.upsert(imgId, {
      type: 'image',
      filename: 'foto.webp',
      status: 'ready',
    });
    await reloaded.upsert(audId, {
      type: 'audio',
      filename: 'musica.mp3',
      status: 'processing',
    });

    assert.equal(reloaded.list().length, 3);
    assert.equal(reloaded.list({ type: 'video' }).length, 1);
    assert.equal(reloaded.list({ type: 'image' }).length, 1);
    assert.equal(reloaded.list({ type: 'audio' }).length, 1);
    assert.equal(reloaded.list({ status: 'ready' }).length, 2);
    assert.equal(reloaded.list({ type: 'audio', status: 'processing' }).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('events: topologia sem curingas, lista fechada de 14 eventos e retry com DLX', async () => {
  const exchanges = [];
  const queues = [];
  const bindings = [];
  const published = [];
  const acked = [];

  const mockChannel = {
    assertExchange: async (name, type, opts) => exchanges.push({ name, type, opts }),
    assertQueue: async (name, opts) => queues.push({ name, opts }),
    bindQueue: async (queue, exchange, key) => bindings.push({ queue, exchange, key }),
    publish: (exchange, routingKey, content, opts) => {
      published.push({ exchange, routingKey, content: JSON.parse(content.toString()), opts });
    },
    ack: (msg) => acked.push(msg),
  };

  await setupTopology(mockChannel);

  // Verifica que nenhum binding usa curinga '*' ou '#'
  for (const b of bindings) {
    assert.equal(b.key.includes('*'), false, `Binding não deve conter *: ${b.key}`);
    assert.equal(b.key.includes('#'), false, `Binding não deve conter #: ${b.key}`);
  }

  // Verifica os 10 bindings explícitos de media.backend
  const backendKeys = bindings.filter((b) => b.queue === QUEUE_BACKEND).map((b) => b.key);
  assert.deepEqual(backendKeys, [...BACKEND_BINDINGS]);
  assert.equal(backendKeys.length, 10);

  // Verifica que video.uploaded é declarada sem argumentos extras (compatibilidade KEDA)
  const videoQueue = queues.find((q) => q.name === EVENTS.VIDEO_UPLOADED);
  assert.deepEqual(videoQueue.opts, { durable: true });

  // Verifica rejeição de evento fora da lista fechada
  const fileId = crypto.randomUUID();
  assert.throws(
    () => publishEvent(mockChannel, '<type>.failed', { file_id: fileId, status: 'failed' }),
    /Evento não permitido/
  );

  // Simula 3 tentativas de retry seguidas de falha definitiva (video.failed)
  const baseEvent = buildEventPayload({
    file_id: fileId,
    type: 'video',
    filename: 'video.mp4',
    storage_key: `raw/${fileId}/original`,
    mime_type: 'video/mp4',
    original_size: 5000,
    status: 'uploaded',
  });

  for (let count = 0; count < 3; count++) {
    const msg = {
      content: Buffer.from(JSON.stringify(baseEvent)),
      properties: { headers: count === 0 ? {} : { 'x-retry-count': count } },
    };
    const res = await handleWorkerRetryOrFail({
      channel: mockChannel,
      msg,
      event: baseEvent,
      type: 'video',
      error: new Error(`Falha simulada #${count + 1}`),
      maxRetries: 3,
      baseDelayMs: 500,
    });
    assert.equal(res.action, 'retried');
    assert.equal(res.retryCount, count + 1);
    assert.equal(res.delayMs, 500 * Math.pow(2, count));
  }

  // Após 3 retries (x-retry-count = 3), esgota e publica video.failed
  const exhaustedMsg = {
    content: Buffer.from(JSON.stringify(baseEvent)),
    properties: { headers: { 'x-retry-count': 3 } },
  };
  const finalRes = await handleWorkerRetryOrFail({
    channel: mockChannel,
    msg: exhaustedMsg,
    event: baseEvent,
    type: 'video',
    error: new Error('Erro fatal no FFmpeg'),
    maxRetries: 3,
    baseDelayMs: 500,
  });

  assert.equal(finalRes.action, 'failed');
  assert.equal(finalRes.eventName, EVENTS.VIDEO_FAILED);
  const lastPublished = published[published.length - 1];
  assert.equal(lastPublished.exchange, EXCHANGE_EVENTS);
  assert.equal(lastPublished.routingKey, 'video.failed');
  assert.equal(lastPublished.content.status, 'failed');
  assert.equal(lastPublished.content.error, 'Erro fatal no FFmpeg');
  assert.equal(acked.length, 4);
});

test('storage: chaves determinísticas sem nome original e bloqueio de path traversal', async () => {
  const fileId = crypto.randomUUID();

  assert.equal(rawKey(fileId), `raw/${fileId}/original`);
  assert.equal(videoKey(fileId, 'playlist.m3u8'), `processed/videos/${fileId}/playlist.m3u8`);
  assert.equal(imageKey(fileId), `processed/images/${fileId}.webp`);
  assert.equal(audioKey(fileId, 'm4a'), `processed/audio/${fileId}.m4a`);

  // Sanitização de nome de arquivo
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('meu\0video:teste?.mp4'), 'meu_video_teste_.mp4');

  // Path traversal deve lançar erro
  assert.throws(() => videoKey(fileId, '../../raw/outro'), /fora do prefixo permitido/);
  assert.throws(() => resolveSafeKey('processed/videos', '../secret'), /fora do prefixo permitido/);
  assert.throws(() => rawKey(`${fileId}_nomeOriginal.mp4`), /file_id inválido/);

  // Operações HTTP no filer via cliente mockado
  const calls = [];
  const storage = createStorage({
    filerUrl: 'http://filer:8888',
    httpClient: async (req) => {
      calls.push(req);
      return { status: 201, data: Buffer.from('ok'), headers: { 'content-length': '2' } };
    },
  });

  await storage.put(rawKey(fileId), Buffer.from('dados'), { contentType: 'video/mp4' });
  await storage.get(rawKey(fileId));
  await storage.delete(rawKey(fileId));

  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, `http://filer:8888/raw/${fileId}/original`);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[2].method, 'DELETE');
});

