const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const storage = require('../shared/storage');

const app = express();
const PORT = process.env.PORT || 8001;

app.use(cors());
app.use(express.json());

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function guessStreamContentType(filePath) {
  const ext = path.posix.extname(filePath).toLowerCase();
  if (ext === '.m3u8') return 'application/vnd.apple.mpegurl';
  if (ext === '.ts') return 'video/mp2t';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.mp3') return 'audio/mpeg';
  return 'application/octet-stream';
}

// Servir arquivos de streaming HLS (/streams/:videoId/*) direto do SeaweedFS Filer
app.get('/streams/:videoId/*', async (req, res) => {
  try {
    const { videoId } = req.params;
    const relativePath = req.params[0] || '';

    let storageKey;
    try {
      storageKey = storage.videoKey(videoId, relativePath);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { stream, status, headers } = await storage.getStream(storageKey, {
      validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
    });

    if (status === 404) {
      return res.status(404).json({ detail: 'Segmento ou playlist não encontrado' });
    }

    res.setHeader('Content-Type', guessStreamContentType(relativePath) || headers['content-type']);
    if (headers['content-length']) {
      res.setHeader('Content-Length', headers['content-length']);
    }
    if (relativePath.endsWith('.ts') || relativePath.endsWith('.jpg') || relativePath.endsWith('.webp')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }

    stream.on('error', (err) => {
      console.error('[repository] Erro ao transmitir stream do filer:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Falha ao ler stream no storage.' });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error('[repository] Erro em GET /streams:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Servir mídias processadas de imagem e áudio (/media/images/* e /media/audio/*) direto do SeaweedFS Filer
app.get('/media/*', async (req, res) => {
  try {
    const relativePath = req.params[0] || '';
    let storageKey;
    try {
      storageKey = storage.resolveSafeKey('processed', relativePath);
      if (!storageKey.startsWith('processed/images/') && !storageKey.startsWith('processed/audio/')) {
        return res.status(400).json({ error: 'Caminho de mídia fora dos prefixos permitidos (images/, audio/).' });
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const requestHeaders = {};
    if (req.headers.range) {
      requestHeaders.Range = req.headers.range;
    }

    const { stream, status, headers } = await storage.getStream(storageKey, {
      headers: requestHeaders,
      validateStatus: (s) => (s >= 200 && s < 300) || s === 206 || s === 404 || s === 416,
    });

    if (status === 404) {
      return res.status(404).json({ detail: 'Mídia não encontrada' });
    }

    if (status === 416) {
      if (headers['content-range']) {
        res.setHeader('Content-Range', headers['content-range']);
      }
      return res.status(416).end();
    }

    res.status(status);
    res.setHeader('Content-Type', guessStreamContentType(relativePath) || headers['content-type']);
    res.setHeader('Accept-Ranges', headers['accept-ranges'] || 'bytes');
    if (headers['content-length']) {
      res.setHeader('Content-Length', headers['content-length']);
    }
    if (headers['content-range']) {
      res.setHeader('Content-Range', headers['content-range']);
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    stream.on('error', (err) => {
      console.error('[repository] Erro ao transmitir mídia do filer:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Falha ao ler mídia no storage.' });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error('[repository] Erro em GET /media:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Multer para rota de compatibilidade de upload de segmentos HLS
const upload = multer({ storage: multer.memoryStorage() });

// Endpoint legado/transição: Receber segmento individual (.ts ou .m3u8) e gravar no Filer
app.post('/videos/:videoId/segments', upload.single('file'), async (req, res) => {
  try {
    const { videoId } = req.params;
    const rawRelPath = req.body.relative_path || (req.file ? req.file.originalname : '');

    if (!req.file || !rawRelPath) {
      return res.status(400).json({ error: 'Arquivo ou caminho relativo inválido.' });
    }

    let storageKey;
    try {
      storageKey = storage.videoKey(videoId, rawRelPath);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    await storage.put(storageKey, req.file.buffer, {
      contentType: guessStreamContentType(rawRelPath),
      contentLength: req.file.buffer.length,
    });

    return res.json({ status: 'stored', storage_key: storageKey });
  } catch (error) {
    console.error('[repository] Erro ao salvar segmento no filer:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Endpoint legado/transição: Finalizar upload e obter URL relativa da playlist
app.post('/videos/:videoId/complete', async (req, res) => {
  try {
    const { videoId } = req.params;
    const playlistName = req.body.playlist_name || 'playlist.m3u8';

    let storageKey;
    try {
      storageKey = storage.videoKey(videoId, playlistName);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const headInfo = await storage.head(storageKey);
    if (!headInfo.exists) {
      return res.status(400).json({ detail: 'Playlist não encontrada' });
    }

    const streamUrl = `/streams/${videoId}/${playlistName}`;
    return res.json({ stream_url: streamUrl });
  } catch (error) {
    console.error('[repository] Erro ao finalizar stream:', error);
    return res.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[repository] Servidor rodando na porta ${PORT}`);
    console.log(`[repository] Filer URL: ${storage.filerUrl}`);
  });
}

module.exports = app;
