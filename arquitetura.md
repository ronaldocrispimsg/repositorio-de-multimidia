# Arquitetura do VideoBox

Atualizado em 2026-11-02 (Fase 1: Fundação). Descreve o estado real comprovado no código.

## Serviços (Docker Compose)

| Serviço | Imagem / Pasta | Função |
| --- | --- | --- |
| `gateway` | `nginx/` | Único ponto de entrada público (porta `80`). Roteia `/` ao frontend, `/api/` ao backend (com `proxy_request_buffering off`), `/streams/` ao repository e `/message/` ao painel do RabbitMQ. |
| `frontend` | `frontend/` | Interface estática HTML5/CSS3/JS puro, player HLS (`hls.js`). |
| `backend` | `backend/` | API REST Express. Faz streaming direto do upload para o SeaweedFS Filer (`raw/{file_id}/original`), persiste estado em `/data/videos_state.json` via módulo `store` (volume `backend_state`), publica eventos na exchange `media.events` e consome a fila `media.backend`. |
| `process` | `process/` | Worker Node.js + FFmpeg. Consome `video.uploaded`, baixa o raw direto do Filer para `/tmp`, gera segmentos HLS em `/tmp/hls/{file_id}`, envia os artefatos para `processed/videos/{file_id}/...` no Filer e publica `video.ready` ou faz retry via DLX até publicar `video.failed`. |
| `repository` | `repository/` | Serviço Express que serve `/streams/:videoId/*` fazendo proxy em streaming a partir do SeaweedFS Filer (`processed/videos/{file_id}/...`) com validação `path.posix.resolve` + prefixo. |
| `rabbitmq` | `rabbitMQ/` | Broker AMQP (`rabbitmq:3.13-management`) na rede interna. |
| `master` | `chrislusf/seaweedfs:3.65` | Coordenador de topologia e volumes do SeaweedFS (rede interna, volume `seaweed_master_data`). |
| `volume` | `chrislusf/seaweedfs:3.65` | Servidor de armazenamento de blocos do SeaweedFS (rede interna, volume `seaweed_volume_data`). |
| `filer` | `chrislusf/seaweedfs:3.65` | Camada de diretórios/metadados HTTP do SeaweedFS na porta interna `8888` (volume `seaweed_filer_data`). |
| `infra` | `infra/deploys/` | Manifestos K3s e KEDA (escala o `process` pela fila `video.uploaded`). |

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
