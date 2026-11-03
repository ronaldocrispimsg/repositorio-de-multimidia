#!/bin/sh
set -euo pipefail

ENV_FILE="/etc/nginx/.env"

if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
fi

TEMPLATE="/etc/nginx/templates/default.conf.template"
TARGET="/etc/nginx/conf.d/default.conf"

if [ ! -f "$TEMPLATE" ]; then
    echo "Arquivo de template não encontrado em $TEMPLATE" >&2
    exit 1
fi

mkdir -p "$(dirname "$TARGET")"

envsubst '${FRONTEND_UPSTREAM} ${BACKEND_UPSTREAM} ${REPOSITORY_UPSTREAM} ${RABBIT_UPSTREAM} ${CLIENT_MAX_BODY_SIZE}' \
    < "$TEMPLATE" > "$TARGET"

exec nginx -g 'daemon off;'
