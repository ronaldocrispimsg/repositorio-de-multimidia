const crypto = require('crypto');

const EXCHANGE_EVENTS = 'media.events';
const EXCHANGE_RETRY = 'media.retry';
const QUEUE_RETRY_WAIT = 'media.retry.wait';
const QUEUE_BACKEND = 'media.backend';

const EVENTS = Object.freeze({
  FILE_UPLOADED: 'file.uploaded',
  FILE_REJECTED: 'file.rejected',
  VIDEO_UPLOADED: 'video.uploaded',
  AUDIO_UPLOADED: 'audio.uploaded',
  IMAGE_UPLOADED: 'image.uploaded',
  VIDEO_PROCESSING: 'video.processing',
  AUDIO_PROCESSING: 'audio.processing',
  IMAGE_PROCESSING: 'image.processing',
  VIDEO_READY: 'video.ready',
  AUDIO_READY: 'audio.ready',
  IMAGE_READY: 'image.ready',
  VIDEO_FAILED: 'video.failed',
  AUDIO_FAILED: 'audio.failed',
  IMAGE_FAILED: 'image.failed',
});

const ALLOWED_EVENTS = new Set(Object.values(EVENTS));

const WORKER_QUEUES = Object.freeze([
  EVENTS.FILE_UPLOADED,
  EVENTS.VIDEO_UPLOADED,
  EVENTS.AUDIO_UPLOADED,
  EVENTS.IMAGE_UPLOADED,
]);

const BACKEND_BINDINGS = Object.freeze([
  EVENTS.VIDEO_PROCESSING,
  EVENTS.AUDIO_PROCESSING,
  EVENTS.IMAGE_PROCESSING,
  EVENTS.VIDEO_READY,
  EVENTS.AUDIO_READY,
  EVENTS.IMAGE_READY,
  EVENTS.VIDEO_FAILED,
  EVENTS.AUDIO_FAILED,
  EVENTS.IMAGE_FAILED,
  EVENTS.FILE_REJECTED,
]);

const FAILED_EVENT_BY_TYPE = Object.freeze({
  video: EVENTS.VIDEO_FAILED,
  audio: EVENTS.AUDIO_FAILED,
  image: EVENTS.IMAGE_FAILED,
});

const UPLOADED_EVENT_BY_TYPE = Object.freeze({
  video: EVENTS.VIDEO_UPLOADED,
  audio: EVENTS.AUDIO_UPLOADED,
  image: EVENTS.IMAGE_UPLOADED,
});

const PROCESSING_EVENT_BY_TYPE = Object.freeze({
  video: EVENTS.VIDEO_PROCESSING,
  audio: EVENTS.AUDIO_PROCESSING,
  image: EVENTS.IMAGE_PROCESSING,
});

const READY_EVENT_BY_TYPE = Object.freeze({
  video: EVENTS.VIDEO_READY,
  audio: EVENTS.AUDIO_READY,
  image: EVENTS.IMAGE_READY,
});

async function setupTopology(channel) {
  await channel.assertExchange(EXCHANGE_EVENTS, 'topic', { durable: true });
  await channel.assertExchange(EXCHANGE_RETRY, 'topic', { durable: true });

  await channel.assertQueue(QUEUE_RETRY_WAIT, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EXCHANGE_EVENTS,
    },
  });

  for (const queueName of WORKER_QUEUES) {
    await channel.bindQueue(QUEUE_RETRY_WAIT, EXCHANGE_RETRY, queueName);
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, EXCHANGE_EVENTS, queueName);
  }

  await channel.assertQueue(QUEUE_BACKEND, { durable: true });
  for (const bindingKey of BACKEND_BINDINGS) {
    await channel.bindQueue(QUEUE_BACKEND, EXCHANGE_EVENTS, bindingKey);
  }
}

function buildEventPayload(params = {}) {
  if (!params.file_id) {
    throw new Error('file_id é obrigatório no payload do evento.');
  }
  if (!params.status) {
    throw new Error('status é obrigatório no payload do evento.');
  }

  return {
    event_id: params.event_id || crypto.randomUUID(),
    file_id: params.file_id,
    type: params.type || null,
    filename: params.filename || 'unnamed',
    storage_key: params.storage_key || null,
    mime_type: params.mime_type || 'application/octet-stream',
    original_size: typeof params.original_size === 'number' ? params.original_size : 0,
    occurred_at: params.occurred_at || new Date().toISOString(),
    status: params.status,
    result: params.result !== undefined ? params.result : null,
    error: params.error !== undefined ? params.error : null,
  };
}

function publishEvent(channel, eventName, payloadParams, options = {}) {
  if (!ALLOWED_EVENTS.has(eventName)) {
    throw new Error(`Evento não permitido fora da lista fechada: ${eventName}`);
  }
  if (!channel) {
    throw new Error(`Canal RabbitMQ indisponível ao publicar ${eventName}`);
  }

  const payload = buildEventPayload(payloadParams);
  const buffer = Buffer.from(JSON.stringify(payload));

  channel.publish(EXCHANGE_EVENTS, eventName, buffer, {
    persistent: true,
    contentType: 'application/json',
    ...options,
  });

  return payload;
}

async function handleWorkerRetryOrFail({
  channel,
  msg,
  event,
  type,
  uploadEventName,
  failedEventName,
  error,
  maxRetries,
  baseDelayMs,
  serviceTag = 'process',
}) {
  const resolvedType = type || (event && event.type) || 'video';
  const targetUploadEvent = uploadEventName || UPLOADED_EVENT_BY_TYPE[resolvedType];
  const targetFailedEvent = failedEventName || FAILED_EVENT_BY_TYPE[resolvedType];

  if (!ALLOWED_EVENTS.has(targetUploadEvent) || !ALLOWED_EVENTS.has(targetFailedEvent)) {
    throw new Error(`Eventos de retry/falha inválidos para o tipo: ${resolvedType}`);
  }

  const headers = (msg && msg.properties && msg.properties.headers) || {};
  const retryCount = Number(headers['x-retry-count'] || 0);
  const limit = maxRetries !== undefined
    ? Number(maxRetries)
    : Number(process.env.MAX_RETRY_ATTEMPTS || 3);
  const baseDelay = baseDelayMs !== undefined
    ? Number(baseDelayMs)
    : Number(process.env.RETRY_BASE_DELAY_MS || 1000);

  const errorMessage = error && error.message ? error.message : String(error || 'Erro desconhecido');
  const fileId = (event && (event.file_id || event.video_id)) || 'desconhecido';

  if (retryCount < limit) {
    const nextRetry = retryCount + 1;
    const delayMs = Math.max(100, baseDelay * Math.pow(2, retryCount));

    console.warn(
      `[${serviceTag}] Falha ao processar ${fileId} (tentativa ${nextRetry}/${limit}). Reagendando em ${delayMs}ms: ${errorMessage}`
    );

    channel.publish(EXCHANGE_RETRY, targetUploadEvent, msg.content, {
      persistent: true,
      contentType: 'application/json',
      expiration: String(delayMs),
      headers: {
        ...headers,
        'x-retry-count': nextRetry,
        'x-last-error': errorMessage,
      },
    });

    channel.ack(msg);
    return { action: 'retried', retryCount: nextRetry, delayMs };
  }

  console.error(
    `[${serviceTag}] Tentativas esgotadas (${limit}) para ${fileId}. Publicando ${targetFailedEvent}: ${errorMessage}`
  );

  let failedPayload = null;
  if (event && (event.file_id || event.video_id)) {
    const finalStatus = targetFailedEvent === EVENTS.FILE_REJECTED ? 'rejected' : 'failed';
    failedPayload = publishEvent(channel, targetFailedEvent, {
      file_id: event.file_id || event.video_id,
      type: resolvedType,
      filename: event.filename || 'unnamed',
      storage_key: event.storage_key || null,
      mime_type: event.mime_type || 'application/octet-stream',
      original_size: typeof event.original_size === 'number' ? event.original_size : 0,
      status: finalStatus,
      result: null,
      error: errorMessage,
    });
  }

  channel.ack(msg);
  return { action: 'failed', retryCount, eventName: targetFailedEvent, payload: failedPayload };
}

module.exports = {
  EXCHANGE_EVENTS,
  EXCHANGE_RETRY,
  QUEUE_RETRY_WAIT,
  QUEUE_BACKEND,
  EVENTS,
  ALLOWED_EVENTS,
  WORKER_QUEUES,
  BACKEND_BINDINGS,
  FAILED_EVENT_BY_TYPE,
  UPLOADED_EVENT_BY_TYPE,
  PROCESSING_EVENT_BY_TYPE,
  READY_EVENT_BY_TYPE,
  setupTopology,
  buildEventPayload,
  publishEvent,
  handleWorkerRetryOrFail,
};

