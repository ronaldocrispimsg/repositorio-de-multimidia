const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const storage = require('../storage');
const { runFfprobe } = require('../router');
const {
  EVENTS,
  publishEvent,
  handleWorkerRetryOrFail,
} = require('../../shared/events');

const MAX_COPY_BITRATE_BPS = 128000; // 128 kbps

function extractAudioMetadata(probeData) {
  const streams = Array.isArray(probeData && probeData.streams) ? probeData.streams : [];
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  if (!audioStream) {
    throw new Error('Nenhum fluxo de áudio encontrado pelo ffprobe.');
  }

  const formatObj = (probeData && probeData.format) || {};
  const formatName = String(formatObj.format_name || '').toLowerCase();
  const codecName = String(audioStream.codec_name || '').toLowerCase();

  // Bitrate do stream tem prioridade; fallback para bitrate do container
  const rawBitrate = Number(audioStream.bit_rate || formatObj.bit_rate || 0);
  const bitrate = Number.isFinite(rawBitrate) && rawBitrate > 0 ? rawBitrate : 0;

  const rawDuration = Number(audioStream.duration || formatObj.duration || 0);
  const durationSec = Number.isFinite(rawDuration) && rawDuration > 0
    ? Math.round(rawDuration * 100) / 100
    : 0;

  const mergedTags = {
    ...(audioStream.tags || {}),
    ...(formatObj.tags || {}),
  };

  // Busca case-insensitive para title e artist
  let title = null;
  let artist = null;
  for (const [k, v] of Object.entries(mergedTags)) {
    const keyLower = k.toLowerCase();
    const valStr = typeof v === 'string' ? v.trim() : '';
    if (!valStr) continue;
    if (keyLower === 'title' && !title) title = valStr;
    if (keyLower === 'artist' && !artist) artist = valStr;
  }

  return {
    codec: codecName,
    formatName,
    bitrate,
    durationSec,
    tags: {
      ...(title ? { title } : {}),
      ...(artist ? { artist } : {}),
    },
  };
}

/**
 * Decide a estratégia de processamento de áudio conforme especificação (Item 10):
 * 1. Se já for mp3 com bitrate <= 128k: apenas remux (`-vn -c:a copy`) mantendo `.mp3`.
 * 2. Se já for aac (m4a) com bitrate <= 128k: apenas remux (`-vn -c:a copy -movflags +faststart`) mantendo `.m4a`.
 * 3. Caso contrário: `-vn -c:a aac -b:a 128k -movflags +faststart`, saída `.m4a`.
 */
function decideAudioTranscodePlan(audioMeta) {
  const { codec, formatName, bitrate } = audioMeta;
  const isBitrateKnownAndLow = bitrate > 0 && bitrate <= MAX_COPY_BITRATE_BPS;

  // Ramo 1: MP3 <= 128 kbps
  if (codec === 'mp3' && isBitrateKnownAndLow) {
    return {
      mode: 'copy_mp3',
      outputExt: 'mp3',
      outputFormat: 'mp3',
      contentType: 'audio/mpeg',
      ffmpegArgs: ['-vn', '-c:a', 'copy'],
    };
  }

  // Ramo 2: AAC em container M4A/MP4 <= 128 kbps
  const isM4aContainer =
    formatName.includes('m4a') ||
    formatName.includes('mp4') ||
    formatName.includes('mov') ||
    formatName === '';
  if (codec === 'aac' && isM4aContainer && isBitrateKnownAndLow) {
    return {
      mode: 'copy_m4a',
      outputExt: 'm4a',
      outputFormat: 'm4a',
      contentType: 'audio/mp4',
      ffmpegArgs: ['-vn', '-c:a', 'copy', '-movflags', '+faststart'],
    };
  }

  // Ramo 3: Re-encode para AAC 128k em container M4A com faststart
  return {
    mode: 'transcode_aac_128k',
    outputExt: 'm4a',
    outputFormat: 'm4a',
    contentType: 'audio/mp4',
    ffmpegArgs: ['-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
  };
}

function runAudioFfmpeg(inputPath, outputPath, extraArgs) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputPath, ...extraArgs, outputPath];
    const proc = spawn('ffmpeg', args);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Falha ao iniciar ffmpeg para áudio: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg de áudio falhou com código ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function downloadForAudioWorker(storageClient, storageKey, fileId, tmpDir) {
  if (!storageClient.isValidFileId(fileId)) {
    throw new Error(`file_id inválido no worker de áudio: ${fileId}`);
  }
  const targetPath = path.join(tmpDir, `audio_in_${fileId}`);
  const { stream } = await storageClient.getStream(storageKey);
  const writer = fs.createWriteStream(targetPath);

  stream.pipe(writer);

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    writer.on('finish', () => resolve(targetPath));
    writer.on('error', reject);
  });
}

async function processAudioMessage(channel, msg, options = {}) {
  const tmpDir = path.resolve(options.tmpDir || process.env.TMP_DOWNLOADS || '/tmp/videos_download');
  const cleanTmp = ['1', 'true', 'yes'].includes((process.env.CLEAN_TMP || 'true').toLowerCase());
  const storageClient = options.storage || storage;
  const probeFn = options.probeFn || runFfprobe;
  const ffmpegFn = options.ffmpegFn || runAudioFfmpeg;

  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  let event = null;
  let downloadedFile = null;
  let outputFile = null;

  try {
    event = JSON.parse(msg.content.toString());
    const fileId = event.file_id || event.video_id;
    const rawStorageKey = event.storage_key || storageClient.rawKey(fileId);

    if (!storageClient.isValidFileId(fileId)) {
      throw new Error(`file_id inválido recebido em audio.uploaded: ${fileId}`);
    }

    console.log(`[process-audio] Processando áudio ${fileId} (${event.filename || 'unnamed'})...`);

    publishEvent(channel, EVENTS.AUDIO_PROCESSING, {
      file_id: fileId,
      type: 'audio',
      filename: event.filename || 'unnamed',
      storage_key: rawStorageKey,
      mime_type: event.mime_type || 'audio/mp4',
      original_size: event.original_size || 0,
      status: 'processing',
      result: null,
      error: null,
    });

    downloadedFile = await downloadForAudioWorker(storageClient, rawStorageKey, fileId, tmpDir);

    const probeData = await probeFn(downloadedFile);
    const audioMeta = extractAudioMetadata(probeData);
    const plan = decideAudioTranscodePlan(audioMeta);

    outputFile = path.join(tmpDir, `audio_out_${fileId}.${plan.outputExt}`);
    await ffmpegFn(downloadedFile, outputFile, plan.ffmpegArgs);

    const outStat = await fs.promises.stat(outputFile);
    const processedKey = storageClient.audioKey(fileId, plan.outputExt);

    await storageClient.put(processedKey, fs.createReadStream(outputFile), {
      contentType: plan.contentType,
      contentLength: outStat.size,
    });

    const mediaUrl = `/media/audio/${fileId}.${plan.outputExt}`;
    const resultObj = {
      url: mediaUrl,
      size: outStat.size,
      format: plan.outputFormat,
      duration_sec: audioMeta.durationSec,
      ...(Object.keys(audioMeta.tags).length > 0 ? { tags: audioMeta.tags } : {}),
    };

    const readyPayload = publishEvent(channel, EVENTS.AUDIO_READY, {
      file_id: fileId,
      type: 'audio',
      filename: event.filename || 'unnamed',
      storage_key: processedKey,
      mime_type: plan.contentType,
      original_size: event.original_size || 0,
      status: 'ready',
      result: resultObj,
      error: null,
    });

    // Apaga o raw do Filer após publicar audio.ready
    await storageClient.delete(rawStorageKey).catch((err) => {
      console.warn(`[process-audio] Aviso: falha ao remover raw ${rawStorageKey}:`, err.message);
    });

    console.log(
      `[process-audio] Áudio ${fileId} pronto em ${mediaUrl} (${plan.mode}, ${outStat.size} bytes, ${audioMeta.durationSec}s)`
    );

    channel.ack(msg);
    return { action: 'ready', plan, audioMeta, payload: readyPayload };
  } catch (error) {
    console.error(`[process-audio] Erro ao processar áudio ${event ? event.file_id : 'desconhecido'}:`, error.message);
    return handleWorkerRetryOrFail({
      channel,
      msg,
      event,
      type: 'audio',
      uploadEventName: EVENTS.AUDIO_UPLOADED,
      failedEventName: EVENTS.AUDIO_FAILED,
      error,
      serviceTag: 'process-audio',
    });
  } finally {
    if (cleanTmp) {
      if (downloadedFile && fs.existsSync(downloadedFile)) {
        await fs.promises.unlink(downloadedFile).catch(() => {});
      }
      if (outputFile && fs.existsSync(outputFile)) {
        await fs.promises.unlink(outputFile).catch(() => {});
      }
    }
  }
}

async function startAudioConsumer(channel, options = {}) {
  await channel.prefetch(1);
  console.log(`[process-audio] Worker (audio) aguardando eventos na fila ${EVENTS.AUDIO_UPLOADED}...`);

  await channel.consume(EVENTS.AUDIO_UPLOADED, async (msg) => {
    if (!msg) return;
    await processAudioMessage(channel, msg, options);
  });
}

module.exports = {
  MAX_COPY_BITRATE_BPS,
  extractAudioMetadata,
  decideAudioTranscodePlan,
  runAudioFfmpeg,
  processAudioMessage,
  startAudioConsumer,
};
