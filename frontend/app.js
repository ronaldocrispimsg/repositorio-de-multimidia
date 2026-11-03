// ============================================================
// CONFIGURAÇÃO DA API
// ============================================================
const API_BASE =
  (window.location.port === "80" || window.location.port === "") &&
  window.location.protocol.startsWith("http")
    ? "/api"
    : "http://localhost:8000";

const POLLING_INTERVAL_MS = 3000;

// Elementos da página
const uploadForm = document.getElementById("uploadForm");
const dropzone = document.getElementById("dropzone");
const mediaFileInput = document.getElementById("mediaFileInput");
const dropzoneDefault = document.getElementById("dropzoneDefault");
const localPreviewBox = document.getElementById("localPreviewBox");
const localPreviewThumb = document.getElementById("localPreviewThumb");
const localPreviewName = document.getElementById("localPreviewName");
const localPreviewInfo = document.getElementById("localPreviewInfo");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");

const statTotal = document.getElementById("statTotal");
const statReady = document.getElementById("statReady");
const statPending = document.getElementById("statPending");

const stageBadge = document.getElementById("stageBadge");
const playerCurrent = document.getElementById("playerCurrent");
const stageEmpty = document.getElementById("stageEmpty");
const videoContainer = document.getElementById("videoContainer");
const videoPlayer = document.getElementById("videoPlayer");
const audioContainer = document.getElementById("audioContainer");
const audioPlayer = document.getElementById("audioPlayer");
const audioStageArt = document.getElementById("audioStageArt");
const audioStageTitle = document.getElementById("audioStageTitle");
const audioMetaInfo = document.getElementById("audioMetaInfo");
const imageContainer = document.getElementById("imageContainer");
const imageViewer = document.getElementById("imageViewer");
const imageMetaInfo = document.getElementById("imageMetaInfo");
const imageOpenRawLink = document.getElementById("imageOpenRawLink");

const videoList = document.getElementById("videoList");
const loadingMsg = document.getElementById("loadingMsg");
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("searchInput");
const filterTabs = Array.from(document.querySelectorAll(".filter-tab"));

let currentHlsInstance = null;
let pollingTimer = null;
let activeFilterType = "";
let activeFileId = null;
let cachedFiles = [];
let localObjectUrl = null;

// Cache em memória de frames capturados de vídeos antigos (que não tinham thumb.jpg no Filer)
const videoFrameDataUrlCache = new Map();

// ============================================================
// UTILITÁRIOS DE FORMATAÇÃO E HASH DETERMINÍSTICO
// ============================================================
function showStatus(message, type = "info") {
  uploadStatus.textContent = message;
  uploadStatus.className = `status-msg ${type}`;
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(sec) {
  const s = Math.round(Number(sec || 0));
  if (!s || s <= 0) return "";
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function hashString(str) {
  let h = 2166136261;
  const s = String(str || "videobox");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ============================================================
// GERADORES DE MINIATURAS (CANVAS 2D) PARA ÁUDIO, VÍDEO E ESTADOS
// ============================================================

/**
 * Desenha uma miniatura de espectrograma/ondas acústicas determinística na paleta clara original (#f4f4f9 / #0066cc)
 */
function drawAudioWaveformThumbnail(canvas, item, isSquare = false) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const seedBase = hashString((item && (item.file_id || item.filename)) || "audio");

  // Fundo claro harmonizado com #f4f4f9 e #cce5ff
  const bgGrad = ctx.createLinearGradient(0, 0, w, h);
  bgGrad.addColorStop(0, "#eef5ff");
  bgGrad.addColorStop(1, "#e2ecf9");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  // Grade técnica sutil
  ctx.strokeStyle = "rgba(0, 102, 204, 0.08)";
  ctx.lineWidth = 1;
  const step = isSquare ? 20 : 28;
  for (let x = step; x < w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Barras de forma de onda simétricas no azul #0066cc / #0052a3
  const barCount = isSquare ? 18 : 38;
  const padX = isSquare ? 12 : 20;
  const usableW = w - padX * 2;
  const slotW = usableW / barCount;
  const barW = Math.max(2, slotW * 0.58);

  const barGrad = ctx.createLinearGradient(0, 0, 0, h);
  barGrad.addColorStop(0, "#3385ff");
  barGrad.addColorStop(0.5, "#0066cc");
  barGrad.addColorStop(1, "#0052a3");
  ctx.fillStyle = barGrad;

  let s = seedBase || 1;
  for (let i = 0; i < barCount; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const norm = (s & 0xffff) / 0xffff;
    const envelope = Math.sin(((i + 0.5) / barCount) * Math.PI);
    const amp = Math.max(0.14, norm * 0.75 * envelope + 0.15);
    const barH = amp * (h * 0.72);
    const x = padX + i * slotW + (slotW - barW) / 2;
    const y = (h - barH) / 2;

    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, barW, barH, 2);
    } else {
      ctx.rect(x, y, barW, barH);
    }
    ctx.fill();
  }
}

/**
 * Desenha um poster técnico na paleta original para vídeos ou estados pendentes/rejeitados
 */
function drawStatusOrVideoPlaceholder(canvas, item) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  const isErr = item.status === "rejected" || item.status === "failed";
  const isWarn = item.status === "processing";

  const grad = ctx.createLinearGradient(0, 0, w, h);
  if (isErr) {
    grad.addColorStop(0, "#f8d7da");
    grad.addColorStop(1, "#f1b0b7");
  } else if (isWarn) {
    grad.addColorStop(0, "#fff3cd");
    grad.addColorStop(1, "#ffeeba");
  } else {
    grad.addColorStop(0, "#e9ecef");
    grad.addColorStop(1, "#dee2e6");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Película lateral se for vídeo
  if (item.type === "video") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.06)";
    for (let y = 8; y < h; y += 18) {
      ctx.fillRect(8, y, 10, 10);
      ctx.fillRect(w - 18, y, 10, 10);
    }
  }

  ctx.fillStyle = isErr ? "#721c24" : isWarn ? "#856404" : "#555555";
  ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";

  const label = isErr
    ? "ARQUIVO RECUSADO / FALHA"
    : item.status === "processing" || item.status === "uploaded"
      ? "PROCESSANDO NO PIPELINE..."
      : (item.type || "VIDEO").toUpperCase();

  ctx.fillText(label, w / 2, h / 2 + 4);
}

/**
 * Fallback client-side: caso um vídeo antigo não tenha thumb.jpg salvo no Filer,
 * carrega o primeiro segmento via HLS em background, captura um frame para o Canvas e faz cache.
 */
function captureHlsVideoFrameToImg(item, imgEl, fallbackCanvas) {
  const fileId = item.file_id || item.video_id;
  const streamUrl = (item.result && item.result.url) || item.stream_url;
  if (!streamUrl) return;

  if (videoFrameDataUrlCache.has(fileId)) {
    imgEl.src = videoFrameDataUrlCache.get(fileId);
    imgEl.style.display = "block";
    if (fallbackCanvas) fallbackCanvas.style.display = "none";
    return;
  }

  const tempVideo = document.createElement("video");
  tempVideo.muted = true;
  tempVideo.playsInline = true;
  tempVideo.crossOrigin = "anonymous";

  let tempHls = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (tempHls) {
      tempHls.destroy();
      tempHls = null;
    }
    tempVideo.removeAttribute("src");
    tempVideo.load();
  };

  const snapFrame = () => {
    try {
      const vw = tempVideo.videoWidth || 320;
      const vh = tempVideo.videoHeight || 180;
      const c = document.createElement("canvas");
      c.width = vw;
      c.height = vh;
      const ctx = c.getContext("2d");
      ctx.drawImage(tempVideo, 0, 0, vw, vh);
      const dataUrl = c.toDataURL("image/jpeg", 0.78);
      videoFrameDataUrlCache.set(fileId, dataUrl);
      imgEl.src = dataUrl;
      imgEl.style.display = "block";
      if (fallbackCanvas) fallbackCanvas.style.display = "none";
    } catch (_) {
      // mantém o fallbackCanvas visível
    } finally {
      cleanup();
    }
  };

  tempVideo.addEventListener("seeked", snapFrame, { once: true });
  tempVideo.addEventListener(
    "loadeddata",
    () => {
      try {
        tempVideo.currentTime = 0.2;
      } catch (_) {
        snapFrame();
      }
    },
    { once: true }
  );

  setTimeout(cleanup, 8000);

  if (window.Hls && Hls.isSupported() && streamUrl.includes(".m3u8")) {
    tempHls = new Hls({ maxBufferLength: 2, enableWorker: false });
    tempHls.loadSource(streamUrl);
    tempHls.attachMedia(tempVideo);
  } else {
    tempVideo.src = streamUrl;
  }
}

// ============================================================
// PREVIEW LOCAL NO DROPZONE ANTES DO ENVIO
// ============================================================
function updateLocalDropzonePreview(file) {
  if (localObjectUrl) {
    URL.revokeObjectURL(localObjectUrl);
    localObjectUrl = null;
  }

  localPreviewThumb.innerHTML = "";

  if (!file) {
    dropzoneDefault.style.display = "flex";
    localPreviewBox.style.display = "none";
    return;
  }

  dropzoneDefault.style.display = "none";
  localPreviewBox.style.display = "flex";
  localPreviewName.textContent = file.name;
  localPreviewInfo.textContent = `${file.type || "binário"} • ${formatBytes(file.size)}`;

  if (file.type.startsWith("image/")) {
    localObjectUrl = URL.createObjectURL(file);
    const img = document.createElement("img");
    img.src = localObjectUrl;
    img.alt = "Preview local";
    localPreviewThumb.appendChild(img);
  } else if (file.type.startsWith("audio/")) {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 96;
    drawAudioWaveformThumbnail(c, { filename: file.name }, true);
    localPreviewThumb.appendChild(c);
  } else {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 96;
    drawStatusOrVideoPlaceholder(c, { type: "video", filename: file.name, status: "ready" });
    localPreviewThumb.appendChild(c);
  }
}

mediaFileInput.addEventListener("change", () => {
  updateLocalDropzonePreview(mediaFileInput.files[0] || null);
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    mediaFileInput.files = e.dataTransfer.files;
    updateLocalDropzonePreview(e.dataTransfer.files[0]);
  }
});

// ============================================================
// UPLOAD DE MÍDIA (POST /files)
// ============================================================
uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const file = mediaFileInput.files[0];
  if (!file) {
    showStatus("Selecione ou arraste um arquivo de vídeo, áudio ou imagem.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  uploadBtn.disabled = true;
  showStatus(`Enviando "${file.name}" (${formatBytes(file.size)})...`, "info");

  try {
    const response = await fetch(`${API_BASE}/files`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Erro ${response.status} ao enviar arquivo.`);
    }

    showStatus(
      `Arquivo "${data.filename || file.name}" recebido! Classificando por magic bytes...`,
      "success"
    );
    mediaFileInput.value = "";
    updateLocalDropzonePreview(null);

    await fetchFiles();
  } catch (error) {
    console.error("Erro no upload:", error);
    showStatus(`Erro ao enviar: ${error.message}`, "error");
  } finally {
    uploadBtn.disabled = false;
  }
});

// ============================================================
// LISTAGEM DE ARQUIVOS E POLLING AUTOMÁTICO
// ============================================================
async function fetchFiles() {
  try {
    const response = await fetch(`${API_BASE}/files`);
    if (!response.ok) {
      throw new Error(`Erro ${response.status} ao buscar arquivos.`);
    }

    const files = await response.json();
    cachedFiles = Array.isArray(files) ? files : [];
    updateStatsCounters(cachedFiles);
    renderGallery();
    schedulePollingIfNeeded(cachedFiles);
  } catch (error) {
    console.error("Erro ao listar arquivos:", error);
    loadingMsg.style.display = "block";
    loadingMsg.textContent = `Não foi possível carregar o acervo (${error.message}).`;
  }
}

function updateStatsCounters(files) {
  const total = files.length;
  const ready = files.filter((f) => f.status === "ready").length;
  const pending = files.filter((f) => f.status === "uploaded" || f.status === "processing").length;

  statTotal.textContent = String(total);
  statReady.textContent = String(ready);
  statPending.textContent = String(pending);

  const countByType = {
    "": total,
    video: files.filter((f) => String(f.type || "").toLowerCase() === "video").length,
    audio: files.filter((f) => String(f.type || "").toLowerCase() === "audio").length,
    image: files.filter((f) => String(f.type || "").toLowerCase() === "image").length,
  };

  const labelByType = {
    "": "Todos",
    video: "Vídeos",
    audio: "Áudios",
    image: "Imagens",
  };

  filterTabs.forEach((tab) => {
    const t = tab.getAttribute("data-type") || "";
    const baseLabel = labelByType[t] || tab.textContent;
    const c = countByType[t] !== undefined ? countByType[t] : 0;
    tab.textContent = `${baseLabel} (${c})`;
  });
}

function schedulePollingIfNeeded(files) {
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }

  const hasPending =
    Array.isArray(files) &&
    files.some((item) => item.status === "uploaded" || item.status === "processing");

  if (hasPending) {
    pollingTimer = setTimeout(() => {
      fetchFiles();
    }, POLLING_INTERVAL_MS);
  }
}

// ============================================================
// RENDERIZAÇÃO DA GALERIA COM MINIATURAS (VÍDEO, ÁUDIO, IMAGEM)
// ============================================================
function buildThumbnailElement(item) {
  const thumbBox = document.createElement("div");
  thumbBox.className = `card-thumb thumb-${item.type || "video"}`;

  const mediaUrl = (item.result && item.result.url) || item.stream_url;
  const isReady = item.status === "ready" && Boolean(mediaUrl);

  // 1. IMAGEM PRONTA -> Miniatura real do próprio WebP otimizado (<= 300 KB)
  if (isReady && item.type === "image") {
    const img = document.createElement("img");
    img.src = mediaUrl;
    img.alt = item.filename || "Miniatura da imagem";
    img.loading = "lazy";
    thumbBox.appendChild(img);
  }
  // 2. ÁUDIO PRONTO -> Miniatura de forma de onda acústica gerada em Canvas 2D
  else if (isReady && item.type === "audio") {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    drawAudioWaveformThumbnail(canvas, item, false);
    thumbBox.appendChild(canvas);
  }
  // 3. VÍDEO PRONTO -> Usa /streams/<id>/thumb.jpg gerado pelo FFmpeg ou captura frame HLS como fallback
  else if (isReady && item.type === "video") {
    const fallbackCanvas = document.createElement("canvas");
    fallbackCanvas.width = 320;
    fallbackCanvas.height = 180;
    drawStatusOrVideoPlaceholder(fallbackCanvas, item);
    thumbBox.appendChild(fallbackCanvas);

    const fileId = item.file_id || item.video_id;
    const thumbUrl =
      (item.result && item.result.thumbnail_url) || `/streams/${fileId}/thumb.jpg`;

    const img = document.createElement("img");
    img.alt = item.filename || "Miniatura do vídeo";
    img.loading = "lazy";
    img.style.display = "none";

    img.addEventListener("load", () => {
      img.style.display = "block";
      fallbackCanvas.style.display = "none";
    });

    img.addEventListener("error", () => {
      // Vídeo processado antes da geração de thumb.jpg -> extrai frame via HLS no navegador
      captureHlsVideoFrameToImg(item, img, fallbackCanvas);
    });

    img.src = thumbUrl;
    thumbBox.appendChild(img);
  }
  // 4. PENDENTE / REJEITADO / FALHA -> Poster informativo em Canvas
  else {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    drawStatusOrVideoPlaceholder(canvas, item);
    thumbBox.appendChild(canvas);
  }

  // Badges de topo (Tipo + Status)
  const topLeft = document.createElement("div");
  topLeft.className = "thumb-top-left";

  if (item.type) {
    const typeBadge = document.createElement("span");
    typeBadge.className = "badge type-badge";
    typeBadge.textContent = item.type;
    topLeft.appendChild(typeBadge);
  }

  const statusBadge = document.createElement("span");
  statusBadge.className = `badge ${item.status || "uploaded"}`;
  statusBadge.textContent = item.status || "uploaded";
  topLeft.appendChild(statusBadge);
  thumbBox.appendChild(topLeft);

  // Badge inferior direito (Duração para áudio, resolução para imagem ou formato para vídeo)
  const bottomTagText =
    item.result && item.result.duration_sec
      ? formatDuration(item.result.duration_sec)
      : item.result && item.result.width && item.result.height
        ? `${item.result.width}×${item.result.height}`
        : item.result && item.result.format
          ? item.result.format.toUpperCase()
          : "";

  if (bottomTagText) {
    const bottomRight = document.createElement("span");
    bottomRight.className = "thumb-bottom-right";
    bottomRight.textContent = bottomTagText;
    thumbBox.appendChild(bottomRight);
  }

  // Overlay de reprodução/inspeção quando pronto
  if (isReady) {
    const overlay = document.createElement("div");
    overlay.className = "thumb-play-overlay";
    const circle = document.createElement("div");
    circle.className = "thumb-play-circle";
    circle.innerHTML =
      item.type === "image"
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7Z"/></svg>';
    overlay.appendChild(circle);
    thumbBox.appendChild(overlay);
  }

  return thumbBox;
}

function renderGallery() {
  videoList.innerHTML = "";

  const searchTerm = (searchInput ? searchInput.value : "").trim().toLowerCase();
  const filtered = cachedFiles.filter((item) => {
    if (activeFilterType && String(item.type || "").toLowerCase() !== activeFilterType) {
      return false;
    }
    if (!searchTerm) return true;
    const name = String(item.filename || "").toLowerCase();
    const id = String(item.file_id || item.video_id || "").toLowerCase();
    return name.includes(searchTerm) || id.includes(searchTerm);
  });

  if (filtered.length === 0) {
    loadingMsg.style.display = "block";
    loadingMsg.textContent = searchTerm
      ? "Nenhum arquivo corresponde à busca digitada."
      : "Nenhum arquivo encontrado nesta categoria. Envie um vídeo, áudio ou imagem no painel ao lado.";
    return;
  }

  loadingMsg.style.display = "none";

  filtered.forEach((item) => {
    const fileId = item.file_id || item.video_id;
    const mediaUrl = (item.result && item.result.url) || item.stream_url;
    const isReady = item.status === "ready" && Boolean(mediaUrl);

    const li = document.createElement("li");
    li.className = `media-card${isReady ? " is-ready" : ""}${activeFileId === fileId ? " is-active" : ""}`;
    if (isReady) {
      li.tabIndex = 0;
    }

    const thumbEl = buildThumbnailElement(item);
    li.appendChild(thumbEl);

    const body = document.createElement("div");
    body.className = "card-body";

    const titleRow = document.createElement("div");
    titleRow.className = "card-title-row";

    const titleP = document.createElement("p");
    titleP.className = "card-title";
    titleP.title = item.filename || fileId;
    titleP.textContent = item.filename || fileId;
    titleRow.appendChild(titleP);
    body.appendChild(titleRow);

    // Subtítulo técnico: tamanho original -> tamanho processado ou tags de áudio
    const subParts = [`Bruto: ${formatBytes(item.original_size)}`];
    if (item.result && item.result.size) {
      subParts.push(`Final: ${formatBytes(item.result.size)}`);
    }
    if (item.result && item.result.tags && item.result.tags.artist) {
      subParts.push(item.result.tags.artist);
    }

    const subP = document.createElement("p");
    subP.className = "card-sub";
    subP.textContent = subParts.join(" • ");
    body.appendChild(subP);

    if ((item.status === "failed" || item.status === "rejected") && item.error) {
      const errorP = document.createElement("p");
      errorP.className = "card-error";
      errorP.textContent = item.error;
      body.appendChild(errorP);
    }

    const footer = document.createElement("div");
    footer.className = "card-footer";

    const idSpan = document.createElement("span");
    idSpan.className = "card-id";
    idSpan.title = fileId;
    idSpan.textContent = fileId.slice(0, 8);
    footer.appendChild(idSpan);

    if (isReady) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "card-btn";
      openBtn.textContent =
        item.type === "image"
          ? "Inspecionar"
          : item.type === "audio"
            ? "Ouvir"
            : "Reproduzir";
      openBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openMediaItem(item);
      });
      footer.appendChild(openBtn);

      li.addEventListener("click", () => openMediaItem(item));
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          openMediaItem(item);
        }
      });
    }

    body.appendChild(footer);
    li.appendChild(body);
    videoList.appendChild(li);
  });
}

// ============================================================
// MONITOR / PALCO MULTIMÍDIA
// ============================================================
function resetViewers() {
  if (currentHlsInstance) {
    currentHlsInstance.destroy();
    currentHlsInstance = null;
  }
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  audioPlayer.pause();
  audioPlayer.removeAttribute("src");
  imageViewer.removeAttribute("src");

  stageEmpty.style.display = "none";
  videoContainer.style.display = "none";
  audioContainer.style.display = "none";
  imageContainer.style.display = "none";
}

function openMediaItem(item) {
  resetViewers();

  const fileId = item.file_id || item.video_id;
  activeFileId = fileId;
  renderGallery();

  const mediaUrl = (item.result && item.result.url) || item.stream_url;
  const title = item.filename || fileId;

  stageBadge.style.display = "inline-block";
  stageBadge.textContent = item.type || "media";
  playerCurrent.textContent = title;

  if (item.type === "image") {
    imageViewer.src = mediaUrl;
    imageOpenRawLink.href = mediaUrl;
    const dims =
      item.result && item.result.width && item.result.height
        ? `${item.result.width}×${item.result.height}px`
        : "";
    const sizeStr = item.result && item.result.size ? formatBytes(item.result.size) : "";
    imageMetaInfo.textContent = [dims, sizeStr, "WebP ≤ 300 KB"].filter(Boolean).join(" • ");
    imageContainer.style.display = "block";
    return;
  }

  if (item.type === "audio") {
    drawAudioWaveformThumbnail(audioStageArt, item, true);
    const tags = (item.result && item.result.tags) || {};
    audioStageTitle.textContent = tags.title || title;

    const metaParts = [];
    if (tags.artist) metaParts.push(tags.artist);
    if (item.result && item.result.format) metaParts.push(item.result.format.toUpperCase());
    if (item.result && item.result.duration_sec) {
      metaParts.push(`${item.result.duration_sec}s`);
    }
    if (item.result && item.result.size) {
      metaParts.push(formatBytes(item.result.size));
    }
    audioMetaInfo.textContent = metaParts.join(" • ");
    audioPlayer.src = mediaUrl;
    audioContainer.style.display = "block";
    audioPlayer.play().catch(() => {});
    return;
  }

  // Vídeo HLS
  videoContainer.style.display = "block";
  const isHls = mediaUrl.includes(".m3u8");
  if (isHls && window.Hls && Hls.isSupported()) {
    currentHlsInstance = new Hls();
    currentHlsInstance.loadSource(mediaUrl);
    currentHlsInstance.attachMedia(videoPlayer);
    currentHlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      videoPlayer.play().catch(() => {});
    });
  } else if (videoPlayer.canPlayType("application/vnd.apple.mpegurl")) {
    videoPlayer.src = mediaUrl;
    videoPlayer.play().catch(() => {});
  } else {
    videoPlayer.src = mediaUrl;
    videoPlayer.play().catch(() => {});
  }
}

// ============================================================
// EVENTOS DE FILTRO E BUSCA
// ============================================================
filterTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    filterTabs.forEach((t) => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    activeFilterType = (tab.getAttribute("data-type") || "").toLowerCase();
    renderGallery();
  });
});

if (searchInput) {
  searchInput.addEventListener("input", () => {
    renderGallery();
  });
}

refreshBtn.addEventListener("click", fetchFiles);

document.addEventListener("DOMContentLoaded", () => {
  fetchFiles();
});
