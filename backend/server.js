const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;
const RABBIT_URL = process.env.RABBIT_URL;
if (!RABBIT_URL) {
  console.error('[backend] Variável RABBIT_URL não definida. Copie .env.example para .env e configure.');
  process.exit(1);
}
const VIDEO_STORAGE = path.resolve(process.env.VIDEO_STORAGE || '/videos_raw');
const VIDEO_STATE_FILE = path.resolve(process.env.VIDEO_STATE_FILE || path.join(VIDEO_STORAGE, 'videos_state.json'));
const FILE_BASE_URL = (process.env.FILE_BASE_URL || 'http://backend:8000').replace(/\/+$/, '');

// Garante que o diretório de vídeos existe
if (!fs.existsSync(VIDEO_STORAGE)) {
  fs.mkdirSync(VIDEO_STORAGE, { recursive: true });
}

app.use(cors());
app.use(express.json());

// Estado em memória
let videoState = {};
let isSaving = false;
let pendingSave = false;

// Carregar estado salvo
function loadState() {
  if (fs.existsSync(VIDEO_STATE_FILE)) {
    try {
      const data = fs.readFileSync(VIDEO_STATE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') {
        videoState = parsed;
        console.log(`[backend] Estado carregado (${Object.keys(videoState).length} vídeos).`);
      }
    } catch (err) {
      console.error('[backend] Erro ao carregar arquivo de estado:', err);
    }
  }
}

// Salvar estado em disco de forma atômica
async function saveState() {
  if (isSaving) {
    pendingSave = true;
    return;
  }
  isSaving = true;
  try {
    const tmpFile = `${VIDEO_STATE_FILE}.tmp`;
    const payload = JSON.stringify(videoState, null, 2);
    await fs.promises.writeFile(tmpFile, payload, 'utf-8');
    await fs.promises.rename(tmpFile, VIDEO_STATE_FILE);
  } catch (err) {
    console.error('[backend] Erro ao salvar estado:', err);
  } finally {
    isSaving = false;
    if (pendingSave) {
      pendingSave = false;
      saveState();
    }
  }
}

async function updateVideo(videoId, payload) {
  const current = videoState[videoId] || {};
  Object.assign(current, payload);
  videoState[videoId] = current;
  await saveState();
  return current;
}

// Gerenciamento de conexão RabbitMQ
let amqpChannel = null;

async function setupRabbitMQ() {
  while (true) {
    try {
      console.log(`[backend] Conectando ao RabbitMQ em: ${RABBIT_URL}`);
      const connection = await amqp.connect(RABBIT_URL);
      const channel = await connection.createChannel();
      amqpChannel = channel;

      connection.on('error', (err) => {
        console.error('[backend] Erro na conexão RabbitMQ:', err.message);
      });
      connection.on('close', () => {
        console.warn('[backend] Conexão com RabbitMQ fechada. Reconectando em 5 segundos...');
        amqpChannel = null;
        setTimeout(setupRabbitMQ, 5000);
      });

      // Declara filas para eventos
      await channel.assertQueue('video.uploaded', { durable: true });
      await channel.assertQueue('video.processing', { durable: true });
      await channel.assertQueue('video.ready', { durable: true });

      // Consumir 'video.processing'
      await channel.consume('video.processing', async (msg) => {
        if (!msg) return;
        try {
          const event = JSON.parse(msg.content.toString());
          console.log(`[backend] Vídeo em processamento: ${event.video_id}`);
          await updateVideo(event.video_id, {
            status: event.status || 'processing'
          });
          channel.ack(msg);
        } catch (err) {
          console.error('[backend] Erro ao processar evento video.processing:', err);
          channel.ack(msg);
        }
      });

      // Consumir 'video.ready'
      await channel.consume('video.ready', async (msg) => {
        if (!msg) return;
        try {
          const event = JSON.parse(msg.content.toString());
          console.log(`[backend] Vídeo pronto:`, event);
          await updateVideo(event.video_id, {
            status: event.status || 'ready',
            stream_url: event.stream_url
          });
          channel.ack(msg);
        } catch (err) {
          console.error('[backend] Erro ao processar evento video.ready:', err);
          channel.ack(msg);
        }
      });

      console.log('[backend] Conectado e ouvindo filas do RabbitMQ com sucesso.');
      break;
    } catch (err) {
      console.error('[backend] Falha ao conectar no RabbitMQ. Tentando novamente em 5 segundos...', err.message);
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

// Configuração do Multer com stream direto para disco
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, VIDEO_STORAGE);
  },
  filename: (req, file, cb) => {
    const videoId = `${uuidv4()}_${file.originalname}`;
    cb(null, videoId);
  }
});
const upload = multer({ storage });

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Listar todos os vídeos
app.get('/videos', (req, res) => {
  res.json(Object.values(videoState));
});

// Detalhes de um vídeo
app.get('/videos/:videoId', (req, res) => {
  const video = videoState[req.params.videoId];
  if (!video) {
    return res.status(404).json({ detail: 'Vídeo não encontrado' });
  }
  res.json(video);
});

// Download do vídeo bruto
app.get('/videos/:videoId/file', (req, res) => {
  const video = videoState[req.params.videoId];
  if (!video) {
    return res.status(404).json({ detail: 'Vídeo não encontrado' });
  }
  const filePath = video.path;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ detail: 'Arquivo indisponível' });
  }
  const filename = video.filename || path.basename(filePath);
  res.download(filePath, filename);
});

// Upload de vídeo
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const videoId = req.file.filename;
    const filePath = req.file.path;
    const downloadUrl = `${FILE_BASE_URL}/videos/${videoId}/file`;

    const payload = {
      video_id: videoId,
      path: filePath,
      download_url: downloadUrl
    };

    if (amqpChannel) {
      amqpChannel.sendToQueue(
        'video.uploaded',
        Buffer.from(JSON.stringify(payload)),
        { persistent: true }
      );
    } else {
      console.warn('[backend] Canal RabbitMQ indisponível no momento do upload.');
    }

    const updated = await updateVideo(videoId, {
      video_id: videoId,
      filename: req.file.originalname,
      path: filePath,
      status: 'uploaded',
      download_url: downloadUrl
    });

    res.json(updated);
  } catch (error) {
    console.error('[backend] Erro no upload:', error);
    res.status(500).json({ error: error.message });
  }
});

// Inicialização
loadState();
setupRabbitMQ();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[backend] Servidor rodando na porta ${PORT}`);
  console.log(`[backend] Armazenamento de vídeos: ${VIDEO_STORAGE}`);
  console.log(`[backend] Arquivo de estado: ${VIDEO_STATE_FILE}`);
  console.log(`[backend] URL base de download: ${FILE_BASE_URL}`);
});
