# Arquitetura do Repositório de Multimídia

Atualizado em 2026-11-03 (Fase 5: Workers Separados, K3s/KEDA, Frontend Multimídia e Documentação). Descreve o estado real comprovado no código.

## Serviços (Docker Compose)

| Serviço | Imagem / Pasta | Função |
| --- | --- | --- |
| `gateway` | `nginx/` | Único ponto de entrada público (porta `80`). Usa `resolver 127.0.0.11 valid=10s` para resolução DNS dinâmica dos containers e roteia `/` ao frontend, `/api/` ao backend (com `proxy_request_buffering off`), `/streams/` e `/media/` ao repository e `/message/` ao painel do RabbitMQ. |
| `frontend` | `frontend/` | Interface de estúdio multimídia HTML5/CSS3/JS puro (`hls.js@1.5.17` fixado) na paleta clara original (`#f4f4f9` / `#ffffff` / `#0066cc`). Layout de 2 colunas com dropzone drag-and-drop (preview local instantâneo), contadores globais em tempo real, busca, abas de filtro (`Todos`, `Vídeos`, `Áudios`, `Imagens`) com contagem por categoria e galeria de cards com **miniaturas 16:9 para os 3 tipos**: frame `thumb.jpg` extraído pelo FFmpeg (com fallback client-side via HLS + Canvas) para vídeos, forma de onda acústica gerada em Canvas 2D para áudios e miniatura WebP com fundo xadrez de transparência para imagens. |
| `backend` | `backend/` | API REST Express (`POST /files`, `GET /files` com suporte a `?type=video|audio|image` e `?status=...` ordenado por data, `GET /files/:id`, `GET /files/:id/file` e aliases `/upload`, `/videos`). Faz streaming direto do upload para o SeaweedFS Filer (`raw/{file_id}/original`), persiste estado em `/data/videos_state.json` via módulo `store`, publica `file.uploaded` na exchange `media.events` e consome a fila `media.backend`. |
| `process-router` | `process/` (`WORKER_TYPE=router`) | Worker roteador (`0.50 CPU / 256M`). Consome `file.uploaded`, baixa o arquivo bruto do Filer para `/tmp`, inspeciona magic bytes (`file-type`), metadados de imagem (`sharp`) e fluxos de mídia (`ffprobe`), valida limites por tipo (`MAX_IMAGE_SIZE_BYTES`, `MAX_AUDIO_SIZE_BYTES`, `MAX_VIDEO_SIZE_BYTES`) e publica `video.uploaded`, `audio.uploaded` ou `image.uploaded` (ou apaga o raw do Filer e publica `file.rejected`). |
| `process-video` | `process/` (`WORKER_TYPE=video`) | Worker Node.js + FFmpeg (`2.00 CPU / 2G`). Consome `video.uploaded`, baixa o raw direto do Filer para `/tmp`, gera segmentos HLS e miniatura `thumb.jpg` em `/tmp/hls/{file_id}`, envia os artefatos para `processed/videos/{file_id}/...` no Filer, publica `video.ready` (com `thumbnail_url`) e remove o raw do Filer (ou faz retry via DLX até publicar `video.failed`). |
| `process-image` | `process/` (`WORKER_TYPE=image`) | Worker Node.js + `sharp` (`1.00 CPU / 512M`). Consome `image.uploaded`, publica `image.processing`, aplica orientação EXIF (`.rotate()`) removendo metadados EXIF, preserva canal alpha, converte para WebP (`<= 300 KB`, máx. `2048x2048` com loop de qualidades `[85, 75, 65, 55, 45]` e redução progressiva de 15% até 320px), grava em `processed/images/{file_id}.webp`, publica `image.ready` e remove o raw do Filer. |
| `process-audio` | `process/` (`WORKER_TYPE=audio`) | Worker Node.js + `ffmpeg`/`ffprobe` (`1.00 CPU / 512M`). Consome `audio.uploaded`, publica `audio.processing`, extrai duração e tags (`title`, `artist`) via `ffprobe`, aplica as 3 regras de transcodificação (`mp3 <= 128k` copy `.mp3`; `aac/m4a <= 128k` copy `.m4a`; demais reencodam `-vn -c:a aac -b:a 128k -movflags +faststart` `.m4a`), grava em `processed/audio/{file_id}.{mp3|m4a}`, publica `audio.ready` e remove o raw do Filer. |
| `repository` | `repository/` | Serviço Express que serve `/streams/:videoId/*` (`processed/videos/{file_id}/...`) e `/media/*` (`processed/images/...` e `processed/audio/...`, com `Cache-Control: public, max-age=31536000, immutable` e suporte a `Range` HTTP `206 Partial Content`) fazendo proxy em streaming a partir do SeaweedFS Filer com validação `path.posix.resolve` + prefixo. |
| `rabbitmq` | `rabbitMQ/` | Broker AMQP (`rabbitmq:3.13-management`) na rede interna. |
| `master` | `chrislusf/seaweedfs:3.65` | Coordenador de topologia e volumes do SeaweedFS (rede interna, volume `seaweed_master_data`). |
| `volume` | `chrislusf/seaweedfs:3.65` | Servidor de armazenamento de blocos do SeaweedFS (rede interna, volume `seaweed_volume_data`). |
| `filer` | `chrislusf/seaweedfs:3.65` | Camada de diretórios/metadados HTTP do SeaweedFS na porta interna `8888` (volume `seaweed_filer_data`). |
| `infra` | `infra/deploys/` | Manifestos K3s e KEDA (`process.yaml` com 4 Deployments e 4 `ScaledObjects` por fila: `file.uploaded` com `minReplicaCount: 1`, `video.uploaded`, `audio.uploaded`, `image.uploaded` com volumes `emptyDir` em `/tmp`; `gateway.yaml`; `repository.yaml`). |

## Módulos Compartilhados (`shared/`)

- **`shared/events.js`**:
  - Declara a exchange topic `media.events` e a lista fechada de 14 eventos (`file.uploaded`, `file.rejected`, `{video,audio,image}.uploaded`, `{video,audio,image}.processing`, `{video,audio,image}.ready`, `{video,audio,image}.failed`).
  - Declara a fila `media.backend` com 10 bindings explícitos (sem curingas).
  - Declara a infraestrutura de retry com backoff exponencial (`media.retry` -> `media.retry.wait` com `x-dead-letter-exchange: media.events`), controlada pelo header `x-retry-count` (3 tentativas antes de publicar `<tipo>.failed`).
- **`shared/storage.js`**:
  - Cliente HTTP (`axios`) para o SeaweedFS Filer (`FILER_URL`) com operações `put`, `get`, `getStream`, `head` e `delete`.
  - Prefixos determinísticos: `raw/{file_id}/original`, `processed/videos/{file_id}/...`, `processed/images/{file_id}.webp`, `processed/audio/{file_id}.{m4a|mp3}`.
  - Sanitização de nomes de arquivo e validação de caminhos com `path.posix.resolve` + checagem de prefixo.
- **`backend/store.js`**:
  - Gerencia `videos_state.json` com escrita atômica (`.tmp` + `rename`).
  - Máquina de estados monotônica (`uploaded` → `processing` → `ready | failed | rejected`), ignorando transições regressivas e garantindo idempotência por `file_id`.
