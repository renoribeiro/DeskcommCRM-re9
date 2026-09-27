#!/usr/bin/env bash
# Prova de COMPORTAMENTO do infra/dokploy/backup.sh (instalação pelo Dokploy).
#
#   bash tests/shell/dokploy-backup.test.sh
#
# Nada aqui toca a máquina de quem roda: `docker` é um dublê que responde como
# o Docker responderia (contêiner do banco, volumes do projeto, pg_dump,
# pg_restore --list e o tar num contêiner descartável) e registra o que recebeu.
# O tar e o gzip são DE VERDADE, sobre pastas locais que fazem papel de volume:
# a conferência do script (gzip -t, sha256sum) roda contra arquivos reais.
set -uo pipefail
unset COMPOSE_PROJECT_NAME

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKUP="$ROOT/infra/dokploy/backup.sh"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }
contem() { grep -qF -- "$2" "$1" || { printf '    [%s] não está em %s\n' "$2" "$1"; return 1; }; }

# ── "volumes" locais e o dublê ───────────────────────────────────────────────
VOLS="$WORK/volumes"
mkdir -p "$VOLS/imobcrm-x1_storage-data/stub/whatsapp-media" "$VOLS/imobcrm-x1_waha-data/default"
echo "foto" > "$VOLS/imobcrm-x1_storage-data/stub/whatsapp-media/a.jpg"
echo "sessao" > "$VOLS/imobcrm-x1_waha-data/default/creds.json"
LOG="$WORK/docker.log"
FLAGS="$WORK/flags"; mkdir -p "$WORK/bin" "$FLAGS"
{
  printf '#!/usr/bin/env bash\nLOG=%q\nFLAGS=%q\nVOLS=%q\n' "$LOG" "$FLAGS" "$VOLS"
  cat <<'STUB'
printf '%s\n' "$*" >> "$LOG"
case "$1" in
  ps)
    case " $* " in
      *"-a "*)  # descoberta: projeto|arquivos de compose
        printf '%b' "${PROJETOS-imobcrm-x1|/etc/dokploy/compose/imobcrm-x1/code/docker-compose.dokploy.yml\noutro-sistema|/srv/outro/docker-compose.yml\n}" ;;
      *"com.docker.compose.project=imobcrm-x1"*) [ -f "$FLAGS/db-parado" ] || echo "c0ffee" ;;
    esac ;;
  volume)
    case " $* " in
      *"project=imobcrm-x1"*"volume=storage-data"*) echo "imobcrm-x1_storage-data" ;;
      *"project=imobcrm-x1"*"volume=waha-data"*) [ -f "$FLAGS/sem-waha" ] || echo "imobcrm-x1_waha-data" ;;
    esac ;;
  exec)
    case " $* " in
      *" pg_dump "*) [ -f "$FLAGS/dump-vazio" ] || printf 'PGDMP-fake-dump\n' ;;
      *" pg_restore "*"--list"*)
        entrada="$(cat)"
        [ -f "$FLAGS/dump-ilegivel" ] && exit 1
        case "$entrada" in PGDMP*) printf ';\n; Archive\n1; 0 0 TABLE public organizations\n' ;; *) exit 1 ;; esac ;;
    esac ;;
  run)
    # docker run --rm -v VOL:/data:ro -v DIR:/out IMAGEM tar czf /out/ARQ -C /data .
    vol=""; out=""; arq=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) case "$2" in *:/data:ro) vol="${2%%:/data:ro}";; *:/out) out="${2%%:/out}";; esac; shift ;;
        czf) arq="${2#/out/}"; shift ;;
      esac
      shift
    done
    if [ -f "$FLAGS/tgz-corrompido" ]; then echo "lixo" > "$out/$arq"; exit 0; fi
    tar czf "$out/$arq" -C "$VOLS/$vol" . ;;
esac
exit 0
STUB
} > "$WORK/bin/docker"
chmod +x "$WORK/bin/docker"

rodar() {  # rodar <destino> [args…] → código de saída; saída em $WORK/saida
  local dest="$1"; shift
  PATH="$WORK/bin:$PATH" bash "$BACKUP" --destino "$dest" "$@" > "$WORK/saida" 2>&1
}

echo "backup: caminho feliz"
DEST="$WORK/dest"
rodar "$DEST"; rc=$?
check "termina com sucesso" test "$rc" -eq 0
[ "$rc" -eq 0 ] || cat "$WORK/saida"
pasta="$(find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '20*' | head -1)"
check "cria UMA pasta com data e hora (AAAA-MM-DD_HHMMSS)" \
  bash -c '[ "$(find "$1" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ] && [[ "${2##*/}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}$ ]]' _ "$DEST" "$pasta"
check "achou a instalação pelo arquivo de compose, ignorando o outro sistema" contem "$WORK/saida" "instalação: imobcrm-x1"
check "traz db.dump, storage-data.tgz, waha-data.tgz e SHA256SUMS" \
  bash -c 'for f in db.dump storage-data.tgz waha-data.tgz SHA256SUMS; do [ -s "$1/$f" ] || exit 1; done' _ "$pasta"
check "SHA256SUMS confere com os arquivos" bash -c 'cd "$1" && sha256sum -c SHA256SUMS >/dev/null' _ "$pasta"
check "o tgz dos arquivos traz o conteúdo do volume" \
  bash -c 'tar xzf "$1/storage-data.tgz" -O ./stub/whatsapp-media/a.jpg | grep -qx foto' _ "$pasta"
check "o tgz do WhatsApp traz a sessão" \
  bash -c 'tar xzf "$1/waha-data.tgz" -O ./default/creds.json | grep -qx sessao' _ "$pasta"
check "o dump é feito dentro do contêiner do banco, em formato custom, pelo superusuário" \
  contem "$LOG" "exec c0ffee pg_dump -h 127.0.0.1 -U supabase_admin -d postgres -Fc"
check "o dump é conferido com pg_restore --list" contem "$LOG" "exec -i c0ffee pg_restore --list"
check "os volumes são lidos só-leitura, por imagem de tag fixa" \
  bash -c 'grep -q -- "-v imobcrm-x1_storage-data:/data:ro" "$1" && grep -q " alpine:3.20 tar czf " "$1" && ! grep -q "alpine:latest\|alpine tar" "$1"' _ "$LOG"
check "a pasta nasce fechada (700): o dump tem todas as senhas" \
  bash -c '[ "$(stat -c %a "$1")" = 700 ]' _ "$pasta"
check "não sobra pasta .parcial-" bash -c '! ls -A "$1" | grep -q "^\.parcial-"' _ "$DEST"

echo "backup: retenção"
DEST="$WORK/ret"; mkdir -p "$DEST/2020-01-01_030000" "$DEST/2020-01-02_030000" "$DEST/fotos-do-dono" "$DEST/2020-01-03_030000"
touch "$DEST/2020-01-01_030000/SHA256SUMS" "$DEST/2020-01-02_030000/SHA256SUMS"
novo="$(date +%Y-%m-%d)_010101"; mkdir -p "$DEST/$novo"; touch "$DEST/$novo/SHA256SUMS"
touch -d '10 days ago' "$DEST/2020-01-01_030000" "$DEST/fotos-do-dono" "$DEST/2020-01-03_030000"
touch -d '3 days ago' "$DEST/2020-01-02_030000"
rodar "$DEST" --reter-dias 7; rc=$?
check "com --reter-dias 7, apaga o backup completo de 10 dias" test ! -e "$DEST/2020-01-01_030000"
check "mantém o de 3 dias e o recente" bash -c '[ -d "$1/2020-01-02_030000" ] && [ -d "$1/$2" ]' _ "$DEST" "$novo"
check "não apaga pasta que não é dele (outro nome)" test -d "$DEST/fotos-do-dono"
check "não apaga pasta velha sem SHA256SUMS (não é backup completo dele)" test -d "$DEST/2020-01-03_030000"

echo "backup: falha fecha, e não deixa meio backup nem apaga os antigos"
falha() {  # falha <descrição> <bandeira> <texto esperado>
  local dest="$WORK/f-$2"; mkdir -p "$dest/2020-01-01_030000"; touch "$dest/2020-01-01_030000/SHA256SUMS"
  touch -d '30 days ago' "$dest/2020-01-01_030000"
  touch "$FLAGS/$2"; rodar "$dest" --reter-dias 7; local rc=$?; rm -f "$FLAGS/$2"
  check "$1: sai com erro" test "$rc" -ne 0
  check "$1: explica ('$3')" contem "$WORK/saida" "$3"
  check "$1: nenhuma pasta nova, nem parcial" bash -c '[ "$(ls -A "$1")" = "2020-01-01_030000" ]' _ "$dest"
  check "$1: a retenção não rodou (o antigo continua lá)" test -d "$dest/2020-01-01_030000"
}
falha "dump ilegível" dump-ilegivel "pg_restore --list reprovou"
falha "dump vazio" dump-vazio "o dump saiu vazio"
falha "tgz corrompido" tgz-corrompido "gzip -t reprovou"
falha "banco parado" db-parado "não está rodando"
falha "volume do WhatsApp ausente" sem-waha "waha-data"

echo "backup: escolha da instalação"
PROJETOS='' PATH="$WORK/bin:$PATH" bash "$BACKUP" --destino "$WORK/n0" > "$WORK/saida" 2>&1; rc=$?
check "nenhuma instalação: recusa e diz" bash -c '[ "$1" -ne 0 ] && grep -q "não achei nenhuma instalação" "$2"' _ "$rc" "$WORK/saida"
PROJETOS='a|/x/docker-compose.dokploy.yml\nb|/y/docker-compose.dokploy.yml\n' PATH="$WORK/bin:$PATH" \
  bash "$BACKUP" --destino "$WORK/n2" > "$WORK/saida" 2>&1; rc=$?
check "duas instalações: pede --projeto e lista as duas" \
  bash -c '[ "$1" -ne 0 ] && grep -q -- "--projeto: a b" "$2"' _ "$rc" "$WORK/saida"
rodar "$WORK/n3" --projeto 'x;rm -rf /'; rc=$?
check "nome de projeto com metacaractere é recusado" bash -c '[ "$1" -ne 0 ] && grep -q "nome de projeto inválido" "$2"' _ "$rc" "$WORK/saida"
rodar "$WORK/n4" --reter-dias 0; rc=$?
check "--reter-dias 0 é recusado (não apaga tudo)" test "$rc" -ne 0

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo 'ok: o backup do Dokploy acha a instalação, confere cada peça, fecha em falha e respeita a retenção'
