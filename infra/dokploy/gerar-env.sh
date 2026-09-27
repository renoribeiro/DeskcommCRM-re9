#!/usr/bin/env bash
# Gera as variáveis de ambiente do `docker-compose.dokploy.yml` (ImobCRM/DeskcommCRM
# com o Supabase na mesma VPS, publicado pelo Traefik do Dokploy).
#
#   bash infra/dokploy/gerar-env.sh --dominio crm.suaempresa.com.br --email voce@suaempresa.com.br --versao 1.57.0
#
# A saída é o bloco para colar em Dokploy › (seu Compose) › Environment. Tudo é
# gerado AQUI, localmente, com openssl: nenhum segredo sai desta máquina.
#
# ⚠️ Rode UMA vez por instalação. Trocar POSTGRES_PASSWORD ou JWT_SECRET depois
# que o banco nasceu não troca a senha dentro do banco — o CRM perde o acesso.
# Guarde a saída num gerenciador de senhas.
#
# Precisa de: bash, openssl, date. Funciona em Linux e macOS.

set -euo pipefail

dominio=""
email=""
versao=""
nome="ImobCRM"

uso() {
  cat <<'EOF'
Uso: bash infra/dokploy/gerar-env.sh --dominio DOMINIO --email EMAIL --versao X.Y.Z [--nome NOME]

  --dominio   domínio do CRM, sem https:// (ex.: crm.suaempresa.com.br)
  --email     e-mail do primeiro administrador
  --versao    OBRIGATÓRIA: número de uma versão PUBLICADA das imagens (ex.: 1.57.0)
  --nome      nome da marca semeado na instalação (padrão: ImobCRM)
EOF
}

# Onde ver as versões publicadas. `stable`/`latest` não servem: são tags que
# MOVEM (e `stable` pode nem existir no registro do fork — o primeiro deploy
# falharia no download da imagem).
como_ver_versoes() {
  cat <<'EOF'
Para ver as versões publicadas:
  git ls-remote --tags https://github.com/renoribeiro/DeskcommCRM-re9 'v*'
    (a tag v1.57.0 vira a imagem 1.57.0 — use o número sem o "v")
  ou a página do pacote no GitHub:
    https://github.com/renoribeiro/DeskcommCRM-re9/pkgs/container/deskcommcrm
Confira que a versão aparece lá antes do Deploy: tag sem imagem publicada
falha no download.
EOF
}

while (($#)); do
  case "$1" in
    --dominio) dominio="${2:-}"; shift ;;
    --email) email="${2:-}"; shift ;;
    --versao) versao="${2:-}"; shift ;;
    --nome) nome="${2:-}"; shift ;;
    -h|--help) uso; exit 0 ;;
    *) uso >&2; exit 2 ;;
  esac
  shift
done

dominio="$(printf '%s' "$dominio" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
dominio="${dominio#https://}"; dominio="${dominio#http://}"; dominio="${dominio%%/*}"
[[ "$dominio" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || { echo "Domínio inválido: '$dominio'. Informe só o host (ex.: crm.suaempresa.com.br)." >&2; exit 2; }
# Sem aspas, barra invertida, crase, cifrão, `<`, `>`, `;` nem `=`: o e-mail vai
# para o Environment do Dokploy e para o JSON do primeiro administrador.
re_email='^[^]@[:space:]"'"'"'\\`$<>;=[]+@[^]@[:space:]"'"'"'\\`$<>;=[]+\.[^]@[:space:]"'"'"'\\`$<>;=[]+$'
[[ "$email" =~ $re_email ]] \
  || { echo "E-mail inválido: '$email'." >&2; exit 2; }
if [ -z "$versao" ]; then
  { echo "Falta --versao: a instalação aponta para um NÚMERO de versão publicado, nunca para stable/latest."; como_ver_versoes; } >&2
  exit 2
fi
versao="${versao#v}"
[[ "$versao" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] \
  || { { echo "Versão inválida: '$versao'. Use o número de uma versão publicada (ex.: 1.57.0), nunca uma tag que move (stable, latest, main)."; como_ver_versoes; } >&2; exit 2; }
[[ "$nome" =~ ^[^\"\$\`\\]+$ ]] || { echo "Nome inválido: '$nome'." >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "openssl não encontrado." >&2; exit 1; }

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 32 | tr -d '\n'; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# JWT HS256 assinado com o JWT_SECRET — o mesmo formato que o utils/generate-keys.sh
# oficial do Supabase produz (role, iss, iat, exp).
jwt() {  # jwt <role> <segredo>
  local agora exp cabecalho corpo assinatura
  agora="$(date +%s)"
  exp=$((agora + 10 * 365 * 24 * 3600))
  cabecalho="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
  corpo="$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$1" "$agora" "$exp" | b64url)"
  assinatura="$(printf '%s' "${cabecalho}.${corpo}" | openssl dgst -sha256 -hmac "$2" -binary | b64url)"
  printf '%s.%s.%s' "$cabecalho" "$corpo" "$assinatura"
}

jwt_secret="$(hex 32)"
waha_api_key="$(hex 32)"
waha_sha512="$(printf '%s' "$waha_api_key" | openssl dgst -sha512 -hex | awk '{print $NF}')"

cat <<EOF
# ── ${nome} no Dokploy — gerado em $(date -u +%Y-%m-%dT%H:%M:%SZ) ──
# Guarde este bloco num gerenciador de senhas. NÃO gere de novo depois de instalar.

# Domínio e primeiro administrador
DOMAIN=${dominio}
OWNER_EMAIL=${email}
OWNER_PASSWORD=$(hex 12)
APP_NAME=${nome}
APP_LOCALE=pt-BR

# Cadastro: só por convite. É uma instalação de UMA empresa — ninguém de fora
# deve conseguir criar conta sozinho (o CRM e o Auth fecham juntos).
SIGNUP_MODE=so_convite
DISABLE_SIGNUP=true

# Versão das imagens: número fixo, sempre. Para atualizar, troque aqui e faça Deploy.
IMAGE_TAG=${versao}

# Traefik do Dokploy (os nomes padrão do Dokploy)
TRAEFIK_NETWORK=dokploy-network
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_ENTRYPOINT_HTTP=web
TRAEFIK_CERTRESOLVER=letsencrypt

# Supabase (banco, login e arquivos)
POSTGRES_PASSWORD=$(hex 24)
JWT_SECRET=${jwt_secret}
ANON_KEY=$(jwt anon "$jwt_secret")
SERVICE_ROLE_KEY=$(jwt service_role "$jwt_secret")
SECRET_KEY_BASE=$(hex 32)
# Chave com que o Realtime cifra a senha do banco que ele guarda (16 caracteres).
REALTIME_DB_ENC_KEY=$(hex 8)
DASHBOARD_USERNAME=supabase
DASHBOARD_PASSWORD=$(hex 16)

# Segredos do CRM
INTERNAL_SECRET=$(hex 32)
INTERNAL_CRON_SECRET=$(hex 32)
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=$(hex 32)
CPF_ENCRYPTION_KEY=$(b64)
AI_CRED_AES_KEY=$(b64)
WAHA_BYO_ENCRYPTION_KEY=$(b64)
IMPERSONATE_COOKIE_SECRET=$(hex 32)
LGPD_SIGNING_KEY=$(hex 32)
WAHA_API_KEY=${waha_api_key}
WAHA_API_KEY_SHA512=${waha_sha512}
WAHA_HMAC_SECRET=$(hex 32)
SRH_TOKEN=$(hex 32)

# E-mail (opcional agora; sem ele, "esqueci a senha" não envia e-mail)
SMTP_HOST=
SMTP_PORT=587
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=
SMTP_FROM_NAME=${nome}
EOF
