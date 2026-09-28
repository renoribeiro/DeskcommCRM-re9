#!/bin/sh
# Serviço `setup` do docker-compose.dokploy.yml. Roda a cada deploy, ANTES do
# app, dentro de um contêiner postgres:17.6-alpine3.22 (psql + wget do busybox).
#
# Faz o que o hostgator-setup-kit/install.sh faz na instalação, na mesma ordem
# e com as mesmas regras:
#   1. extensões vector, citext e pg_trgm no schema public;
#   2. baseline.sql: banco NOVO com ON_ERROR_STOP (schema incompleto = sem RLS,
#      então falha alto); banco EXISTENTE reaplicado em modo update, porque o
#      baseline é idempotente e auto-curativo — é como as atualizações chegam;
#   3. chave de cifra dos segredos em private.app_secrets (ensure_encryption_key);
#   4. primeiro dono: criado no Auth (GoTrue) e promovido a admin da primeira
#      organização e a super-admin da plataforma, com mfa_required=false
#      explícito (o mesmo INSERT do install.sh, e o porquê está lá).
#
# Idempotente: rodar de novo não duplica nada nem troca a senha do dono.
set -eu

: "${DB_URL:?DB_URL ausente}"
: "${AUTH_URL:?AUTH_URL ausente}"
: "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY ausente}"
: "${OWNER_EMAIL:?OWNER_EMAIL ausente}"
# OWNER_PASSWORD só é exigida enquanto o dono não existe (conferido abaixo):
# depois da instalação ela pode sair do Environment do Dokploy.
OWNER_PASSWORD="${OWNER_PASSWORD:-}"
: "${NUVEMSHOP_OAUTH_ENCRYPTION_KEY:?NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente}"
LOCALE="${APP_LOCALE:-pt-BR}"
# De onde vem o baseline.sql. O app, o worker e o scheduler rodam a imagem da
# versão IMAGE_TAG; o arquivo montado do clone é o da PONTA da branch que o
# Dokploy puxou — que pode estar à frente (ou atrás) da imagem. Schema de uma
# versão com código de outra é o defeito que não aparece no deploy e aparece
# na tela. Por isso o padrão é baixar o baseline da TAG v${IMAGE_TAG}:
#   BASELINE_FONTE=versao (padrão) → baixa o da tag; se não conseguir, FALHA.
#   BASELINE_FONTE=clone           → usa o arquivo montado (desenvolvimento e
#                                    teste; nunca numa instalação de cliente).
BASELINE_FONTE="${BASELINE_FONTE:-versao}"
BASELINE_REPO="${BASELINE_REPO:-renoribeiro/DeskcommCRM-re9}"
# Avisos de "já existe" viram ruído no log do Dokploy; erro de verdade continua aparecendo.
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

log() { printf '[setup] %s\n' "$*"; }
q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -tAq "$@"; }

# O log da aplicação do baseline e o arquivo baixado moram num diretório do
# próprio processo (não em /tmp/baseline.log fixo).
TRABALHO="$(mktemp -d)"
trap 'rm -rf "$TRABALHO"' EXIT
BASELINE_LOG="$TRABALHO/baseline.log"

case "$BASELINE_FONTE" in
  clone)
    BASELINE="${BASELINE:-/baseline.sql}"
    log "BASELINE_FONTE=clone: usando o baseline do clone ($BASELINE), não o da versão ${IMAGE_TAG:-?} — só para desenvolvimento e teste"
    ;;
  versao)
    : "${IMAGE_TAG:?IMAGE_TAG ausente: o setup aplica o baseline da mesma versão das imagens}"
    url="https://raw.githubusercontent.com/${BASELINE_REPO}/v${IMAGE_TAG}/supabase/baseline.sql"
    BASELINE="$TRABALHO/baseline.sql"
    log "baixando o schema da versão ${IMAGE_TAG}: $url"
    if ! wget -q -T 60 -O "$BASELINE" "$url" 2>"$TRABALHO/wget.err"; then
      log "NÃO consegui baixar o schema da versão ${IMAGE_TAG} ($(tail -1 "$TRABALHO/wget.err" 2>/dev/null))."
      log "confira se a tag v${IMAGE_TAG} existe em https://github.com/${BASELINE_REPO}/tags e se a VPS alcança raw.githubusercontent.com; depois faça Deploy de novo."
      log "o setup NÃO aplica o schema de outra versão no lugar: app e banco ficariam divergentes."
      exit 1
    fi
    tamanho="$(wc -c < "$BASELINE" | tr -d ' ')"
    if [ "${tamanho:-0}" -lt "${BASELINE_TAMANHO_MINIMO:-1000000}" ] || ! grep -qi 'create table' "$BASELINE"; then
      log "o schema baixado da versão ${IMAGE_TAG} não parece um baseline (${tamanho:-0} bytes, sem 'create table') — recusado."
      exit 1
    fi
    ;;
  *)
    log "BASELINE_FONTE='$BASELINE_FONTE' não existe: use 'versao' (padrão) ou 'clone'"
    exit 1
    ;;
esac

log "aguardando o banco…"
i=0
until pg_isready -d "$DB_URL" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -le 90 ] || { log "banco não respondeu em 3 min"; exit 1; }
  sleep 2
done

log "aguardando o Auth…"
i=0
until wget -q -O /dev/null "${AUTH_URL}/health" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -le 90 ] || { log "Auth não respondeu em 3 min"; exit 1; }
  sleep 2
done

log "extensões (vector, citext, pg_trgm)"
q -c "create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;"

# Mesma régua do kit (hostgator-setup-kit/_common.sh), para o Dokploy tratar a
# reaplicação como o update.sh trata:
#  - BENIGNOS: o que a reaplicação PRODUZ por ser idempotente — igual a
#    BASELINE_ERROS_BENIGNOS;
#  - DISPUTA: banco ocupado ou conexão que caiu — aplicar de novo cura (o
#    arquivo é idempotente). Igual a BASELINE_ERROS_DE_DISPUTA;
#  - o resto é AVISO, como no update.sh ("o app pode ainda funcionar"), com uma
#    exceção abaixo.
BENIGNOS='already exists|multiple primary keys|multiple default values|is already a member|already a partition'
DISPUTA='deadlock detected|could not serialize access|lock timeout|could not obtain lock|terminating connection|server closed the connection|connection to server was lost|SSL connection has been closed unexpectedly|SSL SYSCALL error|remaining connection slots|too many clients|max client(s| connections) reached|the database system is (starting up|shutting down|in recovery mode|not yet accepting connections)|Temporary failure in name resolution|Connection refused|Connection timed out|timeout expired|Network (is )?unreachable'
# A exceção — o que é PRÓPRIO desta instalação e reprova o setup: aqui o
# Supabase sobe junto, e o schema `storage` nasce das migrations do serviço
# storage na partida dele. Se o baseline rodou antes, buckets e policies de
# arquivo não existem e o defeito só aparece quando alguém anexa um arquivo —
# o deploy de novo cura. E o psql que não chegou ao fim do arquivo. Um
# "does not exist" genérico NÃO entra: o kit o tolera numa reaplicação, e
# reprovar por ele travaria o redeploy de quem o kit deixaria atualizar.
FATAIS='relation "storage\.|schema "storage" does not exist|storage\.|o psql saiu com'

tem_schema="$(q -c "select 1 from information_schema.tables where table_schema='public' and table_name='organizations' limit 1")"
if [ "$tem_schema" = "1" ]; then
  log "schema existe — reaplicando o baseline em modo update (erros 'já existe' são esperados)"
  passada=1
  while :; do
    rc=0
    psql "$DB_URL" -q -f "$BASELINE" >"$BASELINE_LOG" 2>&1 || rc=$?
    inesperados="$(grep -iE 'ERROR|FATAL' "$BASELINE_LOG" | grep -viE "$BENIGNOS" || true)"
    # Sem ON_ERROR_STOP o psql sai 0 mesmo com erro de SQL: saída diferente de
    # zero é o psql que NÃO chegou ao fim do arquivo.
    if [ "$rc" -ne 0 ]; then
      inesperados="$(printf '%s\n%s' "$inesperados" "o psql saiu com código $rc: $(tail -1 "$BASELINE_LOG")" | sed '/^$/d')"
    fi
    [ -n "$inesperados" ] || break
    if [ "$passada" -lt 3 ] && printf '%s\n' "$inesperados" | grep -qiE "$DISPUTA"; then
      log "parte do baseline perdeu uma disputa com o sistema no ar — aplicando de novo (passada $((passada + 1)) de 3)"
      sleep $((passada * ${BASELINE_ESPERA_S:-5}))
      passada=$((passada + 1))
      continue
    fi
    break
  done
  if [ -n "$inesperados" ]; then
    if printf '%s\n' "$inesperados" | grep -qiE "$FATAIS"; then
      log "o baseline NÃO se aplicou por inteiro — o schema ficaria incompleto. Erros:"
      printf '%s\n' "$inesperados" | head -20
      log "se algum cita 'storage.', o serviço storage ainda não tinha criado o schema dele: confira os Logs do storage e faça Deploy de novo"
      exit 1
    fi
    log "AVISO: erros fora dos esperados no baseline — o CRM segue, como no update.sh do kit:"
    printf '%s\n' "$inesperados" | head -10
  fi
else
  log "banco novo — aplicando o baseline (qualquer erro interrompe)"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$BASELINE" >"$BASELINE_LOG" 2>&1 \
    || { tail -20 "$BASELINE_LOG"; log "o baseline falhou num banco NOVO; o schema ficaria incompleto"; exit 1; }
fi
log "tabelas em public: $(q -c "select count(*) from information_schema.tables where table_schema='public'")"

log "chave de cifra dos segredos"
q -v chave="$NUVEMSHOP_OAUTH_ENCRYPTION_KEY" <<'SQL'
insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', :'chave')
on conflict (name) do update set value = excluded.value, updated_at = now();
SQL

log "primeiro administrador: ${OWNER_EMAIL}"
# Já existe? Não recria nem troca a senha (a pessoa pode tê-la trocado pela tela).
existe="$(q -v email="$OWNER_EMAIL" <<'SQL'
select 1 from auth.users where lower(email) = lower(:'email') limit 1;
SQL
)"
if [ "$existe" != "1" ]; then
  [ -n "$OWNER_PASSWORD" ] || { log "o administrador ainda não existe e OWNER_PASSWORD está vazia — preencha no Environment e faça Deploy de novo"; exit 1; }
  # O JSON sai do PRÓPRIO Postgres (json_build_object): aspas, barras e acentos
  # na senha ou no e-mail viram JSON válido, sem montar texto à mão.
  corpo="$(q -v email="$OWNER_EMAIL" -v senha="$OWNER_PASSWORD" -v locale="$LOCALE" <<'SQL'
select json_build_object('email', :'email', 'password', :'senha', 'email_confirm', true,
                         'user_metadata', json_build_object('locale', :'locale'));
SQL
)"
  wget -q -O /dev/null \
    --header "apikey: ${SERVICE_ROLE_KEY}" \
    --header "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    --header "Content-Type: application/json" \
    --post-data "$corpo" "${AUTH_URL}/admin/users" \
    || { log "não consegui criar o usuário no Auth (confira SERVICE_ROLE_KEY e JWT_SECRET)"; exit 1; }
fi

q -v email="$OWNER_EMAIL" -v locale="$LOCALE" <<'SQL'
\o /dev/null
select set_config('imob.email', :'email', false), set_config('imob.locale', :'locale', false);
\o
do $$
declare v_org uuid; v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(current_setting('imob.email'));
  if v_uid is null then
    raise exception 'usuário % não encontrado no auth.users', current_setting('imob.email');
  end if;
  select id into v_org from public.organizations where slug = 'minha-empresa';
  if v_org is null then
    insert into public.organizations (slug, display_name, legal_name, locale, created_by)
    values ('minha-empresa', 'Minha Empresa', 'Minha Empresa', current_setting('imob.locale'), v_uid)
    returning id into v_org;
  end if;
  insert into public.user_organizations (user_id, organization_id, role, accepted_at)
  values (v_uid, v_org, 'admin', now())
  on conflict (user_id, organization_id) do update set role = 'admin', revoked_at = null;
  if not exists (select 1 from public.platform_admins where user_id = v_uid and revoked_at is null) then
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
    values (v_uid, v_uid, 'full', false, 'Bootstrap inicial do self-host (Dokploy)');
  end if;
end $$;
SQL

log "pronto"
