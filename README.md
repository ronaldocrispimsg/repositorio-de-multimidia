# Repositório de Multimídia

**Sistema Distribuído Orientado a Eventos para Upload, Processamento e Streaming de Vídeo (HLS), Áudio (AAC/MP3) e Imagem (WebP)**

---

## Contexto

O **Repositório de Multimídia** é um sistema distribuído em **Node.js (Express / CommonJS)** que recebe uploads de **vídeos, áudios e imagens**, armazena objetos em streaming no **SeaweedFS**, roteia e valida binários por *magic bytes* e `ffprobe`, processa cada tipo de mídia em workers independentes via **RabbitMQ** e entrega os artefatos com cache imutável e suporte a HTTP `Range` / HLS através de um **Gateway NGINX**.

---

## Arquitetura e Fluxo Orientado a Eventos

```mermaid
flowchart LR
    U[Cliente / Navegador] -->|Porta 80| GW[NGINX Gateway]
    GW -->|/api/*| BE[Backend API]
    GW -->|/streams/* e /media/*| REPO[Repository Service]
    GW -->|/| FE[Frontend UI]

    BE -->|PUT raw/{file_id}/original| FILER[(SeaweedFS Filer :8888)]
    BE -->|file.uploaded| MQ((RabbitMQ media.events))

    MQ -->|file.uploaded| WR[process-router]
    WR -->|Magic bytes + sharp + ffprobe| FILER
    WR -->|video.uploaded| WV[process-video]
    WR -->|audio.uploaded| WA[process-audio]
    WR -->|image.uploaded| WI[process-image]
    WR -->|file.rejected| MQ

    WV -->|HLS .m3u8 + .ts| FILER
    WA -->|AAC 128k .m4a / copy .mp3| FILER
    WI -->|WebP <= 300 KB| FILER

    WV & WA & WI -->|*.processing / *.ready / *.failed| MQ
    MQ -->|media.backend| BE
    REPO -->|Proxy Streaming + Range| FILER
```

### Componentes

1. **Gateway (`nginx/`)**: única porta pública do sistema (`80:80`). Roteia `/` para o `frontend`, `/api/` para o `backend` (com `proxy_request_buffering off`), `/streams/` e `/media/` para o `repository`, e `/message/` para o painel do RabbitMQ.
2. **Backend (`backend/`)**:
   - Endpoints principais: `POST /files`, `GET /files` (suporta `?type=video|audio|image`), `GET /files/:id` e `GET /files/:id/file` (mantendo `/upload` e `/videos` como aliases de transição).
   - Grava o upload diretamente no SeaweedFS Filer (`raw/{file_id}/original`) em streaming via engine customizada do Multer, sem carregar o arquivo em memória.
   - Gerencia o estado em `/data/videos_state.json` (volume `backend_state`) através do módulo `backend/store.js`, com escrita atômica (`.tmp` + `rename`) e máquina de estados monotônica (`uploaded` → `processing` → `ready | failed | rejected`), ignorando transições regressivas.
3. **Storage Distribuído (`master`, `volume`, `filer` — `chrislusf/seaweedfs:3.65`)**:
   - Acessado na rede interna via HTTP (`http://filer:8888`) pelo módulo `shared/storage.js`.
   - Prefixos determinísticos (garantindo idempotência ao reprocessar o mesmo `file_id`):
     - `raw/{file_id}/original` (removido após `*.ready` ou `file.rejected`)
     - `processed/videos/{file_id}/playlist.m3u8` e segmentos `.ts`
     - `processed/images/{file_id}.webp`
     - `processed/audio/{file_id}.{m4a|mp3}`
4. **Workers Assíncronos (`process/`, parametrizados por `WORKER_TYPE`)**:
   - `process-router` (`WORKER_TYPE=router`): consome `file.uploaded`, inspeciona magic bytes (`file-type`), metadados de imagem (`sharp`) e streams de mídia (`ffprobe`, diferenciando vídeo real de capa de álbum `attached_pic`), valida limites por tipo e publica `video.uploaded`, `audio.uploaded` ou `image.uploaded` — ou apaga o raw e emite `file.rejected`.
   - `process-video` (`WORKER_TYPE=video`): consome `video.uploaded`, transcodifica para HLS (`h264`/`aac`) com FFmpeg, grava em `processed/videos/{file_id}/...`, publica `video.ready` e apaga o raw.
   - `process-image` (`WORKER_TYPE=image`): consome `image.uploaded`, auto-orienta e remove metadados EXIF (`.rotate()`), preserva canal alpha e comprime com `sharp` para **WebP ≤ 300 KB** (caixa máxima `2048x2048`, qualidades `[85, 75, 65, 55, 45]` e redução progressiva de 15% até `320px`), publica `image.ready` e apaga o raw.
   - `process-audio` (`WORKER_TYPE=audio`): consome `audio.uploaded`, extrai duração e tags (`title`, `artist`) via `ffprobe`, faz remux sem perdas (`-vn -c:a copy`) quando já é `mp3 <= 128k` ou `aac (m4a) <= 128k`, ou reencoda com `-vn -c:a aac -b:a 128k -movflags +faststart` (`.m4a`), publica `audio.ready` e apaga o raw.
5. **Repository (`repository/`)**:
   - Serve `/streams/:videoId/*` (HLS) e `/media/*` (`processed/images/...` e `processed/audio/...`) em streaming direto do Filer, com validação de caminho (`path.posix.resolve` + prefixo), `Cache-Control: public, max-age=31536000, immutable` e suporte a `Range` HTTP (`206 Partial Content`).
6. **Infraestrutura K3s + KEDA (`infra/deploys/`)**:
   - Manifestos Kubernetes para o gateway, repository e os 4 Deployments + `ScaledObjects` do KEDA escalando cada worker pela profundidade de sua fila (`file.uploaded`, `video.uploaded`, `audio.uploaded`, `image.uploaded`).

---

## Contrato de Eventos (RabbitMQ `media.events`)

Exchange do tipo `topic` chamada `media.events`. Lista fechada de **14 eventos explícitos** (sem curingas):

| Evento | Origem | Fila / Destino | Descrição |
| --- | --- | --- | --- |
| `file.uploaded` | `backend` | `file.uploaded` (`process-router`) | Upload bruto concluído no Filer |
| `file.rejected` | `process-router` | `media.backend` (`backend`) | Arquivo inválido, corrompido, GIF ou acima do limite |
| `video.uploaded` | `process-router` | `video.uploaded` (`process-video`) | Vídeo validado aguardando transcodificação HLS |
| `audio.uploaded` | `process-router` | `audio.uploaded` (`process-audio`) | Áudio validado aguardando compressão/remux |
| `image.uploaded` | `process-router` | `image.uploaded` (`process-image`) | Imagem validada aguardando conversão WebP |
| `video.processing` | `process-video` | `media.backend` (`backend`) | Transcodificação HLS iniciada |
| `audio.processing` | `process-audio` | `media.backend` (`backend`) | Processamento de áudio iniciado |
| `image.processing` | `process-image` | `media.backend` (`backend`) | Compressão WebP iniciada |
| `video.ready` | `process-video` | `media.backend` (`backend`) | HLS pronto em `/streams/{file_id}/playlist.m3u8` |
| `audio.ready` | `process-audio` | `media.backend` (`backend`) | Áudio pronto em `/media/audio/{file_id}.{m4a\|mp3}` |
| `image.ready` | `process-image` | `media.backend` (`backend`) | Imagem pronta em `/media/images/{file_id}.webp` |
| `video.failed` | `process-video` | `media.backend` (`backend`) | Falha definitiva após 3 tentativas com backoff (DLX) |
| `audio.failed` | `process-audio` | `media.backend` (`backend`) | Falha definitiva após 3 tentativas com backoff (DLX) |
| `image.failed` | `process-image` | `media.backend` (`backend`) | Falha definitiva após 3 tentativas com backoff (DLX) |

### Payload Padrão (snake_case)

```json
{
  "event_id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "file_id": "3f70d922-9ce2-4e4b-8dc9-4d207fd8497a",
  "type": "image",
  "filename": "foto.png",
  "storage_key": "processed/images/3f70d922-9ce2-4e4b-8dc9-4d207fd8497a.webp",
  "mime_type": "image/webp",
  "original_size": 4613460,
  "occurred_at": "2026-11-03T02:35:46.755Z",
  "status": "ready",
  "result": {
    "url": "/media/images/3f70d922-9ce2-4e4b-8dc9-4d207fd8497a.webp",
    "size": 294852,
    "format": "webp",
    "width": 650,
    "height": 867
  },
  "error": null
}
```

---

## Limites e Formatos Aceitos

| Tipo | Formatos de Entrada Aceitos | Limite de Upload | Formato de Saída |
| --- | --- | --- | --- |
| **Imagem** | `jpeg`, `jpg`, `png`, `webp` (GIF é rejeitado) | `20 MB` (`MAX_IMAGE_SIZE_BYTES`) | `.webp` (`<= 300 KB`, máx. `2048x2048`, alpha preservado, sem EXIF) |
| **Áudio** | `mp3`, `m4a`, `wav`, `flac`, `ogg` | `200 MB` (`MAX_AUDIO_SIZE_BYTES`) | `.mp3` (se entrada `mp3 <= 128k`) ou `.m4a` (`aac 128k +faststart`) |
| **Vídeo** | Containers com codec de vídeo válido no `ffprobe` (`h264`, `hevc`, `av1`, `vp9`, etc.) | `2 GB` (`MAX_VIDEO_SIZE_BYTES`) | HLS (`playlist.m3u8` + segmentos `.ts`) |

---

## Configuração e Execução Local

### 1. Variáveis de Ambiente

Copie os arquivos `.env.example` para `.env` em cada serviço:

```bash
cp rabbitMQ/.env.example rabbitMQ/.env
cp backend/.env.example backend/.env
cp process/.env.example process/.env
cp repository/.env.example repository/.env
cp frontend/.env.example frontend/.env
cp nginx/.env.example nginx/.env
```

Substitua `CHANGE_ME` pela mesma senha em `rabbitMQ/.env`, `backend/.env` e `process/.env`.

### 2. Subir o Ambiente com Docker Compose

```bash
docker compose up -d --build
```

- **Aplicação Web (Gateway NGINX)**: `http://localhost`
- **API de Arquivos**: `http://localhost/api/files`
- **Painel do RabbitMQ (via Gateway)**: `http://localhost/message/`

### 3. Executar a Suíte de Testes Automatizados

```bash
node --test backend/test/foundation.test.js process/test/router.test.js process/test/image.test.js process/test/audio.test.js
```
