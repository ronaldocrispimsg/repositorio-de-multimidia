const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const FileType = require('file-type');
const sharp = require('sharp');

const storage = require('../storage');
const {
  EVENTS,
  publishEvent,
  handleWorkerRetryOrFail,
} = require('../../shared/events');

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const DEFAULT_MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200 MB
const DEFAULT_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const DEFAULT_LIMIT_INPUT_PIXELS = 268402689; // ~16384 x 16384

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'flac', 'ogg', 'oga', 'opus']);
const ALLOWED_VIDEO_CODECS = new Set([
  'h264',
  'hevc',
  'h265',
  'av1',
  'vp8',
  'vp9',
  'mpeg4',
  'mpeg2video',
  'mpeg1video',
  'theora',
  'prores',
  'wmv3',
  'vc1',
  'flv1',
  'dnxhd',
  'MJPEG',
  'mjpeg',
]);

function getLimits(overrides = {}) {
  return {
    maxImageBytes: Number(
      overrides.maxImageBytes !== undefined
        ? overrides.maxImageBytes
        : process.env.MAX_IMAGE_SIZE_BYTES || DEFAULT_MAX_IMAGE_BYTES
    ),
    maxAudioBytes: Number(
      overrides.maxAudioBytes !== undefined
        ? overrides.maxAudioBytes
        : process.env.MAX_AUDIO_SIZE_BYTES || DEFAULT_MAX_AUDIO_BYTES
    ),
    maxVideoBytes: Number(
      overrides.maxVideoBytes !== undefined
        ? overrides.maxVideoBytes
        : process.env.MAX_VIDEO_SIZE_BYTES || DEFAULT_MAX_VIDEO_BYTES
    ),
    limitInputPixels: Number(
      overrides.limitInputPixels !== undefined
        ? overrides.limitInputPixels
        : process.env.LIMIT_INPUT_PIXELS || DEFAULT_LIMIT_INPUT_PIXELS
    ),
  };
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      filePath,
    ];

    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Falha ao executar ffprobe: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe retornou código ${code}: ${stderr.trim() || 'arquivo inválido ou corrompido'}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Saída inválida do ffprobe: ${err.message}`));
      }
    });
  });
}

async function detectMagicBytes(filePath) {
  if (typeof FileType.fromFile === 'function') {
    return FileType.fromFile(filePath);
  }
  const mod = await import('file-type');
  const fn = mod.fileTypeFromFile || (mod.default && mod.default.fromFile);
  return fn(filePath);
}

function normalizeAudioFormat(detected, probeFormatName = '', audioCodec = '') {
  const ext = (detected && detected.ext ? detected.ext : '').toLowerCase();
  const fmt = String(probeFormatName || '').toLowerCase();
  const codec = String(audioCodec || '').toLowerCase();

  if (ext === 'mp3' || fmt.includes('mp3') || codec === 'mp3') {
    return { format: 'mp3', mime: 'audio/mpeg' };
  }
  if (ext === 'm4a' || ext === 'mp4' || fmt.includes('m4a') || fmt.includes('mp4')) {
    return { format: 'm4a', mime: 'audio/mp4' };
  }
  if (ext === 'wav' || fmt.includes('wav')) {
    return { format: 'wav', mime: 'audio/wav' };
  }
  if (ext === 'flac' || fmt.includes('flac') || codec === 'flac') {
    return { format: 'flac', mime: 'audio/flac' };
  }
  if (ALLOWED_AUDIO_EXTS.has(ext) || fmt.includes('ogg')) {
    return { format: 'ogg', mime: 'audio/ogg' };
  }
  return null;
}

async function classifyAndValidateFile(filePath, options = {}) {
  const limits = getLimits(options);
  const probeFn = options.probeFn || runFfprobe;

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    return {
      valid: false,
      type: null,
      mimeType: null,
      size: 0,
      reason: 'Arquivo não encontrado ou inacessível para validação.',
    };
  }

  const fileSize = typeof options.declaredSize === 'number' && options.declaredSize > stat.size
    ? options.declaredSize
    : stat.size;

  if (fileSize <= 0) {
    return {
      valid: false,
      type: null,
      mimeType: null,
      size: 0,
      reason: 'Arquivo vazio (0 bytes).',
    };
  }

  let detected;
  try {
    detected = await detectMagicBytes(filePath);
  } catch (err) {
    return {
      valid: false,
      type: null,
      mimeType: null,
      size: fileSize,
      reason: `Erro ao inspecionar magic bytes: ${err.message}`,
    };
  }

  if (!detected || !detected.mime) {
    return {
      valid: false,
      type: null,
      mimeType: null,
      size: fileSize,
      reason: 'Tipo de arquivo inválido: assinatura binária (magic bytes) não reconhecida.',
    };
  }

  const { ext, mime } = detected;

  // Rejeição explícita de GIF (estático ou animado)
  if (mime === 'image/gif' || ext === 'gif') {
    return {
      valid: false,
      type: 'image',
      mimeType: 'image/gif',
      size: fileSize,
      reason: 'GIF animado ou estático não é suportado. Envie imagens JPEG, PNG ou WebP.',
    };
  }

  // Ramo 1: Imagem (JPEG, PNG, WebP)
  if (mime.startsWith('image/')) {
    if (!ALLOWED_IMAGE_MIMES.has(mime)) {
      return {
        valid: false,
        type: 'image',
        mimeType: mime,
        size: fileSize,
        reason: `Formato de imagem não suportado (${ext}). Formatos aceitos: jpeg, jpg, png, webp.`,
      };
    }

    if (fileSize > limits.maxImageBytes) {
      return {
        valid: false,
        type: 'image',
        mimeType: mime,
        size: fileSize,
        reason: `Imagem excede o limite máximo permitido de ${Math.round(limits.maxImageBytes / (1024 * 1024))} MB.`,
      };
    }

    try {
      const metadata = await sharp(filePath, { limitInputPixels: limits.limitInputPixels }).metadata();
      if (!metadata || !metadata.width || !metadata.height) {
        return {
          valid: false,
          type: 'image',
          mimeType: mime,
          size: fileSize,
          reason: 'Imagem corrompida: dimensões inválidas.',
        };
      }
      if (metadata.pages && metadata.pages > 1) {
        return {
          valid: false,
          type: 'image',
          mimeType: mime,
          size: fileSize,
          reason: 'Imagens animadas não são suportadas.',
        };
      }
    } catch (err) {
      return {
        valid: false,
        type: 'image',
        mimeType: mime,
        size: fileSize,
        reason: `Imagem corrompida ou ilegível: ${err.message}`,
      };
    }

    return {
      valid: true,
      type: 'image',
      mimeType: mime,
      size: fileSize,
      targetEvent: EVENTS.IMAGE_UPLOADED,
    };
  }

  // Ramo 2: Containers de Áudio ou Vídeo (validados com ffprobe)
  const isMediaCandidate =
    mime.startsWith('video/') ||
    mime.startsWith('audio/') ||
    mime === 'application/ogg' ||
    mime === 'application/mp4';

  if (!isMediaCandidate) {
    return {
      valid: false,
      type: null,
      mimeType: mime,
      size: fileSize,
      reason: `Tipo de arquivo não suportado (${mime}).`,
    };
  }

  let probeData;
  try {
    probeData = await probeFn(filePath);
  } catch (err) {
    return {
      valid: false,
      type: mime.startsWith('audio/') ? 'audio' : 'video',
      mimeType: mime,
      size: fileSize,
      reason: `Arquivo de mídia corrompido ou ilegível pelo ffprobe: ${err.message}`,
    };
  }

  const streams = Array.isArray(probeData && probeData.streams) ? probeData.streams : [];
  if (streams.length === 0) {
    return {
      valid: false,
      type: null,
      mimeType: mime,
      size: fileSize,
      reason: 'Arquivo de mídia corrompido: nenhum fluxo encontrado pelo ffprobe.',
    };
  }

  // Fluxos de vídeo reais (desconsiderando capas de álbum attached_pic)
  const videoStreams = streams.filter(
    (s) => s.codec_type === 'video' && (!s.disposition || s.disposition.attached_pic !== 1)
  );
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');

  if (videoStreams.length > 0) {
    const primaryVideo = videoStreams[0];
    const codecName = String(primaryVideo.codec_name || '').toLowerCase();

    if (!codecName || codecName === 'none' || !ALLOWED_VIDEO_CODECS.has(codecName)) {
      return {
        valid: false,
        type: 'video',
        mimeType: mime,
        size: fileSize,
        reason: `Codec de vídeo inválido ou não suportado pelo ffprobe: ${codecName || 'desconhecido'}.`,
      };
    }

    if (fileSize > limits.maxVideoBytes) {
      return {
        valid: false,
        type: 'video',
        mimeType: mime.startsWith('video/') ? mime : 'video/mp4',
        size: fileSize,
        reason: `Vídeo excede o limite máximo permitido de ${Math.round(limits.maxVideoBytes / (1024 * 1024))} MB.`,
      };
    }

    return {
      valid: true,
      type: 'video',
      codec: codecName,
      mimeType: mime.startsWith('video/') ? mime : 'video/mp4',
      size: fileSize,
      targetEvent: EVENTS.VIDEO_UPLOADED,
    };
  }

  if (audioStreams.length > 0) {
    const primaryAudio = audioStreams[0];
    const audioCodec = String(primaryAudio.codec_name || '').toLowerCase();
    const formatName = (probeData.format && probeData.format.format_name) || '';

    if (!audioCodec || audioCodec === 'none') {
      return {
        valid: false,
        type: 'audio',
        mimeType: mime,
        size: fileSize,
        reason: 'Fluxo de áudio corrompido ou codec não identificado.',
      };
    }

    const normalizedAudio = normalizeAudioFormat(detected, formatName, audioCodec);
    if (!normalizedAudio) {
      return {
        valid: false,
        type: 'audio',
        mimeType: mime,
        size: fileSize,
        reason: `Formato de áudio não suportado (${ext}). Formatos aceitos: mp3, m4a, wav, flac, ogg.`,
      };
    }

    if (fileSize > limits.maxAudioBytes) {
      return {
        valid: false,
        type: 'audio',
        mimeType: normalizedAudio.mime,
        size: fileSize,
        reason: `Áudio excede o limite máximo permitido de ${Math.round(limits.maxAudioBytes / (1024 * 1024))} MB.`,
      };
    }

    return {
      valid: true,
      type: 'audio',
      codec: audioCodec,
      format: normalizedAudio.format,
      mimeType: normalizedAudio.mime,
      size: fileSize,
      targetEvent: EVENTS.AUDIO_UPLOADED,
    };
  }

  return {
    valid: false,
    type: null,
    mimeType: mime,
    size: fileSize,
    reason: 'Arquivo não contém fluxos válidos de vídeo ou áudio.',
  };
}

async function downloadForRouter(storageClient, storageKey, fileId, tmpDir) {
  if (!storageClient.isValidFileId(fileId)) {
    throw new Error(`file_id inválido no router: ${fileId}`);
  }
  const targetPath = path.join(tmpDir, `router_${fileId}`);
  const { stream } = await storageClient.getStream(storageKey);
  const writer = fs.createWriteStream(targetPath);

  stream.pipe(writer);

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    writer.on('finish', () => resolve(targetPath));
    writer.on('error', reject);
  });
}

async function processRouterMessage(channel, msg, options = {}) {
  const tmpDir = path.resolve(options.tmpDir || process.env.TMP_DOWNLOADS || '/tmp/videos_download');
  const cleanTmp = ['1', 'true', 'yes'].includes((process.env.CLEAN_TMP || 'true').toLowerCase());
  const storageClient = options.storage || storage;

  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  let event = null;
  let downloadedFile = null;

  try {
    event = JSON.parse(msg.content.toString());
    const fileId = event.file_id || event.video_id;
    const storageKey = event.storage_key || storageClient.rawKey(fileId);

    if (!storageClient.isValidFileId(fileId)) {
      throw new Error(`file_id inválido recebido em file.uploaded: ${fileId}`);
    }

    console.log(`[process-router] Inspecionando arquivo ${fileId} (${event.filename || 'unnamed'})...`);

    downloadedFile = await downloadForRouter(storageClient, storageKey, fileId, tmpDir);

    const decision = await classifyAndValidateFile(downloadedFile, {
      declaredSize: event.original_size,
      ...options,
    });

    if (!decision.valid) {
      console.warn(`[process-router] Arquivo ${fileId} rejeitado: ${decision.reason}`);
      await storageClient.delete(storageKey).catch(() => {});

      const rejectedPayload = publishEvent(channel, EVENTS.FILE_REJECTED, {
        file_id: fileId,
        type: decision.type || event.type || null,
        filename: event.filename || 'unnamed',
        storage_key: storageKey,
        mime_type: decision.mimeType || event.mime_type || 'application/octet-stream',
        original_size: decision.size || event.original_size || 0,
        status: 'rejected',
        result: null,
        error: decision.reason,
      });

      channel.ack(msg);
      return { action: 'rejected', decision, payload: rejectedPayload };
    }

    console.log(
      `[process-router] Arquivo ${fileId} classificado como ${decision.type} (${decision.mimeType}) -> ${decision.targetEvent}`
    );

    const routedPayload = publishEvent(channel, decision.targetEvent, {
      file_id: fileId,
      type: decision.type,
      filename: event.filename || 'unnamed',
      storage_key: storageKey,
      mime_type: decision.mimeType,
      original_size: decision.size,
      status: 'uploaded',
      result: null,
      error: null,
    });

    channel.ack(msg);
    return { action: 'routed', decision, payload: routedPayload };
  } catch (error) {
    console.error(`[process-router] Erro ao rotear ${event ? event.file_id : 'desconhecido'}:`, error.message);
    return handleWorkerRetryOrFail({
      channel,
      msg,
      event,
      type: (event && event.type) || 'video',
      uploadEventName: EVENTS.FILE_UPLOADED,
      failedEventName: EVENTS.FILE_REJECTED,
      error,
      serviceTag: 'process-router',
    });
  } finally {
    if (cleanTmp && downloadedFile && fs.existsSync(downloadedFile)) {
      await fs.promises.unlink(downloadedFile).catch(() => {});
    }
  }
}

async function startRouterConsumer(channel, options = {}) {
  await channel.prefetch(1);
  console.log(`[process-router] Aguardando eventos na fila ${EVENTS.FILE_UPLOADED}...`);

  await channel.consume(EVENTS.FILE_UPLOADED, async (msg) => {
    if (!msg) return;
    await processRouterMessage(channel, msg, options);
  });
}

module.exports = {
  getLimits,
  runFfprobe,
  detectMagicBytes,
  classifyAndValidateFile,
  processRouterMessage,
  startRouterConsumer,
};
