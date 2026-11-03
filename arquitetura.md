# Arquitetura do VideoBox

Atualizado em 2026-11-02 (Fase 0: higiene). Descreve o que existe no código hoje.

## Serviços (Docker Compose)

| Serviço | Pasta | Função |
| --- | --- | --- |
| gateway | `nginx/` | Entrada (porta 80). Roteia `/` ao frontend, `/api/` ao backend, `/message/` ao painel do RabbitMQ. |
| frontend | `frontend/` | HTML/CSS/JS puro, player hls.js. |
| backend | `backend/` | API Express. Recebe upload (multer), grava o raw em disco, mantém `videos_state.json`, publica `video.uploaded` e consome `video.processing` e `video.ready`. |
| process | `process/` | Worker. Consome `video.uploaded`, baixa o raw do backend, gera HLS com FFmpeg, envia ao repository por HTTP e publica `video.ready`. |
| repository | `repository/` | Express. Recebe segmentos HLS e serve `/streams/*` do disco. |
| rabbitmq | `rabbitMQ/` | Broker AMQP (3.13-management). |
| infra | `infra/deploys/` | Manifestos K3s e KEDA (escala o `process` pela fila `video.uploaded`). |

## Configuração e segredos

- Cada serviço lê as variáveis de `<serviço>/.env`, que não é versionado (ver `.gitignore`). O modelo é `<serviço>/.env.example`, com `CHANGE_ME` no lugar das senhas.
- `backend` e `process` encerram com erro se `RABBIT_URL` não estiver definida (não há mais senha padrão no código).
- O Secret `rabbitmq-secret` em `infra/deploys/process.yaml` é um placeholder. O valor real deve ser criado fora do Git.
- As imagens de `backend`, `process` e `repository` usam `npm ci` com `package-lock.json` e ignoram `.env` no contexto de build (`.dockerignore`).

## Pendências conhecidas

- O nginx do gateway copia `nginx/.env` para a imagem (`COPY .env`). Esse arquivo só tem upstreams, sem segredo.
- Portas 3000, 8000, 8001, 5672 e 15672 ainda são publicadas no compose (a unificação no gateway está planejada).
- O histórico do Git contém as credenciais antigas. Elas devem ser tratadas como expostas e rotacionadas.
