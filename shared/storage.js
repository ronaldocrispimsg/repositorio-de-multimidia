const path = require('path');

function resolveAxios() {
  const searchPaths = [
    process.cwd(),
    __dirname,
    path.join(__dirname, '../backend'),
    path.join(__dirname, '../process'),
    path.join(__dirname, '../repository'),
  ];
  const resolved = require.resolve('axios', { paths: searchPaths });
  return require(resolved);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidFileId(fileId) {
  return typeof fileId === 'string' && UUID_REGEX.test(fileId);
}

function sanitizeFilename(rawName) {
  if (!rawName || typeof rawName !== 'string') {
    return 'unnamed';
  }
  const normalizedSeparators = rawName.replace(/\\/g, '/');
  const base = path.posix.basename(normalizedSeparators);
  const cleaned = base
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();

  if (!cleaned) {
    return 'unnamed';
  }

  if (cleaned.length <= 200) {
    return cleaned;
  }

  const ext = path.posix.extname(cleaned).slice(0, 20);
  const stem = path.posix.basename(cleaned, ext).slice(0, 200 - ext.length);
  return `${stem}${ext}`;
}

function resolveSafeKey(basePrefix, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Caminho relativo vazio ou inválido.');
  }
  if (relativePath.includes('\0') || relativePath.includes('\\')) {
    throw new Error('Caminho relativo contém caracteres proibidos.');
  }

  const cleanBase = '/' + String(basePrefix || '').replace(/^\/+|\/+$/g, '');
  const cleanRel = relativePath.replace(/^\/+/, '');
  const resolved = path.posix.resolve(cleanBase, cleanRel);

  if (resolved === cleanBase || !resolved.startsWith(cleanBase + '/')) {
    throw new Error(`Caminho fora do prefixo permitido (${cleanBase}): ${relativePath}`);
  }

  return resolved.slice(1);
}

function normalizeStorageKey(storageKey) {
  if (typeof storageKey !== 'string' || !storageKey.trim()) {
    throw new Error('storage_key vazia ou inválida.');
  }
  if (storageKey.includes('\0') || storageKey.includes('\\')) {
    throw new Error('storage_key contém caracteres proibidos.');
  }

  const resolved = path.posix.resolve('/', storageKey.replace(/^\/+/, ''));
  const allowedPrefixes = ['/raw/', '/processed/'];
  if (!allowedPrefixes.some((prefix) => resolved.startsWith(prefix))) {
    throw new Error(`storage_key fora dos prefixos permitidos (raw/, processed/): ${storageKey}`);
  }

  return resolved.slice(1);
}

function rawKey(fileId) {
  if (!isValidFileId(fileId)) {
    throw new Error(`file_id inválido para chave raw: ${fileId}`);
  }
  return `raw/${fileId}/original`;
}

function videoKey(fileId, relativePath) {
  if (!isValidFileId(fileId)) {
    throw new Error(`file_id inválido para chave de vídeo: ${fileId}`);
  }
  return resolveSafeKey(`processed/videos/${fileId}`, relativePath);
}

function imageKey(fileId) {
  if (!isValidFileId(fileId)) {
    throw new Error(`file_id inválido para chave de imagem: ${fileId}`);
  }
  return `processed/images/${fileId}.webp`;
}

function audioKey(fileId, ext = 'm4a') {
  if (!isValidFileId(fileId)) {
    throw new Error(`file_id inválido para chave de áudio: ${fileId}`);
  }
  const cleanExt = String(ext).replace(/^\.+/, '').toLowerCase();
  if (!['m4a', 'mp3'].includes(cleanExt)) {
    throw new Error(`Extensão de áudio não suportada: ${ext}`);
  }
  return `processed/audio/${fileId}.${cleanExt}`;
}

function createStorage(options = {}) {
  const filerUrl = (options.filerUrl || process.env.FILER_URL || 'http://filer:8888').replace(/\/+$/, '');
  const httpClient = options.httpClient || resolveAxios();

  function buildFilerUrl(storageKey) {
    const normalized = normalizeStorageKey(storageKey);
    const encodedSegments = normalized.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    return {
      normalizedKey: normalized,
      url: `${filerUrl}/${encodedSegments}`,
    };
  }

  async function put(storageKey, bodyOrStream, putOptions = {}) {
    const { normalizedKey, url } = buildFilerUrl(storageKey);
    const headers = {
      'Content-Type': putOptions.contentType || 'application/octet-stream',
      ...(putOptions.headers || {}),
    };
    if (putOptions.contentLength !== undefined && putOptions.contentLength !== null) {
      headers['Content-Length'] = String(putOptions.contentLength);
    }

    const response = await httpClient({
      method: 'PUT',
      url,
      data: bodyOrStream,
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    return {
      storage_key: normalizedKey,
      status: response.status,
      data: response.data,
    };
  }

  async function get(storageKey, getOptions = {}) {
    const { normalizedKey, url } = buildFilerUrl(storageKey);
    const response = await httpClient({
      method: 'GET',
      url,
      responseType: getOptions.responseType || 'arraybuffer',
      headers: getOptions.headers || {},
      validateStatus: getOptions.validateStatus || ((status) => status >= 200 && status < 300),
    });

    const data = Buffer.isBuffer(response.data)
      ? response.data
      : response.data instanceof ArrayBuffer || ArrayBuffer.isView(response.data)
        ? Buffer.from(response.data)
        : response.data;

    return {
      storage_key: normalizedKey,
      status: response.status,
      headers: response.headers,
      data,
    };
  }

  async function getStream(storageKey, getOptions = {}) {
    const { normalizedKey, url } = buildFilerUrl(storageKey);
    const response = await httpClient({
      method: 'GET',
      url,
      responseType: 'stream',
      headers: getOptions.headers || {},
      validateStatus: getOptions.validateStatus || ((status) => status >= 200 && status < 300),
    });

    return {
      storage_key: normalizedKey,
      status: response.status,
      headers: response.headers,
      stream: response.data,
    };
  }

  async function head(storageKey) {
    const { normalizedKey, url } = buildFilerUrl(storageKey);
    const response = await httpClient({
      method: 'HEAD',
      url,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
    });

    return {
      storage_key: normalizedKey,
      exists: response.status !== 404,
      status: response.status,
      headers: response.headers || {},
      size: response.headers && response.headers['content-length']
        ? Number(response.headers['content-length'])
        : null,
      contentType: (response.headers && response.headers['content-type']) || null,
    };
  }

  async function remove(storageKey, removeOptions = {}) {
    const { normalizedKey, url } = buildFilerUrl(storageKey);
    const query = removeOptions.recursive
      ? '?recursive=true&ignoreRecursiveError=true'
      : '';

    const response = await httpClient({
      method: 'DELETE',
      url: `${url}${query}`,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
    });

    return {
      storage_key: normalizedKey,
      deleted: response.status !== 404,
      status: response.status,
    };
  }

  return {
    filerUrl,
    buildFilerUrl,
    put,
    get,
    getStream,
    head,
    delete: remove,
    rawKey,
    videoKey,
    imageKey,
    audioKey,
    resolveSafeKey,
    normalizeStorageKey,
    sanitizeFilename,
    isValidFileId,
  };
}

const defaultStorage = createStorage();

module.exports = {
  ...defaultStorage,
  createStorage,
  sanitizeFilename,
  isValidFileId,
  resolveSafeKey,
  normalizeStorageKey,
  rawKey,
  videoKey,
  imageKey,
  audioKey,
};

