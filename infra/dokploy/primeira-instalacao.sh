#!/bin/sh
# Serviço `setup` do docker-compose.dokploy.yml. Roda a cada deploy, ANTES do
# app, dentro de um contêiner postgres:17-alpine (psql + wget do busybox).
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
: "${OWNER_PASSWORD:?OWNER_PASSWORD ausente}"
: "${NUVEMSHOP_OAUTH_ENCRYPTION_KEY:?NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente}"
BASELINE="${BASELINE:-/baseline.sql}"
LOCALE="${APP_LOCALE:-pt-BR}"
# Avisos de "já existe" viram ruído no log do Dokploy; erro de verdade continua aparecendo.
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

log() { printf '[setup] %s\n' "$*"; }
q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -tAq "$@"; }

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

tem_schema="$(q -c "select 1 from information_schema.tables where table_schema='public' and table_name='organizations' limit 1")"
if [ "$tem_schema" = "1" ]; then
  log "schema existe — reaplicando o baseline em modo update (erros 'já existe' são esperados)"
  psql "$DB_URL" -q -f "$BASELINE" >/tmp/baseline.log 2>&1 || true
  inesperados="$(grep -E 'ERROR' /tmp/baseline.log | grep -viE 'already exists|multiple primary keys|duplicate' | head -5 || true)"
  [ -z "$inesperados" ] || { log "erros não esperados no baseline (o CRM segue):"; printf '%s\n' "$inesperados"; }
else
  log "banco novo — aplicando o baseline (qualquer erro interrompe)"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$BASELINE" >/tmp/baseline.log 2>&1 \
    || { tail -20 /tmp/baseline.log; log "o baseline falhou num banco NOVO; o schema ficaria incompleto"; exit 1; }
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
  corpo="$(printf '{"email":"%s","password":"%s","email_confirm":true,"user_metadata":{"locale":"%s"}}' \
    "$OWNER_EMAIL" "$OWNER_PASSWORD" "$LOCALE")"
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
