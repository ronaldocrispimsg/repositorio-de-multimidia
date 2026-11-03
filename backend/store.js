const fs = require('fs');
const path = require('path');

const STATUS_RANK = Object.freeze({
  uploaded: 1,
  processing: 2,
  ready: 3,
  failed: 3,
  rejected: 3,
});

const TERMINAL_STATUSES = new Set(['ready', 'failed', 'rejected']);

function canTransition(currentStatus, nextStatus) {
  if (!currentStatus) {
    return true;
  }
  if (!nextStatus) {
    return true;
  }
  const currentRank = STATUS_RANK[currentStatus] || 0;
  const nextRank = STATUS_RANK[nextStatus] || 0;

  if (nextRank < currentRank) {
    return false;
  }

  if (TERMINAL_STATUSES.has(currentStatus) && currentStatus !== nextStatus) {
    return false;
  }

  return true;
}

function createStore(options = {}) {
  const stateFile = path.resolve(
    options.stateFile || process.env.VIDEO_STATE_FILE || '/data/videos_state.json'
  );
  const stateDir = path.dirname(stateFile);

  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  let state = {};
  let isSaving = false;
  let pendingSave = false;
  let saveQueuePromise = Promise.resolve();

  function load() {
    if (fs.existsSync(stateFile)) {
      try {
        const raw = fs.readFileSync(stateFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          state = parsed;
          console.log(`[backend] Estado carregado (${Object.keys(state).length} itens).`);
        }
      } catch (err) {
        console.error('[backend] Erro ao carregar arquivo de estado:', err);
      }
    }
    return state;
  }

  async function flushToDisk() {
    if (isSaving) {
      pendingSave = true;
      return saveQueuePromise;
    }
    isSaving = true;

    saveQueuePromise = (async () => {
      try {
        do {
          pendingSave = false;
          const tmpFile = `${stateFile}.tmp`;
          const payload = JSON.stringify(state, null, 2);
          await fs.promises.writeFile(tmpFile, payload, 'utf-8');
          await fs.promises.rename(tmpFile, stateFile);
        } while (pendingSave);
      } catch (err) {
        console.error('[backend] Erro ao salvar estado:', err);
        throw err;
      } finally {
        isSaving = false;
      }
    })();

    return saveQueuePromise;
  }

  async function upsert(fileId, patch = {}) {
    if (!fileId) {
      throw new Error('file_id é obrigatório para atualizar o estado.');
    }

    const current = state[fileId] || null;
    const nextStatus = patch.status || (current && current.status) || 'uploaded';

    if (current && !canTransition(current.status, nextStatus)) {
      console.log(
        `[backend] Transição regressiva ignorada para ${fileId}: ${current.status} -> ${nextStatus}`
      );
      return { updated: false, item: current };
    }

    const now = new Date().toISOString();
    const resolvedType = patch.type !== undefined ? patch.type : (current ? current.type : 'video');
    const resolvedResult = patch.result !== undefined ? patch.result : (current ? current.result : null);
    const resolvedError = patch.error !== undefined ? patch.error : (current ? current.error : null);
    const streamUrl = (resolvedResult && resolvedResult.url)
      || patch.stream_url
      || (current ? current.stream_url : null);

    const record = {
      ...(current || {}),
      file_id: fileId,
      video_id: fileId,
      type: resolvedType,
      filename: patch.filename || (current && current.filename) || 'unnamed',
      storage_key: patch.storage_key !== undefined ? patch.storage_key : (current ? current.storage_key : null),
      mime_type: patch.mime_type || (current && current.mime_type) || 'application/octet-stream',
      original_size: typeof patch.original_size === 'number'
        ? patch.original_size
        : (current && typeof current.original_size === 'number' ? current.original_size : 0),
      status: nextStatus,
      result: resolvedResult,
      error: resolvedError,
      stream_url: streamUrl,
      download_url: patch.download_url !== undefined
        ? patch.download_url
        : (current && current.download_url) || `/api/videos/${fileId}/file`,
      occurred_at: patch.occurred_at || now,
      created_at: (current && current.created_at) || now,
      updated_at: now,
    };

    state[fileId] = record;
    await flushToDisk();
    return { updated: true, item: record };
  }

  function get(fileId) {
    return state[fileId] || null;
  }

  function list() {
    return Object.values(state);
  }

  load();

  return {
    stateFile,
    load,
    upsert,
    get,
    list,
    canTransition,
  };
}

module.exports = {
  STATUS_RANK,
  TERMINAL_STATUSES,
  canTransition,
  createStore,
};

