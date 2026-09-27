#!/bin/sh
# Entrada do serviço `api-gw` (Envoy) do docker-compose.dokploy.yml.
#
# O `cds.yaml` oficial do Supabase aponta cada rota para o NOME do serviço
# (`auth`, `rest`, `storage`, `realtime-dev.supabase-realtime`…). No Dokploy o
# gateway também está na rede compartilhada do Traefik (`dokploy-network`), e lá
# `auth` ou `rest` podem ser o contêiner de OUTRO sistema: o Envoy mandaria
# senha e token de login para quem ganhasse a resolução de nome.
#
# Por isso cada serviço interno tem um apelido único (`imobcrm-*`, só na rede
# privada do compose), e aqui o `cds.yaml` é reescrito para esses apelidos na
# partida. O arquivo vendorizado (infra/dokploy/supabase/) fica intacto: ele é
# montado em CDS_ORIGEM e a cópia reescrita vai para CDS_DESTINO, que é o
# caminho que o envoy.yaml oficial lê.
#
# Falha FECHADA: se sobrar algum endereço fora de `imobcrm-*` (o formato do
# arquivo mudou numa troca de versão do Supabase, por exemplo), o gateway não
# sobe — melhor um erro visível no log do Dokploy do que tráfego para o vizinho.
#
# Os caminhos são injetáveis só para o teste (tests/shell/dokploy-compose.test.sh).
set -eu

CDS_ORIGEM="${CDS_ORIGEM:-/etc/envoy/cds.src.yaml}"
CDS_DESTINO="${CDS_DESTINO:-/etc/envoy/cds.yaml}"
ENTRADA_OFICIAL="${ENTRADA_OFICIAL:-/docker-entrypoint.sh}"
PREFIXO="${ALIAS_PREFIXO:-imobcrm-}"

sed -E \
  -e "s/^([[:space:]]+address:[[:space:]]+)(auth|rest|storage|functions|meta|studio)[[:space:]]*\$/\\1${PREFIXO}\\2/" \
  -e "s/^([[:space:]]+address:[[:space:]]+)realtime-dev\\.supabase-realtime[[:space:]]*\$/\\1${PREFIXO}realtime/" \
  "$CDS_ORIGEM" > "$CDS_DESTINO"

sobras="$(grep -E '^[[:space:]]+address:[[:space:]]' "$CDS_DESTINO" | grep -v "address: ${PREFIXO}" || true)"
if [ -n "$sobras" ]; then
  echo "api-gw: endereço sem apelido único no cds.yaml — recuso subir:" >&2
  printf '%s\n' "$sobras" >&2
  exit 1
fi
echo "api-gw: cds.yaml reescrito para os apelidos ${PREFIXO}*"

exec /bin/sh "$ENTRADA_OFICIAL" "$@"
