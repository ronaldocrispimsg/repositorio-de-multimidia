const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const amqp = require('amqplib');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const RABBIT_URL = process.env.RABBIT_URL;
if (!RABBIT_URL) {
  console.error('[process] Variável RABBIT_URL não definida. Copie .env.example para .env e configure.');
  process.exit(1);
}
const TMP_HLS = path.resolve(process.env.TMP_HLS || '/tmp/hls');
const TMP_DOWNLOADS = path.resolve(process.env.TMP_DOWNLOADS || '/tmp/videos_download');
const EXPORT_PATH = path.resolve(process.env.EXPORT_PATH || '/srv/videobox/export');
const REPO_STREAM_URL = (process.env.REPO_STREAM_URL || 'http://repository:8001').replace(/\/+$/, '');
const CLEAN_TMP = ['1', 'true', 'yes'].includes((process.env.CLEAN_TMP || 'true').toLowerCase());

// Garante que os diretórios necessários existem
[TMP_HLS, TMP_DOWNLOADS, EXPORT_PATH].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Helper para varrer diretórios recursivamente
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

// Download do arquivo de vídeo a partir do backend
async function downloadFromBackend(downloadUrl, videoId) {
  const targetPath = path.join(TMP_DOWNLOADS, videoId);
  const safeUrl = downloadUrl
    .replace('localhost:8000', 'backend:8000')
    .replace('127.0.0.1:8000', 'backend:8000');

  console.log(`[process] Baixando vídeo de ${safeUrl} para ${targetPath}...`);
  const writer = fs.createWriteStream(targetPath);

  const response = await axios({
    url: safeUrl,
    method: 'GET',
    responseType: 'stream'
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(targetPath));
    writer.on('error', reject);
  });
}

// Execução do FFmpeg para conversão HLS
function runFFmpeg(sourcePath, playlistPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', sourcePath,
      '-codec:v', 'h264',
      '-codec:a', 'aac',
      '-start_number', '0',
      '-hls_time', '4',
      '-hls_list_size', '0',
      '-f', 'hls',
      playlistPath
    ];

    console.log(`[process] Iniciando transcode REAL com FFmpeg: ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args);

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[process] Transcode FINALIZADO com sucesso.');
        resolve();
      } else {
        console.error('[process] ERRO NO FFMPEG:', stderr);
        reject(new Error(`FFmpeg finalizou com código de erro ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// Upload dos artefatos HLS para o serviço de repositório de streams
async function uploadToRepo(videoId, sourceDir, playlistName) {
  const segmentsUrl = `${REPO_STREAM_URL}/videos/${videoId}/segments`;
  const completeUrl = `${REPO_STREAM_URL}/videos/${videoId}/complete`;

  console.log(`[process] Enviando segmentos para ${segmentsUrl}...`);
  for await (const filePath of getFiles(sourceDir)) {
    const relativePath = path.relative(sourceDir, filePath);
    const form = new FormData();
    form.append('relative_path', relativePath);
    form.append('file', fs.createReadStream(filePath), {
      filename: path.basename(filePath),
      contentType: 'application/octet-stream'
    });

    const res = await axios.post(segmentsUrl, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    if (res.status !== 200) {
      throw new Error(`Falha ao enviar segmento ${relativePath}: status ${res.status}`);
    }
  }

  console.log(`[process] Finalizando upload no repositório...`);
  const completeRes = await axios.post(completeUrl, {
    playlist_name: playlistName
  });

  if (completeRes.status !== 200 || !completeRes.data || !completeRes.data.stream_url) {
    throw new Error(`Falha ao finalizar no repositório: status ${completeRes.status}`);
  }

  return completeRes.data.stream_url;
}

// Conexão e processamento de eventos do RabbitMQ
async function startWorker() {
  while (true) {
    try {
      console.log(`[process] Conectando ao RabbitMQ em: ${RABBIT_URL}`);
      const connection = await amqp.connect(RABBIT_URL);
      const channel = await connection.createChannel();

      connection.on('error', (err) => {
        console.error('[process] Erro na conexão RabbitMQ:', err.message);
      });
      connection.on('close', () => {
        console.warn('[process] Conexão com RabbitMQ fechada. Reconectando em 5 segundos...');
        setTimeout(startWorker, 5000);
      });

      await channel.assertQueue('video.uploaded', { durable: true });
      await channel.assertQueue('video.processing', { durable: true });
      await channel.assertQueue('video.ready', { durable: true });

      // Processar 1 vídeo por vez
      await channel.prefetch(1);

      console.log('[process] Worker aguardando eventos na fila video.uploaded...');

      channel.consume('video.uploaded', async (msg) => {
        if (!msg) return;

        let event = null;
        let downloadedFile = null;
        let videoTempDir = null;
        let exportVideoDir = null;

        try {
          event = JSON.parse(msg.content.toString());
          const { video_id: videoId, download_url: downloadUrl, path: sourcePath } = event;
          console.log(`[process] Vídeo recebido: ${videoId}`);

          let finalSourcePath = null;
          if (downloadUrl) {
            finalSourcePath = await downloadFromBackend(downloadUrl, videoId);
            downloadedFile = finalSourcePath;
            console.log(`[process] Download concluído em ${finalSourcePath}`);
          } else if (sourcePath && fs.existsSync(sourcePath)) {
            finalSourcePath = sourcePath;
          } else {
            throw new Error(`Caminho inválido e sem URL de download para ${videoId}`);
          }

          // Notificar que o processamento iniciou
          channel.sendToQueue(
            'video.processing',
            Buffer.from(JSON.stringify({ video_id: videoId, status: 'processing' })),
            { persistent: true }
          );

          videoTempDir = path.join(TMP_HLS, videoId);
          await fs.promises.mkdir(videoTempDir, { recursive: true });

          const playlistName = 'playlist.m3u8';
          const playlistPath = path.join(videoTempDir, playlistName);

          // Executa transcode
          await runFFmpeg(finalSourcePath, playlistPath);

          // Copia para pasta de export
          exportVideoDir = path.join(EXPORT_PATH, videoId);
          if (fs.existsSync(exportVideoDir)) {
            await fs.promises.rm(exportVideoDir, { recursive: true, force: true });
          }
          await fs.promises.cp(videoTempDir, exportVideoDir, { recursive: true });

          // Upload para o repo_stream
          const streamUrl = await uploadToRepo(videoId, exportVideoDir, playlistName);
          console.log(`[process] Arquivos enviados para repo_stream. URL: ${streamUrl}`);

          // Notificar conclusão
          channel.sendToQueue(
            'video.ready',
            Buffer.from(JSON.stringify({ video_id: videoId, status: 'ready', stream_url: streamUrl })),
            { persistent: true }
          );

          // Limpeza temporária
          if (CLEAN_TMP) {
            if (videoTempDir && fs.existsSync(videoTempDir)) {
              await fs.promises.rm(videoTempDir, { recursive: true, force: true });
            }
            if (exportVideoDir && fs.existsSync(exportVideoDir)) {
              await fs.promises.rm(exportVideoDir, { recursive: true, force: true });
            }
            if (downloadedFile && fs.existsSync(downloadedFile)) {
              await fs.promises.unlink(downloadedFile);
            }
          }

          channel.ack(msg);
        } catch (error) {
          console.error(`[process] Erro no processamento do vídeo ${event ? event.video_id : 'desconhecido'}:`, error);
          // Acknowledge para não prender a fila em loop infinito de falha
          channel.ack(msg);
        }
      });

      break;
    } catch (err) {
      console.error('[process] Falha ao conectar no RabbitMQ. Tentando novamente em 5 segundos...', err.message);
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

startWorker();
