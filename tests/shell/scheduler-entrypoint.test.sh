#!/usr/bin/env bash
# Gate do docker/scheduler/entrypoint.sh — o único artefato executável novo da
# doutrina de packaging, e o que ficou sem cobertura na primeira versão dela.
#
# O que ele guarda, e por que cada coisa:
#
# 1. O SEGREDO SOBREVIVE INTEIRO E LITERAL. O crond executa cada linha do crontab
#    por `/bin/sh -c`, então o valor é REAVALIADO na hora de disparar. A versão
#    anterior interpolava o INTERNAL_SECRET dentro de aspas duplas: um `$` no
#    valor virava expansão de variável (header truncado → todo cron respondendo
#    401 em silêncio) e uma crase virava substituição de comando — execução
#    arbitrária a cada minuto. Aqui o teste monta o header com um `sh` DE VERDADE,
#    como o crond faria, e compara byte a byte.
#
# 2. NENHUMA ROTA SE PERDE. O crontab saiu do `command:` inline do compose e veio
#    para cá; a contagem tem de bater com app/api/v1/cron. (A cerca principal é
#    tests/unit/cron-routes-scheduled.test.ts; esta aqui pega o caso em que o
#    arquivo GERADO diverge da lista escrita, que aquele teste não vê.)
#
# 3. FALHA FECHADA SEM SEGREDO. Sem INTERNAL_SECRET os crons responderiam 401 e
#    nada aconteceria — sem erro, sem log, sem sintoma. O script recusa subir.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENTRYPOINT="docker/scheduler/entrypoint.sh"
fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check() {
  local nome="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  ✓ %s\n' "$nome"
  else printf '  ✗ %s\n' "$nome"; fail=1; fi
}

# `crond` dublado: o entrypoint termina em `exec crond`, que não existe no macOS
# nem no runner. Sem o dublê o script morreria DEPOIS de escrever o crontab — o
# arquivo estaria certo e o teste falharia por motivo errado.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/crond"
chmod +x "$TMP/bin/crond"

rodar() { # $1 = valor de INTERNAL_SECRET ("" = ausente)
  local out="$TMP/crontab"
  : > "$out"
  rm -rf "$TMP/cabecalho"
  if [ -z "$1" ]; then
    env -u INTERNAL_SECRET PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" CRON_HEADER_DIR="$TMP/cabecalho" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  else
    env INTERNAL_SECRET="$1" PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" CRON_HEADER_DIR="$TMP/cabecalho" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  fi
  echo $?
}

echo "scheduler: o crontab é gerado com todas as rotas"
RC="$(rodar 'segredo-simples')"
check "o entrypoint termina com sucesso" test "$RC" -eq 0
ROTAS_CODIGO="$(find app/api/v1/cron -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
ROTAS_CRONTAB="$(grep -oE 'api/v1/cron/[a-z0-9-]+' "$TMP/crontab" | sort -u | wc -l | tr -d ' ')"
check "as $ROTAS_CODIGO rotas do código estão no crontab (achei $ROTAS_CRONTAB)" \
  test "$ROTAS_CODIGO" -eq "$ROTAS_CRONTAB"
check "uma linha por cron, nenhuma vazia" \
  test "$(grep -c . "$TMP/crontab")" -eq "$(wc -l < "$TMP/crontab" | tr -d ' ')"

echo "scheduler: o segredo atravessa o sh do crond intacto"
# Os três caracteres que quebram interpolação ingênua, de uma vez só.
HOSTIL='seg`whoami`redo$HOME-com'\''aspa-e-"aspas"'
RC="$(rodar "$HOSTIL")"
check "gerou o crontab mesmo com segredo cheio de metacaractere" test "$RC" -eq 0

# A medição que importa: pegar a PRIMEIRA linha, tirar o prefixo de agendamento,
# e mandar um `sh` de verdade avaliá-la — exatamente o que o crond faz. O `curl`
# é dublado por um script que imprime o header que recebeu — e, como o curl de
# verdade, com `-H @arquivo` o header é o CONTEÚDO do arquivo (sem a quebra final).
printf '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-H" ]; then case "$2" in @*) f="${2#@}"; printf "%%s" "$(cat "$f")";; *) printf "%%s" "$2";; esac; exit 0; fi; shift; done\nexit 1\n' > "$TMP/bin/curl"
chmod +x "$TMP/bin/curl"
LINHA="$(head -1 "$TMP/crontab")"
COMANDO="${LINHA#* * * * * }"                 # tira o agendamento de 5 campos
COMANDO="${COMANDO%% >/dev/null*}"            # tira a redireção
RECEBIDO="$(PATH="$TMP/bin:$PATH" sh -c "$COMANDO")"
ESPERADO="Authorization: Bearer ${HOSTIL}"
if [ "$RECEBIDO" = "$ESPERADO" ]; then
  printf '  ✓ o header chega ao curl byte a byte igual ao segredo do .env\n'
else
  printf '  ✗ o segredo foi corrompido pelo sh do crond\n'
  printf '     esperado: %s\n' "$ESPERADO"
  printf '     recebido: %s\n' "$RECEBIDO"
  fail=1
fi
# Controle negativo do próprio instrumento: se a crase tivesse sido executada, o
# arquivo do header conteria a saída de `whoami` no lugar dela, não o texto literal.
check "a crase NÃO foi executada (está literal no arquivo do header)" \
  grep -q 'whoami' "$TMP/cabecalho/cron-header"

echo "scheduler: o segredo não aparece em linha de comando nem no crontab"
# Na linha de comando ele ficava em /proc/<pid>/cmdline a cada disparo — o `ps`
# do host (docker top) o mostrava. Agora o curl lê o header de um arquivo.
check "o crontab não contém o segredo" sh -c "! grep -qF 'whoami' '$TMP/crontab'"
check "o crontab não contém 'Bearer'" sh -c "! grep -q 'Bearer' '$TMP/crontab'"
check "toda linha lê o header de arquivo (-H @…)" \
  test "$(grep -c -- "-H '@" "$TMP/crontab")" -eq "$(grep -c . "$TMP/crontab")"
check "o arquivo do header é só do dono (0600)" \
  sh -c "ls -l '$TMP/cabecalho/cron-header' | grep -q '^-rw-------'"
check "o diretório do header é só do dono (0700)" \
  sh -c "ls -ld '$TMP/cabecalho' | grep -q '^drwx------'"

echo "scheduler: sem INTERNAL_SECRET, recusa em vez de subir mudo"
RC="$(rodar '')"
check "sai com código 1" test "$RC" -eq 1
check "explica o motivo na saída" grep -q "INTERNAL_SECRET" "$TMP/saida"
check "não deixou crontab pela metade" test ! -s "$TMP/crontab"

echo "scheduler: a origem do app (padrão app:3000; o compose do Dokploy repassa outra)"
RC="$(rodar 'segredo-simples')"
check "sem SCHEDULER_APP_ORIGIN, chama http://app:3000 (como sempre)" \
  bash -c '[ "$(grep -c "\"http://app:3000/api/v1/cron/" "$1")" -eq "$(grep -c . "$1")" ]' _ "$TMP/crontab"
: > "$TMP/crontab"
env INTERNAL_SECRET=s SCHEDULER_APP_ORIGIN=http://imobcrm-app:3000 PATH="$TMP/bin:$PATH" \
  CRONTAB_PATH="$TMP/crontab" sh "$ENTRYPOINT" >"$TMP/saida" 2>&1; RC=$?
check "com SCHEDULER_APP_ORIGIN, toda linha usa a origem dada" \
  bash -c '[ "$1" -eq 0 ] && [ "$(grep -c "\"http://imobcrm-app:3000/api/v1/cron/" "$2")" -eq "$(grep -c . "$2")" ]' _ "$RC" "$TMP/crontab"
: > "$TMP/crontab"
env INTERNAL_SECRET=s SCHEDULER_APP_ORIGIN='http://x`whoami`:3000' PATH="$TMP/bin:$PATH" \
  CRONTAB_PATH="$TMP/crontab" sh "$ENTRYPOINT" >"$TMP/saida" 2>&1; RC=$?
check "origem com metacaractere é recusada (ela entra entre aspas duplas no crontab)" \
  bash -c '[ "$1" -eq 1 ] && [ ! -s "$2" ] && grep -q SCHEDULER_APP_ORIGIN "$3"' _ "$RC" "$TMP/crontab" "$TMP/saida"

if [ "$fail" -eq 0 ]; then
  echo "OK — todas as provas passaram."
else
  echo "FALHOU."
fi
exit "$fail"
