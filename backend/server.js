const express = require('express');
const cors = require('cors');
const multer = require('multer');
const amqp = require('amqplib');
const { PassThrough } = require('stream');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const { createStore } = require('./store');
const storage = require('./storage');
const {
  EVENTS,
  QUEUE_BACKEND,
  setupTopology,
  publishEvent,
} = require('../shared/events');

const app = express();
const PORT = process.env.PORT || 8000;
const RABBIT_URL = process.env.RABBIT_URL;
if (!RABBIT_URL) {
  console.error('[backend] Variável RABBIT_URL não definida. Copie .env.example para .env e configure.');
  process.exit(1);
}

const MAX_UPLOAD_BYTES = Number(process.env.MAX_VIDEO_SIZE_BYTES || 2 * 1024 * 1024 * 1024); // 2 GB padrão

app.use(cors());
app.use(express.json());

const store = createStore();

let amqpChannel = null;

async function setupRabbitMQ() {
  while (true) {
    try {
      console.log('[backend] Conectando ao RabbitMQ...');
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

      await setupTopology(channel);

      await channel.consume(QUEUE_BACKEND, async (msg) => {
        if (!msg) return;
        try {
          const event = JSON.parse(msg.content.toString());
          const fileId = event.file_id || event.video_id;
          if (!fileId) {
            console.warn('[backend] Evento recebido sem file_id:', event);
            channel.ack(msg);
            return;
          }

          console.log(`[backend] Evento recebido (${msg.fields.routingKey}): ${fileId} -> ${event.status}`);

          await store.upsert(fileId, {
            type: event.type || 'video',
            filename: event.filename,
            storage_key: event.storage_key,
            mime_type: event.mime_type,
            original_size: event.original_size,
            status: event.status,
            result: event.result !== undefined ? event.result : undefined,
            error: event.error !== undefined ? event.error : undefined,
            occurred_at: event.occurred_at,
          });

          channel.ack(msg);
        } catch (err) {
          console.error('[backend] Erro ao processar evento em media.backend:', err);
          channel.ack(msg);
        }
      });

      console.log('[backend] Conectado e ouvindo fila media.backend no RabbitMQ.');
      break;
    } catch (err) {
      console.error('[backend] Falha ao conectar no RabbitMQ. Tentando novamente em 5 segundos...', err.message);
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

// Storage engine do Multer que faz streaming direto para o SeaweedFS Filer sem carregar em memória
const filerMulterStorage = {
  _handleFile(req, file, cb) {
    const fileId = uuidv4();
    const sanitizedName = storage.sanitizeFilename(file.originalname);
    const storageKey = storage.rawKey(fileId);
    const pass = new PassThrough();
    let bytesWritten = 0;

    file.stream.on('data', (chunk) => {
      bytesWritten += chunk.length;
    });

    file.stream.on('error', (err) => {
      pass.destroy(err);
    });

    file.stream.pipe(pass);

    storage
      .put(storageKey, pass, {
        contentType: file.mimetype || 'application/octet-stream',
      })
      .then(() => {
        cb(null, {
          fileId,
          sanitizedFilename: sanitizedName,
          storageKey,
          size: bytesWritten,
          mimetype: file.mimetype || 'application/octet-stream',
        });
      })
      .catch(async (err) => {
        try {
          await storage.delete(storageKey);
        } catch (_) {
          // Ignora falha na limpeza de objeto parcial
        }
        cb(err);
      });
  },

  _removeFile(req, file, cb) {
    if (!file || !file.storageKey) {
      return cb(null);
    }
    storage
      .delete(file.storageKey)
      .then(() => cb(null))
      .catch((err) => cb(err));
  },
};

const upload = multer({
  storage: filerMulterStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Listar todos os vídeos (e alias para itens de mídia)
app.get('/videos', (req, res) => {
  res.json(store.list());
});

// Detalhes de um vídeo
app.get('/videos/:videoId', (req, res) => {
  const video = store.get(req.params.videoId);
  if (!video) {
    return res.status(404).json({ detail: 'Vídeo não encontrado' });
  }
  res.json(video);
});

// Download do arquivo bruto direto do Filer em streaming
app.get('/videos/:videoId/file', async (req, res) => {
  try {
    const video = store.get(req.params.videoId);
    if (!video || !video.storage_key) {
      return res.status(404).json({ detail: 'Vídeo não encontrado' });
    }

    const { stream, status, headers } = await storage.getStream(video.storage_key, {
      validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
    });

    if (status === 404) {
      return res.status(410).json({ detail: 'Arquivo indisponível' });
    }

    const safeName = storage.sanitizeFilename(video.filename || `${video.file_id}.mp4`);
    res.setHeader('Content-Type', video.mime_type || headers['content-type'] || 'application/octet-stream');
    if (headers['content-length']) {
      res.setHeader('Content-Length', headers['content-length']);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${safeName.replace(/"/g, '_')}"`);

    stream.on('error', (err) => {
      console.error('[backend] Erro no stream de download:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Erro ao ler arquivo do storage.' });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  } catch (err) {
    console.error('[backend] Erro ao baixar arquivo bruto:', err.message);
    res.status(500).json({ error: 'Falha ao buscar arquivo no storage.' });
  }
});

// Upload de vídeo (Fase 1: publica video.uploaded com payload padrão e grava raw no Filer)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const {
      fileId,
      sanitizedFilename,
      storageKey,
      size: originalSize,
      mimetype: mimeType,
    } = req.file;

    const occurredAt = new Date().toISOString();

    const { item } = await store.upsert(fileId, {
      type: 'video',
      filename: sanitizedFilename,
      storage_key: storageKey,
      mime_type: mimeType,
      original_size: originalSize,
      status: 'uploaded',
      result: null,
      error: null,
      download_url: `/api/videos/${fileId}/file`,
      occurred_at: occurredAt,
    });

    if (amqpChannel) {
      publishEvent(amqpChannel, EVENTS.VIDEO_UPLOADED, {
        file_id: fileId,
        type: 'video',
        filename: sanitizedFilename,
        storage_key: storageKey,
        mime_type: mimeType,
        original_size: originalSize,
        occurred_at: occurredAt,
        status: 'uploaded',
        result: null,
        error: null,
      });
    } else {
      console.warn('[backend] Canal RabbitMQ indisponível no momento do upload.');
    }

    res.json(item);
  } catch (error) {
    console.error('[backend] Erro no upload:', error);
    res.status(500).json({ error: error.message });
  }
});

setupRabbitMQ();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[backend] Servidor rodando na porta ${PORT}`);
  console.log(`[backend] Filer URL: ${storage.filerUrl}`);
  console.log(`[backend] Arquivo de estado: ${store.stateFile}`);
});
