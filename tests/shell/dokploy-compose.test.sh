#!/usr/bin/env bash
# Contrato do docker-compose.dokploy.yml (CRM + Supabase numa VPS com Dokploy) e
# do gerador de variáveis. Não sobe contêiner: usa `docker compose config`, que
# resolve o arquivo sem daemon, e confere o que o Traefik do Dokploy vai ler.
#
#   bash tests/shell/dokploy-compose.test.sh
#
# O script `primeira-instalacao.sh` foi provado contra um Postgres real com o
# baseline e um GoTrue dublê (ver o PR que o introduziu); aqui fica o contrato
# estático dele, que roda em qualquer máquina.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE="$ROOT/docker-compose.dokploy.yml"
GERAR="$ROOT/infra/dokploy/gerar-env.sh"
SETUP="$ROOT/infra/dokploy/primeira-instalacao.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }

echo "gerador de variáveis:"
check "gerar-env.sh: sintaxe" bash -n "$GERAR"
check "primeira-instalacao.sh: sintaxe POSIX" sh -n "$SETUP"
bash "$GERAR" --dominio CRMIMOB.Exemplo.com.br --email dono@exemplo.com.br --versao 1.57.0 > "$WORK/.env"; rc=$?
check "gera sem erro" test "$rc" -eq 0
check "domínio normalizado para minúsculas" grep -qx 'DOMAIN=crmimob.exemplo.com.br' "$WORK/.env"
check "versão fixa, não tag móvel" grep -qx 'IMAGE_TAG=1.57.0' "$WORK/.env"
check "cadastro só por convite (CRM e Auth fecham juntos)" \
  bash -c 'grep -qx "SIGNUP_MODE=so_convite" "$1" && grep -qx "DISABLE_SIGNUP=true" "$1"' _ "$WORK/.env"
vazios="$(grep -E '^[A-Z_0-9]+=$' "$WORK/.env" | grep -vE '^SMTP_(HOST|USERNAME|PASSWORD|FROM_EMAIL)=$' || true)"
check "nenhum segredo sai vazio (só o SMTP opcional)" igual "$vazios" ''
check "domínio inválido é recusado" bash -c '! bash "$1" --dominio "https://x" --email a@b.co >/dev/null 2>&1' _ "$GERAR"
bash "$GERAR" --dominio a.exemplo.com --email a@exemplo.com > "$WORK/.env2"
check "duas rodadas geram segredos diferentes" \
  bash -c '[ "$(grep ^JWT_SECRET= "$1")" != "$(grep ^JWT_SECRET= "$2")" ]' _ "$WORK/.env" "$WORK/.env2"

jwt="$(python3 - "$WORK/.env" <<'PY'
import base64, hashlib, hmac, json, sys
env = dict(l.split("=", 1) for l in open(sys.argv[1]).read().splitlines() if "=" in l and not l.startswith("#"))
def dec(s): return json.loads(base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)))
out = []
for chave, papel in (("ANON_KEY", "anon"), ("SERVICE_ROLE_KEY", "service_role")):
    h, p, s = env[chave].split(".")
    esperado = base64.urlsafe_b64encode(hmac.new(env["JWT_SECRET"].encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    corpo = dec(p)
    out.append("ok" if s == esperado and dec(h)["alg"] == "HS256" and corpo["role"] == papel and corpo["iss"] == "supabase" and corpo["exp"] > corpo["iat"] else f"ERRO-{chave}")
print(" ".join(out))
PY
)"
check "ANON_KEY e SERVICE_ROLE_KEY são JWTs assinados com o JWT_SECRET, com o papel certo" igual "$jwt" 'ok ok'
sha="$(python3 -c '
import hashlib, sys
env = dict(l.split("=", 1) for l in open(sys.argv[1]).read().splitlines() if "=" in l and not l.startswith("#"))
print("ok" if hashlib.sha512(env["WAHA_API_KEY"].encode()).hexdigest() == env["WAHA_API_KEY_SHA512"] else "ERRO")' "$WORK/.env")"
check "WAHA recebe o SHA512 da chave que o CRM envia" igual "$sha" 'ok'

echo "compose (docker compose config):"
if ! docker compose version >/dev/null 2>&1; then
  echo "  - pulado: docker compose ausente"
else
  cfg="$(cd "$ROOT" && env -i PATH="$PATH" HOME="$HOME" docker compose -f "$COMPOSE" --env-file "$WORK/.env" config --format json 2>"$WORK/err")"; rc=$?
  check "o compose resolve com o .env gerado" test "$rc" -eq 0
  [ "$rc" -eq 0 ] || cat "$WORK/err"
  printf '%s' "$cfg" > "$WORK/cfg.json"
  sonda="$(python3 - "$ROOT" "$WORK/cfg.json" <<'PY'
import json, os, sys
raiz = sys.argv[1]
c = json.load(open(sys.argv[2])); s = c["services"]
r = []
r.append("sem-porta" if not any(v.get("ports") for v in s.values()) else "PORTA-NO-HOST")
publicados = sorted(n for n, v in s.items() if (v.get("labels") or {}).get("traefik.enable") == "true")
r.append("publicados=" + ",".join(publicados))
na_rede = sorted(n for n, v in s.items() if "dokploy" in (v.get("networks") or {}))
r.append("rede=" + ",".join(na_rede))
r.append("rede-dokploy" if c["networks"]["dokploy"].get("name") == "dokploy-network" and c["networks"]["dokploy"].get("external") else "REDE-ERRADA")
gw = s["api-gw"]["labels"]["traefik.http.routers.imob-supabase.rule"]
r.append("rotas-supabase" if all(f"PathPrefix(`/{p}`)" in gw for p in ("auth/v1", "rest/v1", "realtime/v1", "storage/v1")) and "Host(`crmimob.exemplo.com.br`)" in gw else "ROTAS-ERRADAS")
r.append("versao-fixa" if all(s[n]["image"].endswith(":1.57.0") for n in ("app", "worker", "scheduler")) else "VERSAO-ERRADA")
r.append("setup-antes" if s["app"]["depends_on"]["setup"]["condition"] == "service_completed_successfully" and s["worker"]["depends_on"]["setup"]["condition"] == "service_completed_successfully" else "SETUP-FORA-DE-ORDEM")
faltando = []
for n, v in s.items():
    for vol in v.get("volumes") or []:
        if vol.get("type") == "bind" and not os.path.exists(vol["source"]):
            faltando.append(vol["source"].replace(raiz + "/", ""))
r.append("arquivos-ok" if not faltando else "FALTA:" + ",".join(faltando))
persistentes = {vol.get("source") for n in ("db", "storage", "waha") for vol in s[n].get("volumes") or [] if vol.get("type") == "volume"}
r.append("dados-em-volume" if {"db-data", "storage-data", "waha-data"} <= persistentes else "DADO-EM-PASTA")
r.append("alias-realtime" if "realtime-dev.supabase-realtime" in (s["realtime"]["networks"]["default"] or {}).get("aliases", []) else "SEM-ALIAS")
r.append("db-url-privada" if s["app"]["environment"]["SUPABASE_DB_URL"].endswith("@db:5432/postgres") else "DB-URL-ERRADA")
print(" ".join(r))
PY
)"
  check "só app e api-gw no Traefik, sem porta no host, dados em volume, setup antes do app" igual "$sonda" \
    'sem-porta publicados=api-gw,app rede=api-gw,app rede-dokploy rotas-supabase versao-fixa setup-antes arquivos-ok dados-em-volume alias-realtime db-url-privada'
  env -i PATH="$PATH" HOME="$HOME" docker compose -f "$COMPOSE" --env-file /dev/null config >/dev/null 2>"$WORK/err2"; rc=$?
  check "sem as variáveis, o compose recusa e diz qual falta" \
    bash -c '[ "$1" -ne 0 ] && grep -q "defina" "$2"' _ "$rc" "$WORK/err2"
fi

echo "arquivos do Supabase (cópia fixa):"
for f in api/envoy/envoy.yaml api/envoy/cds.yaml api/envoy/lds.template.yaml api/envoy/docker-entrypoint.sh \
         db/realtime.sql db/webhooks.sql db/roles.sql db/jwt.sql db/_supabase.sql db/logs.sql db/pooler.sql LICENSE; do
  check "presente: $f" test -s "$ROOT/infra/dokploy/supabase/$f"
done
check "as imagens do Supabase são as da versão pinada no kit (self-hosted/v0.8.1)" \
  grep -qx 'SUPABASE_REF="self-hosted/v0.8.1"' "$ROOT/hostgator-setup-kit/_common.sh"
check "setup: banco novo aplica o baseline com ON_ERROR_STOP" grep -q 'ON_ERROR_STOP=1 -q -f "$BASELINE"' "$SETUP"
check "setup: dono nasce com mfa_required=false explícito (como o install.sh)" grep -q "'full', false," "$SETUP"
check "setup: não recria o dono que já existe" grep -q 'if \[ "$existe" != "1" \]' "$SETUP"

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo 'ok: o compose do Dokploy resolve, publica só o necessário e o gerador produz chaves válidas'
