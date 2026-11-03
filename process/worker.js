const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const amqp = require('amqplib');
require('dotenv').config();

const storage = require('./storage');
const { startRouterConsumer } = require('./router');
const { startImageConsumer } = require('./image');
const {
  EVENTS,
  setupTopology,
  publishEvent,
  handleWorkerRetryOrFail,
} = require('../shared/events');

const RABBIT_URL = process.env.RABBIT_URL;
if (!RABBIT_URL) {
  console.error('[process] Variável RABBIT_URL não definida. Copie .env.example para .env e configure.');
  process.exit(1);
}

const WORKER_TYPE = (process.env.WORKER_TYPE || 'video').toLowerCase();
const TMP_HLS = path.resolve(process.env.TMP_HLS || '/tmp/hls');
const TMP_DOWNLOADS = path.resolve(process.env.TMP_DOWNLOADS || '/tmp/videos_download');
const CLEAN_TMP = ['1', 'true', 'yes'].includes((process.env.CLEAN_TMP || 'true').toLowerCase());

[TMP_HLS, TMP_DOWNLOADS].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

async function* getFiles(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* getFiles(fullPath);
    } else {
      yield fullPath;
    }
  }
}

async function downloadFromFiler(storageKey, fileId) {
  if (!storage.isValidFileId(fileId)) {
    throw new Error(`file_id inválido: ${fileId}`);
  }
  const targetPath = path.join(TMP_DOWNLOADS, fileId);
  console.log(`[process] Baixando raw do filer (${storageKey}) para ${targetPath}...`);

  const { stream } = await storage.getStream(storageKey);
  const writer = fs.createWriteStream(targetPath);

  stream.pipe(writer);

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    writer.on('finish', () => resolve(targetPath));
    writer.on('error', reject);
  });
}

function runFFmpeg(sourcePath, playlistPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', sourcePath,
      '-codec:v', 'h264',
      '-codec:a', 'aac',
      '-start_number', '0',
      '-hls_time', '4',
      '-hls_list_size', '0',
      '-f', 'hls',
      playlistPath,
    ];

    console.log(`[process] Iniciando transcode HLS com FFmpeg para ${path.basename(path.dirname(playlistPath))}...`);
    const proc = spawn('ffmpeg', args);

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[process] Transcode HLS finalizado com sucesso.');
        resolve();
      } else {
        console.error('[process] Erro no FFmpeg:', stderr);
        reject(new Error(`FFmpeg finalizou com código de erro ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function uploadHlsToFiler(fileId, sourceDir, playlistName) {
  let totalSize = 0;

  console.log(`[process] Enviando artefatos HLS de ${fileId} para o filer...`);
  for await (const filePath of getFiles(sourceDir)) {
    const relativePath = path.posix.normalize(path.relative(sourceDir, filePath).split(path.sep).join('/'));
    const stat = await fs.promises.stat(filePath);
    totalSize += stat.size;

    const targetKey = storage.videoKey(fileId, relativePath);
    const contentType = relativePath.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : relativePath.endsWith('.ts')
        ? 'video/mp2t'
        : 'application/octet-stream';

    await storage.put(targetKey, fs.createReadStream(filePath), {
      contentType,
      contentLength: stat.size,
    });
  }

  return {
    streamUrl: `/streams/${fileId}/${playlistName}`,
    totalSize,
  };
}

async function startVideoConsumer(channel) {
  await channel.prefetch(1);
  console.log(`[process] Worker (video) aguardando eventos na fila ${EVENTS.VIDEO_UPLOADED}...`);

  await channel.consume(EVENTS.VIDEO_UPLOADED, async (msg) => {
    if (!msg) return;

    let event = null;
    let downloadedFile = null;
    let videoTempDir = null;

    try {
      event = JSON.parse(msg.content.toString());
      const fileId = event.file_id || event.video_id;
      const storageKey = event.storage_key || storage.rawKey(fileId);

      if (!storage.isValidFileId(fileId)) {
        throw new Error(`file_id inválido recebido em video.uploaded: ${fileId}`);
      }

      console.log(`[process] Vídeo recebido: ${fileId} (${event.filename || 'unnamed'})`);

      publishEvent(channel, EVENTS.VIDEO_PROCESSING, {
        file_id: fileId,
        type: 'video',
        filename: event.filename || 'unnamed',
        storage_key: storageKey,
        mime_type: event.mime_type || 'video/mp4',
        original_size: event.original_size || 0,
        status: 'processing',
        result: null,
        error: null,
      });

      downloadedFile = await downloadFromFiler(storageKey, fileId);

      videoTempDir = path.join(TMP_HLS, fileId);
      if (fs.existsSync(videoTempDir)) {
        await fs.promises.rm(videoTempDir, { recursive: true, force: true });
      }
      await fs.promises.mkdir(videoTempDir, { recursive: true });

      const playlistName = 'playlist.m3u8';
      const playlistPath = path.join(videoTempDir, playlistName);

      await runFFmpeg(downloadedFile, playlistPath);

      const { streamUrl, totalSize } = await uploadHlsToFiler(fileId, videoTempDir, playlistName);
      console.log(`[process] HLS disponível em ${streamUrl} (${totalSize} bytes)`);

      publishEvent(channel, EVENTS.VIDEO_READY, {
        file_id: fileId,
        type: 'video',
        filename: event.filename || 'unnamed',
        storage_key: storageKey,
        mime_type: event.mime_type || 'video/mp4',
        original_size: event.original_size || 0,
        status: 'ready',
        result: {
          url: streamUrl,
          size: totalSize,
          format: 'hls',
        },
        error: null,
      });

      channel.ack(msg);
    } catch (error) {
      await handleWorkerRetryOrFail({
        channel,
        msg,
        event,
        type: 'video',
        uploadEventName: EVENTS.VIDEO_UPLOADED,
        failedEventName: EVENTS.VIDEO_FAILED,
        error,
        serviceTag: 'process',
      });
    } finally {
      if (CLEAN_TMP) {
        if (videoTempDir && fs.existsSync(videoTempDir)) {
          await fs.promises.rm(videoTempDir, { recursive: true, force: true }).catch(() => {});
        }
        if (downloadedFile && fs.existsSync(downloadedFile)) {
          await fs.promises.unlink(downloadedFile).catch(() => {});
        }
      }
    }
  });
}

async function startWorker() {
  while (true) {
    try {
      console.log(`[process] Conectando ao RabbitMQ (WORKER_TYPE=${WORKER_TYPE})...`);
      const connection = await amqp.connect(RABBIT_URL);
      const channel = await connection.createChannel();

      connection.on('error', (err) => {
        console.error('[process] Erro na conexão RabbitMQ:', err.message);
      });
      connection.on('close', () => {
        console.warn('[process] Conexão com RabbitMQ fechada. Reconectando em 5 segundos...');
        setTimeout(startWorker, 5000);
      });

      await setupTopology(channel);

      if (WORKER_TYPE === 'router') {
        await startRouterConsumer(channel);
      } else if (WORKER_TYPE === 'video') {
        await startVideoConsumer(channel);
      } else if (WORKER_TYPE === 'image') {
        await startImageConsumer(channel);
      } else {
        throw new Error(`WORKER_TYPE desconhecido ou ainda não habilitado nesta fase: ${WORKER_TYPE}`);
      }

      break;
    } catch (err) {
      console.error('[process] Falha ao iniciar worker. Tentando novamente em 5 segundos...', err.message);
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

if (require.main === module) {
  startWorker();
}

module.exports = {
  downloadFromFiler,
  runFFmpeg,
  uploadHlsToFiler,
  startVideoConsumer,
};
