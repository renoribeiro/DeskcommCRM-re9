#!/usr/bin/env bash
# Backup da instalação feita pelo Dokploy (docker-compose.dokploy.yml): o banco,
# os arquivos (fotos, documentos, mídia do WhatsApp) e as sessões do WhatsApp.
#
#   bash infra/dokploy/backup.sh                      # acha a instalação sozinho
#   bash infra/dokploy/backup.sh --projeto NOME       # quando há mais de uma
#   bash infra/dokploy/backup.sh --destino /root/backups-imobcrm --reter-dias 14
#
# Roda no TERMINAL DA VPS (Dokploy › Servidor › Terminal, ou ssh), como root.
# Não para nada: o dump do Postgres é consistente com o sistema no ar.
#
# O que sai, numa pasta com data e hora dentro do destino:
#   db.dump            pg_dump em formato custom (-Fc) do banco inteiro
#   storage-data.tgz   o volume dos arquivos
#   waha-data.tgz      o volume das sessões do WhatsApp (sem ele, é parear de novo)
#   SHA256SUMS         soma de cada arquivo, para conferir depois de copiar
#
# Cada peça é CONFERIDA antes de a pasta receber o nome final: o dump tem de ser
# legível pelo pg_restore (`--list`) e cada .tgz tem de passar no `gzip -t`. Um
# backup que não se lê é apagado — ninguém deve confiar nele. A pasta só nasce
# com o nome final (AAAA-MM-DD_HHMMSS) quando tudo passou; até lá ela se chama
# `.parcial-…`.
#
# Retenção: apaga as pastas COMPLETAS (com SHA256SUMS) mais velhas que
# --reter-dias (padrão 7), e só depois de o backup de agora ter dado certo.
#
# Restauração: docs/imobiliario/03-instalacao-vps-dokploy.md, seção "Restaurar".
#
# Agende pelo cron da VPS (ex.: todo dia às 3h10):
#   10 3 * * * bash /root/imobcrm/infra/dokploy/backup.sh >> /var/log/imobcrm-backup.log 2>&1
# E copie a pasta de destino para FORA da VPS: backup que mora no mesmo disco
# morre junto com ele.
set -euo pipefail

projeto=""
destino="/root/backups-imobcrm"
reter_dias=7
# Imagem de utilidade para o tar dos volumes: a mesma que o kit usa, tag fixa.
IMAGEM_TAR="${IMAGEM_TAR:-alpine:3.20}"
# Quem faz o dump: o superusuário do Supabase lê todos os schemas (auth,
# storage, _realtime…), o que o papel `postgres` não garante.
DUMP_USUARIO="${DUMP_USUARIO:-supabase_admin}"

uso() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

while (($#)); do
  case "$1" in
    --projeto) projeto="${2:-}"; shift ;;
    --destino) destino="${2:-}"; shift ;;
    --reter-dias) reter_dias="${2:-}"; shift ;;
    -h|--help) uso; exit 0 ;;
    *) uso >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[backup] %s\n' "$*"; }
morre() { printf '[backup] ERRO: %s\n' "$*" >&2; exit 1; }

[[ "$reter_dias" =~ ^[0-9]+$ ]] && [ "$reter_dias" -ge 1 ] || morre "--reter-dias precisa ser um número inteiro maior que zero (veio '$reter_dias')"
[ -n "$destino" ] || morre "--destino vazio"
command -v docker >/dev/null 2>&1 || morre "docker não encontrado — rode no terminal da VPS"
command -v sha256sum >/dev/null 2>&1 || morre "sha256sum não encontrado"
command -v gzip >/dev/null 2>&1 || morre "gzip não encontrado"

# ── Qual instalação ──────────────────────────────────────────────────────────
# O Dokploy dá ao projeto do compose o nome do serviço (ex.: imobcrm-a1b2c3). O
# que identifica ESTA instalação é o arquivo de compose que a criou.
if [ -z "$projeto" ]; then
  candidatos="$(docker ps -a --filter label=com.docker.compose.service=db \
      --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.config_files"}}' \
    | awk -F'|' '$2 ~ /docker-compose\.dokploy\.yml/ { print $1 }' | sort -u)"
  n="$(printf '%s' "$candidatos" | grep -c . || true)"
  if [ "$n" -eq 0 ]; then
    morre "não achei nenhuma instalação do docker-compose.dokploy.yml nesta máquina (o serviço db está criado?)"
  elif [ "$n" -gt 1 ]; then
    morre "achei mais de uma instalação — escolha com --projeto: $(printf '%s' "$candidatos" | tr '\n' ' ')"
  fi
  projeto="$candidatos"
fi
[[ "$projeto" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || morre "nome de projeto inválido: '$projeto'"
log "instalação: $projeto"

db="$(docker ps -q --filter "label=com.docker.compose.project=$projeto" --filter label=com.docker.compose.service=db | head -1)"
[ -n "$db" ] || morre "o contêiner do banco do projeto '$projeto' não está rodando"

volume() {  # volume <nome no compose> → nome real do volume
  local v
  v="$(docker volume ls -q --filter "label=com.docker.compose.project=$projeto" --filter "label=com.docker.compose.volume=$1" | head -1)"
  [ -n "$v" ] || morre "não achei o volume '$1' do projeto '$projeto'"
  printf '%s' "$v"
}
vol_storage="$(volume storage-data)"
vol_waha="$(volume waha-data)"

# ── A pasta ──────────────────────────────────────────────────────────────────
umask 077
mkdir -p "$destino"
destino="$(cd "$destino" && pwd -P)"
carimbo="$(date +%Y-%m-%d_%H%M%S)"
parcial="$destino/.parcial-$carimbo"
final="$destino/$carimbo"
[ ! -e "$final" ] || morre "já existe $final"
mkdir "$parcial"
# Qualquer saída antes do fim apaga o parcial: meio backup não fica com cara de backup.
trap 'rm -rf "$parcial"' EXIT

# ── Banco ────────────────────────────────────────────────────────────────────
log "banco: pg_dump -Fc (o sistema continua no ar)"
docker exec "$db" pg_dump -h 127.0.0.1 -U "$DUMP_USUARIO" -d postgres -Fc > "$parcial/db.dump" \
  || morre "o pg_dump falhou"
[ -s "$parcial/db.dump" ] || morre "o dump saiu vazio"
docker exec -i "$db" pg_restore --list < "$parcial/db.dump" > "$parcial/.lista" 2>/dev/null \
  || morre "o dump não se lê (pg_restore --list reprovou) — backup descartado"
log "banco: $(grep -vc '^;' "$parcial/.lista" || true) objetos no índice do dump"
rm -f "$parcial/.lista"

# ── Volumes ──────────────────────────────────────────────────────────────────
empacota() {  # empacota <volume> <arquivo.tgz>
  docker run --rm -v "$1:/data:ro" -v "$parcial:/out" "$IMAGEM_TAR" \
    tar czf "/out/$2" -C /data . || morre "não consegui empacotar o volume $1"
  gzip -t "$parcial/$2" 2>/dev/null || morre "$2 saiu corrompido (gzip -t reprovou) — backup descartado"
  log "$2: $(du -h "$parcial/$2" | cut -f1)"
}
empacota "$vol_storage" storage-data.tgz
empacota "$vol_waha" waha-data.tgz

( cd "$parcial" && sha256sum db.dump storage-data.tgz waha-data.tgz > SHA256SUMS )
mv "$parcial" "$final"
trap - EXIT
log "pronto: $final"

# ── Retenção ─────────────────────────────────────────────────────────────────
# Só pastas com o nome que este script dá E com SHA256SUMS (backup completo).
# Pastas parciais velhas (de uma rodada interrompida à força) também saem.
find "$destino" -mindepth 1 -maxdepth 1 -type d -name '.parcial-*' -mtime +1 -exec rm -rf {} +
while IFS= read -r velho; do
  [ -f "$velho/SHA256SUMS" ] || continue
  rm -rf "$velho"
  log "retenção: apaguei ${velho##*/} (mais de $reter_dias dias)"
done < <(find "$destino" -mindepth 1 -maxdepth 1 -type d \
  -regex '.*/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]' -mtime +"$((reter_dias - 1))")
