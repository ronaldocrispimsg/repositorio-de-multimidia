# VideoBox

**Sistema Distribuído para Upload, Processamento e Consumo de Vídeos**

---

## Contexto

O **VideoBox** é um sistema distribuído desenvolvido como trabalho final da disciplina **Sistemas Distribuídos**, com o objetivo de aplicar conceitos como **arquitetura orientada a eventos**, **processamento assíncrono**, **orquestração de serviços** e **streaming de mídia**.

O sistema permite que usuários façam upload de vídeos e os assistam posteriormente utilizando o protocolo **HLS (HTTP Live Streaming)**, após processamento distribuído.

---

## Objetivos

1. Implementar um sistema distribuído realista e desacoplado
2. Utilizar as tecnologias **Docker, RabbitMQ, NGINX, Node.js (Express) e FFMPEG**
3. Permitir o upload de vídeos pelos usuários via interface web
4. Permitir o consumo dos vídeos via **HLS** com player integrado
5. Aplicar comunicação assíncrona baseada em eventos (AMQP)
6. Demonstrar escalabilidade horizontal orientada a eventos no processamento de vídeos
7. Garantir controle local e permissões diretas sobre os arquivos brutos e processados

---

## Arquitetura & Stack

O sistema é composto por módulos modulares, cada um encapsulado em seu próprio container com Dockerfile e configurações em arquivos `.env`:

### NGINX (Gateway)

* Atua como **entrypoint do sistema** (porta 80)
* Responsável por:
  * API Gateway
  * Reverse proxy
  * Centralização do acesso aos serviços
  * Roteamento para frontend (`/`), backend (`/api/`) e RabbitMQ (`/message/`)

---

### Backend (Node.js + Express + AMQP)

* Responsável pelas **APIs RESTful** (porta 8000)
* Implementa as **regras de negócio** e persistência de estado (`videos_state.json`)
* Publica eventos na fila `video.uploaded` do **RabbitMQ**
* Escuta os eventos `video.processing` e `video.ready` para manter o status atualizado
* Disponibiliza download do arquivo bruto original (`/videos/:videoId/file`)

---

### Frontend (HTML, CSS e JavaScript Puro)

* Interface leve, responsiva e moderna, sem frameworks adicionais
* Permite:
  * Upload de vídeos com feedback em tempo real
  * Monitoramento dinâmico de status dos vídeos
  * Reprodução direta via player integrado com suporte a HLS (`hls.js`)
* Comunicação via API REST com o backend (via Gateway em `/api` ou direto na porta 8000)

---

### RabbitMQ

* Broker de mensagens (AMQP na porta 5672 e painel de gerenciamento na porta 15672)
* Utiliza imagem oficial com plugin de gerenciamento
* Responsável pela **comunicação assíncrona orientada a eventos**
* Desacopla o recebimento, a fila de processamento e a entrega

---

### Process (Node.js Worker + FFMPEG)

* Serviço worker responsável pelo **processamento e transcode dos vídeos**
* Consome eventos da fila `video.uploaded` do RabbitMQ
* Notifica o início do processamento via fila `video.processing`
* Orquestra o **FFMPEG** nativo para converter arquivos brutos em:
  * Playlists `playlist.m3u8`
  * Segmentos HLS (`.ts`)
* Envia os fragmentos gerados via HTTP multipart para o serviço `repository`
* Publica o evento `video.ready` com a URL do stream gerado

---

### Repository (Node.js + Express)

* Serviço de armazenamento e entrega de streaming HLS na pasta `repository/processed_videos` (porta 8001)
* Endpoints para receber os fragmentos (`POST /videos/:videoId/segments`) e finalizar o pacote (`POST /videos/:videoId/complete`)
* Serve diretamente as playlists e fragmentos via HTTP (`GET /streams/*`) para o player
* Habilita CORS para transmissões sem bloqueio no navegador

---

### Permissões e Armazenamento Local

* Todos os diretórios de armazenamento (`backend/videos_raw`, `process/export`, `repository/processed_videos`) utilizam montagens diretas do host (*bind mounts*).
* Os containers rodam com `user: "1000:1000"`, garantindo que todos os arquivos criados pertençam ao usuário local no host, sem problemas de permissão ou necessidade de `sudo` para gerenciá-los ou excluí-los.

---

## Fluxo de Funcionamento

1. O usuário seleciona e envia um vídeo pelo frontend.
2. O backend salva o arquivo bruto em `backend/videos_raw` e emite o evento `video.uploaded` no RabbitMQ.
3. O worker **Process**:
   * Consome o evento `video.uploaded`
   * Emite `video.processing` para atualizar o status no sistema
   * Baixa o arquivo do backend e executa o FFMPEG para gerar o streaming HLS
4. Concluída a conversão, o **Process**:
   * Envia os fragmentos e a playlist para a pasta `processed_videos` do **Repository**
   * Emite o evento `video.ready` com a URL do stream gerado
5. O backend recebe `video.ready` e marca o vídeo como pronto no estado persistido.
6. O frontend atualiza a lista e o usuário assiste ao vídeo via **HLS** no player.

---

## Eventos do Sistema

| Evento | Origem | Destino | Descrição |
| --- | --- | --- | --- |
| `video.uploaded` | Backend | Process | Novo vídeo enviado e disponível para conversão |
| `video.processing` | Process | Backend | Conversão iniciada pelo FFMPEG |
| `video.ready` | Process | Backend / Frontend | Conversão finalizada e streaming HLS disponível |

---

## Estrutura do Projeto

```text
/backend      # API REST em Node.js (Express), uploads e integração RabbitMQ
/frontend     # Interface web em HTML5, CSS3 e JavaScript puro
/process      # Worker assíncrono em Node.js e conversão FFMPEG
/rabbitMQ     # Broker RabbitMQ com dashboard
/repository   # Servidor de streaming HLS em Node.js (Express) e processed_videos
/nginx        # Gateway NGINX e proxy reverso unificado
/infra        # Manifestos K3s (Deployment, KEDA ScaledObject, Storage)
```

---

## Instalação e Execução

### Pré-requisitos

* Docker
* Docker Compose

### Configuração

Cada módulo possui um arquivo `.env.example`. Copie-o para `.env` no mesmo diretório (`cp backend/.env.example backend/.env`, e assim para os demais). Os arquivos `.env` não são versionados.

Antes de subir, troque `CHANGE_ME` por uma senha própria. O valor deve ser o mesmo em `rabbitMQ/.env` (`RABBITMQ_DEFAULT_PASS`) e nas `RABBIT_URL` de `backend/.env` e `process/.env`. Se a senha tiver caracteres especiais, codifique-os na URL (percent-encoding). Sem `RABBIT_URL`, backend e process encerram com erro.

### Execução Local (Docker Compose)

1. Clone o repositório
2. Acesse a pasta do projeto
3. Inicie os containers:

```bash
docker compose up --build
```

4. Acessos locais disponíveis:
   * **Aplicação Web (Frontend)**: `http://localhost` (ou `http://localhost:3000`)
   * **API Backend**: `http://localhost/api/videos` (ou direto em `http://localhost:8000/videos`)
   * **Healthcheck do Backend**: `http://localhost:8000/health`
   * **Servidor de Streams (Repository)**: `http://localhost:8001/health`
   * **Painel RabbitMQ**: `http://localhost:15672` (ou via Gateway em `http://localhost/message/`, usuário e senha definidos em `rabbitMQ/.env`)
