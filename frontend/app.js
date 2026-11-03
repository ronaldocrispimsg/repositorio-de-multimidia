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
const mediaFileInput = document.getElementById("mediaFileInput");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");

const playerCurrent = document.getElementById("playerCurrent");
const videoContainer = document.getElementById("videoContainer");
const videoPlayer = document.getElementById("videoPlayer");
const audioContainer = document.getElementById("audioContainer");
const audioPlayer = document.getElementById("audioPlayer");
const audioMetaInfo = document.getElementById("audioMetaInfo");
const imageContainer = document.getElementById("imageContainer");
const imageViewer = document.getElementById("imageViewer");
const imageMetaInfo = document.getElementById("imageMetaInfo");

const videoList = document.getElementById("videoList");
const loadingMsg = document.getElementById("loadingMsg");
const refreshBtn = document.getElementById("refreshBtn");
const typeFilter = document.getElementById("typeFilter");

let currentHlsInstance = null;
let pollingTimer = null;

// ============================================================
// MENSAGENS DE STATUS DE UPLOAD
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

// ============================================================
// UPLOAD DE MÍDIA (POST /files)
// ============================================================
uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const file = mediaFileInput.files[0];
  if (!file) {
    showStatus("Por favor, selecione um arquivo de vídeo, áudio ou imagem.", "error");
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
      `Arquivo "${data.filename || file.name}" enviado! Aguardando validação e processamento...`,
      "success"
    );
    mediaFileInput.value = "";

    await fetchFiles();
  } catch (error) {
    console.error("Erro no upload:", error);
    showStatus(`Erro ao enviar: ${error.message}`, "error");
  } finally {
    uploadBtn.disabled = false;
  }
});

// ============================================================
// LISTAGEM DE ARQUIVOS (GET /files) E POLLING AUTOMÁTICO
// ============================================================
async function fetchFiles() {
  try {
    const selectedType = typeFilter ? typeFilter.value : "";
    const query = selectedType ? `?type=${encodeURIComponent(selectedType)}` : "";
    const response = await fetch(`${API_BASE}/files${query}`);
    if (!response.ok) {
      throw new Error(`Erro ${response.status} ao buscar arquivos.`);
    }

    const files = await response.json();
    renderFileList(files);
    schedulePollingIfNeeded(files);
  } catch (error) {
    console.error("Erro ao listar arquivos:", error);
    loadingMsg.style.display = "block";
    loadingMsg.textContent = `Não foi possível carregar os arquivos (${error.message}).`;
  }
}

function schedulePollingIfNeeded(files) {
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }

  const hasPending = Array.isArray(files) && files.some(
    (item) => item.status === "uploaded" || item.status === "processing"
  );

  if (hasPending) {
    pollingTimer = setTimeout(() => {
      fetchFiles();
    }, POLLING_INTERVAL_MS);
  }
}

function formatResultDetails(item) {
  if (!item.result) return "";
  const parts = [];
  if (item.result.format) parts.push(item.result.format.toUpperCase());
  if (item.result.size) parts.push(formatBytes(item.result.size));
  if (item.result.width && item.result.height) {
    parts.push(`${item.result.width}×${item.result.height}`);
  }
  if (item.result.duration_sec) {
    parts.push(`${item.result.duration_sec}s`);
  }
  return parts.length > 0 ? ` • ${parts.join(" • ")}` : "";
}

function renderFileList(files) {
  videoList.innerHTML = "";

  if (!files || files.length === 0) {
    loadingMsg.style.display = "block";
    loadingMsg.textContent = "Nenhum arquivo encontrado. Envie um vídeo, áudio ou imagem acima!";
    return;
  }

  loadingMsg.style.display = "none";

  files.forEach((item) => {
    const fileId = item.file_id || item.video_id;
    const mediaUrl = (item.result && item.result.url) || item.stream_url;
    const li = document.createElement("li");
    li.className = "video-item";

    // Informações do arquivo
    const infoDiv = document.createElement("div");
    infoDiv.className = "video-info";

    const nameP = document.createElement("p");
    nameP.className = "video-name";
    nameP.textContent = item.filename || fileId;

    const metaP = document.createElement("p");
    metaP.className = "video-id";
    metaP.textContent = `ID: ${fileId} • Original: ${formatBytes(item.original_size)}${formatResultDetails(item)}`;

    infoDiv.appendChild(nameP);
    infoDiv.appendChild(metaP);

    if ((item.status === "failed" || item.status === "rejected") && item.error) {
      const errorP = document.createElement("p");
      errorP.className = "video-error";
      errorP.textContent = `Motivo: ${item.error}`;
      infoDiv.appendChild(errorP);
    }

    // Grupo de badges (tipo + status)
    const badgesGroup = document.createElement("div");
    badgesGroup.className = "badges-group";

    if (item.type) {
      const typeBadge = document.createElement("span");
      typeBadge.className = "badge type-badge";
      typeBadge.textContent = item.type;
      badgesGroup.appendChild(typeBadge);
    }

    const statusBadge = document.createElement("span");
    statusBadge.className = `badge ${item.status || "uploaded"}`;
    statusBadge.textContent = item.status || "uploaded";
    badgesGroup.appendChild(statusBadge);

    // Ações
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "video-actions";

    if (item.status === "ready" && mediaUrl) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent =
        item.type === "image"
          ? "Ver Imagem"
          : item.type === "audio"
            ? "Ouvir"
            : "Assistir";
      openBtn.addEventListener("click", () => {
        openMediaItem(item);
      });
      actionsDiv.appendChild(openBtn);
    }

    li.appendChild(infoDiv);
    li.appendChild(badgesGroup);
    li.appendChild(actionsDiv);
    videoList.appendChild(li);
  });
}

// ============================================================
// REPRODUÇÃO / VISUALIZAÇÃO POR TIPO DE MÍDIA
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

  videoContainer.style.display = "none";
  audioContainer.style.display = "none";
  imageContainer.style.display = "none";
}

function openMediaItem(item) {
  resetViewers();

  const mediaUrl = (item.result && item.result.url) || item.stream_url;
  const title = item.filename || item.file_id || item.video_id;

  if (item.type === "image") {
    playerCurrent.textContent = `Visualizando imagem: ${title}`;
    imageViewer.src = mediaUrl;
    const dims =
      item.result && item.result.width && item.result.height
        ? `${item.result.width}×${item.result.height}px`
        : "";
    const sizeStr = item.result && item.result.size ? formatBytes(item.result.size) : "";
    imageMetaInfo.textContent = [dims, sizeStr, "WebP"].filter(Boolean).join(" • ");
    imageContainer.style.display = "block";
    imageContainer.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  if (item.type === "audio") {
    playerCurrent.textContent = `Reproduzindo áudio: ${title}`;
    const tags = (item.result && item.result.tags) || {};
    const tagParts = [];
    if (tags.title) tagParts.push(`Título: ${tags.title}`);
    if (tags.artist) tagParts.push(`Artista: ${tags.artist}`);
    if (item.result && item.result.duration_sec) {
      tagParts.push(`Duração: ${item.result.duration_sec}s`);
    }
    if (item.result && item.result.size) {
      tagParts.push(`Tamanho: ${formatBytes(item.result.size)}`);
    }
    audioMetaInfo.textContent = tagParts.join(" • ") || title;
    audioPlayer.src = mediaUrl;
    audioContainer.style.display = "block";
    audioPlayer.play().catch((err) => console.log("Autoplay bloqueado:", err));
    audioContainer.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  // Vídeo (HLS .m3u8)
  playerCurrent.textContent = `Reproduzindo vídeo: ${title}`;
  videoContainer.style.display = "block";

  const isHls = mediaUrl.includes(".m3u8");
  if (isHls && window.Hls && Hls.isSupported()) {
    currentHlsInstance = new Hls();
    currentHlsInstance.loadSource(mediaUrl);
    currentHlsInstance.attachMedia(videoPlayer);
    currentHlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      videoPlayer.play().catch((err) => console.log("Autoplay bloqueado:", err));
    });
  } else if (videoPlayer.canPlayType("application/vnd.apple.mpegurl")) {
    videoPlayer.src = mediaUrl;
    videoPlayer.play().catch((err) => console.log("Autoplay bloqueado:", err));
  } else {
    videoPlayer.src = mediaUrl;
    videoPlayer.play().catch((err) => console.log("Autoplay bloqueado:", err));
  }

  videoContainer.scrollIntoView({ behavior: "smooth", block: "center" });
}

refreshBtn.addEventListener("click", fetchFiles);
if (typeFilter) {
  typeFilter.addEventListener("change", fetchFiles);
}

document.addEventListener("DOMContentLoaded", () => {
  fetchFiles();
});
