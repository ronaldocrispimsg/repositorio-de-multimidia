const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const FileType = require('file-type');

const storage = require('../storage');
const {
  EVENTS,
  publishEvent,
  handleWorkerRetryOrFail,
} = require('../../shared/events');

const MAX_WEBP_BYTES = 300 * 1024; // 300 KB
const INITIAL_MAX_DIMENSION = 2048;
const MIN_DIMENSION = 320;
const DIMENSION_SHRINK_FACTOR = 0.85;
const QUALITY_STEPS = [85, 75, 65, 55, 45];
const DEFAULT_LIMIT_INPUT_PIXELS = 268402689; // ~16384 x 16384
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function detectImageMagicBytes(input) {
  if (Buffer.isBuffer(input)) {
    if (typeof FileType.fromBuffer === 'function') {
      return FileType.fromBuffer(input);
    }
    const mod = await import('file-type');
    const fn = mod.fileTypeFromBuffer || (mod.default && mod.default.fromBuffer);
    return fn(input);
  }
  if (typeof FileType.fromFile === 'function') {
    return FileType.fromFile(input);
  }
  const mod = await import('file-type');
  const fn = mod.fileTypeFromFile || (mod.default && mod.default.fromFile);
  return fn(input);
}

/**
 * Converte uma imagem de entrada (caminho ou Buffer) para WebP <= 300 KB:
 * - Aplica orientação EXIF (.rotate()) e remove metadados (padrão do sharp)
 * - Preserva canal alpha quando presente
 * - Rejeita GIFs e imagens animadas (pages > 1)
 * - Redimensiona com fit: 'inside', withoutEnlargement: true (máximo inicial 2048x2048)
 * - Testa qualidades [85, 75, 65, 55, 45]; se ainda passar de 300 KB, reduz a maior dimensão em 15% até o piso de 320px
 */
async function compressImageToWebp(input, options = {}) {
  const maxBytes = Number(options.maxBytes || MAX_WEBP_BYTES);
  const limitInputPixels = Number(
    options.limitInputPixels || process.env.LIMIT_INPUT_PIXELS || DEFAULT_LIMIT_INPUT_PIXELS
  );
  const minDimension = Number(options.minDimension || MIN_DIMENSION);
  const initialMaxDimension = Number(options.initialMaxDimension || INITIAL_MAX_DIMENSION);
  const qualitySteps = Array.isArray(options.qualitySteps) && options.qualitySteps.length > 0
    ? options.qualitySteps
    : QUALITY_STEPS;

  const detected = await detectImageMagicBytes(input);
  if (!detected || !detected.mime) {
    throw new Error('Assinatura binária de imagem inválida ou não reconhecida.');
  }

  if (detected.mime === 'image/gif' || detected.ext === 'gif') {
    throw new Error('Formato GIF (estático ou animado) não é suportado pelo worker de imagem.');
  }

  if (!ALLOWED_IMAGE_MIMES.has(detected.mime)) {
    throw new Error(`Formato de imagem não suportado (${detected.mime}). Aceitos: jpeg, png, webp.`);
  }

  const baseInstance = sharp(input, { limitInputPixels });
  const metadata = await baseInstance.metadata();

  if (!metadata || !metadata.width || !metadata.height) {
    throw new Error('Imagem inválida ou sem dimensões detectáveis.');
  }

  if (metadata.pages && metadata.pages > 1) {
    throw new Error('Imagens animadas (múltiplos quadros/páginas) não são suportadas.');
  }

  // Considera troca de eixos quando a orientação EXIF é 5, 6, 7 ou 8 (rotação de 90°/270°)
  const swapAxes = metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8;
  const orientedWidth = swapAxes ? metadata.height : metadata.width;
  const orientedHeight = swapAxes ? metadata.width : metadata.height;
  const longestSide = Math.max(orientedWidth, orientedHeight);

  let targetBoundingBox = Math.min(initialMaxDimension, longestSide);

  while (targetBoundingBox >= minDimension) {
    for (const quality of qualitySteps) {
      const { data, info } = await sharp(input, { limitInputPixels })
        .rotate() // auto-orienta via EXIF e remove a tag de orientação; sharp omite EXIF por padrão no output
        .resize({
          width: targetBoundingBox,
          height: targetBoundingBox,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({
          quality,
          alphaQuality: quality,
          effort: 4,
        })
        .toBuffer({ resolveWithObject: true });

      if (data.length <= maxBytes) {
        return {
          buffer: data,
          size: data.length,
          width: info.width,
          height: info.height,
          format: 'webp',
          quality,
          hasAlpha: Boolean(info.channels === 4 || metadata.hasAlpha),
        };
      }
    }

    if (targetBoundingBox === minDimension) {
      break;
    }

    const nextBox = Math.floor(targetBoundingBox * DIMENSION_SHRINK_FACTOR);
    if (nextBox < minDimension) {
      if (targetBoundingBox > minDimension) {
        targetBoundingBox = minDimension;
      } else {
        break;
      }
    } else {
      targetBoundingBox = nextBox;
    }
  }

  throw new Error(
    `Não foi possível comprimir a imagem para WebP <= ${Math.round(maxBytes / 1024)} KB mesmo na dimensão mínima de ${minDimension}px.`
  );
}

async function downloadForImageWorker(storageClient, storageKey, fileId, tmpDir) {
  if (!storageClient.isValidFileId(fileId)) {
    throw new Error(`file_id inválido no worker de imagem: ${fileId}`);
  }
  const targetPath = path.join(tmpDir, `image_${fileId}`);
  const { stream } = await storageClient.getStream(storageKey);
  const writer = fs.createWriteStream(targetPath);

  stream.pipe(writer);

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    writer.on('finish', () => resolve(targetPath));
    writer.on('error', reject);
  });
}

async function processImageMessage(channel, msg, options = {}) {
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
    const rawStorageKey = event.storage_key || storageClient.rawKey(fileId);

    if (!storageClient.isValidFileId(fileId)) {
      throw new Error(`file_id inválido recebido em image.uploaded: ${fileId}`);
    }

    console.log(`[process-image] Processando imagem ${fileId} (${event.filename || 'unnamed'})...`);

    publishEvent(channel, EVENTS.IMAGE_PROCESSING, {
      file_id: fileId,
      type: 'image',
      filename: event.filename || 'unnamed',
      storage_key: rawStorageKey,
      mime_type: event.mime_type || 'image/webp',
      original_size: event.original_size || 0,
      status: 'processing',
      result: null,
      error: null,
    });

    downloadedFile = await downloadForImageWorker(storageClient, rawStorageKey, fileId, tmpDir);

    const compressed = await compressImageToWebp(downloadedFile, options);
    const processedKey = storageClient.imageKey(fileId);

    await storageClient.put(processedKey, compressed.buffer, {
      contentType: 'image/webp',
      contentLength: compressed.size,
    });

    const mediaUrl = `/media/images/${fileId}.webp`;

    const readyPayload = publishEvent(channel, EVENTS.IMAGE_READY, {
      file_id: fileId,
      type: 'image',
      filename: event.filename || 'unnamed',
      storage_key: processedKey,
      mime_type: 'image/webp',
      original_size: event.original_size || 0,
      status: 'ready',
      result: {
        url: mediaUrl,
        size: compressed.size,
        format: 'webp',
        width: compressed.width,
        height: compressed.height,
      },
      error: null,
    });

    // Apaga o raw do Filer após publicar image.ready com sucesso
    await storageClient.delete(rawStorageKey).catch((err) => {
      console.warn(`[process-image] Aviso: falha ao remover raw ${rawStorageKey}:`, err.message);
    });

    console.log(
      `[process-image] Imagem ${fileId} pronta em ${mediaUrl} (${compressed.width}x${compressed.height}, ${compressed.size} bytes)`
    );

    channel.ack(msg);
    return { action: 'ready', result: compressed, payload: readyPayload };
  } catch (error) {
    console.error(`[process-image] Erro ao processar imagem ${event ? event.file_id : 'desconhecida'}:`, error.message);
    return handleWorkerRetryOrFail({
      channel,
      msg,
      event,
      type: 'image',
      uploadEventName: EVENTS.IMAGE_UPLOADED,
      failedEventName: EVENTS.IMAGE_FAILED,
      error,
      serviceTag: 'process-image',
    });
  } finally {
    if (cleanTmp && downloadedFile && fs.existsSync(downloadedFile)) {
      await fs.promises.unlink(downloadedFile).catch(() => {});
    }
  }
}

async function startImageConsumer(channel, options = {}) {
  await channel.prefetch(1);
  console.log(`[process-image] Worker (image) aguardando eventos na fila ${EVENTS.IMAGE_UPLOADED}...`);

  await channel.consume(EVENTS.IMAGE_UPLOADED, async (msg) => {
    if (!msg) return;
    await processImageMessage(channel, msg, options);
  });
}

module.exports = {
  MAX_WEBP_BYTES,
  INITIAL_MAX_DIMENSION,
  MIN_DIMENSION,
  QUALITY_STEPS,
  compressImageToWebp,
  processImageMessage,
  startImageConsumer,
};
