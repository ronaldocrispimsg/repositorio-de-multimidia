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

const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_SIZE_BYTES || 20 * 1024 * 1024);
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_SIZE_BYTES || 200 * 1024 * 1024);
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_SIZE_BYTES || 2 * 1024 * 1024 * 1024);
const MAX_UPLOAD_BYTES = Math.max(MAX_IMAGE_BYTES, MAX_AUDIO_BYTES, MAX_VIDEO_BYTES);

app.use(cors());
app.use(express.json());

const store = createStore();

let amqpChannel = null;

const path = require('path');

function guessInitialType(mimeType = '', filename = '') {
  const m = String(mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';

  const ext = path.posix.extname(String(filename || '')).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.oga', '.opus'].includes(ext)) return 'audio';
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) return 'video';

  return null;
}

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
            type: event.type !== undefined ? event.type : undefined,
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

function handleListFiles(req, res) {
  const { type, status } = req.query || {};
  res.json(store.list({ type, status }));
}

function handleGetFile(req, res) {
  const fileId = req.params.id || req.params.videoId;
  const item = store.get(fileId);
  if (!item) {
    return res.status(404).json({ detail: 'Arquivo não encontrado' });
  }
  res.json(item);
}

async function handleDownloadRawFile(req, res) {
  try {
    const fileId = req.params.id || req.params.videoId;
    const item = store.get(fileId);
    if (!item || !item.storage_key) {
      return res.status(404).json({ detail: 'Arquivo não encontrado' });
    }

    const { stream, status, headers } = await storage.getStream(item.storage_key, {
      validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
    });

    if (status === 404) {
      return res.status(410).json({ detail: 'Arquivo bruto indisponível' });
    }

    const safeName = storage.sanitizeFilename(item.filename || `${item.file_id}`);
    res.setHeader('Content-Type', item.mime_type || headers['content-type'] || 'application/octet-stream');
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
}

async function handleUploadFile(req, res) {
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
    const initialType = guessInitialType(mimeType, sanitizedFilename);

    const { item } = await store.upsert(fileId, {
      type: initialType,
      filename: sanitizedFilename,
      storage_key: storageKey,
      mime_type: mimeType,
      original_size: originalSize,
      status: 'uploaded',
      result: null,
      error: null,
      download_url: `/api/files/${fileId}/file`,
      occurred_at: occurredAt,
    });

    if (amqpChannel) {
      publishEvent(amqpChannel, EVENTS.FILE_UPLOADED, {
        file_id: fileId,
        type: initialType,
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
}

// Rotas principais (/files) e aliases de compatibilidade (/videos e /upload)
app.get('/files', handleListFiles);
app.get('/videos', handleListFiles);

app.get('/files/:id', handleGetFile);
app.get('/videos/:videoId', handleGetFile);

app.get('/files/:id/file', handleDownloadRawFile);
app.get('/videos/:videoId/file', handleDownloadRawFile);

app.post('/files', upload.single('file'), handleUploadFile);
app.post('/upload', upload.single('file'), handleUploadFile);

// Tratamento de erro do Multer (ex.: LIMIT_FILE_SIZE)
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Arquivo excede o limite máximo permitido no upload.' });
  }
  if (err) {
    console.error('[backend] Erro na requisição:', err.message);
    return res.status(500).json({ error: err.message });
  }
  next();
});

if (require.main === module) {
  setupRabbitMQ();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[backend] Servidor rodando na porta ${PORT}`);
    console.log(`[backend] Filer URL: ${storage.filerUrl}`);
    console.log(`[backend] Arquivo de estado: ${store.stateFile}`);
  });
}

module.exports = app;
