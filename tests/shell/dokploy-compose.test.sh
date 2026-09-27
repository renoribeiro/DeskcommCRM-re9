#!/usr/bin/env bash
# Contrato do docker-compose.dokploy.yml (CRM + Supabase numa VPS com Dokploy) e
# do gerador de variáveis. Não sobe contêiner: usa `docker compose config`, que
# resolve o arquivo sem daemon, e confere o que o Traefik do Dokploy vai ler.
#
#   bash tests/shell/dokploy-compose.test.sh
#
# O script `primeira-instalacao.sh` foi provado contra um Postgres real com o
# baseline e um GoTrue dublê (ver o PR que o introduziu e o da auditoria de
# segurança, doc 04); aqui fica o contrato estático dele, que roda em qualquer
# máquina. A reescrita do cds.yaml do gateway roda DE VERDADE (sed + YAML).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE="$ROOT/docker-compose.dokploy.yml"
GERAR="$ROOT/infra/dokploy/gerar-env.sh"
SETUP="$ROOT/infra/dokploy/primeira-instalacao.sh"
GW="$ROOT/infra/dokploy/gateway-entrypoint.sh"
CDS="$ROOT/infra/dokploy/supabase/api/envoy/cds.yaml"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }

echo "gerador de variáveis:"
check "gerar-env.sh: sintaxe" bash -n "$GERAR"
check "primeira-instalacao.sh: sintaxe POSIX" sh -n "$SETUP"
check "gateway-entrypoint.sh: sintaxe POSIX" sh -n "$GW"
bash "$GERAR" --dominio CRMIMOB.Exemplo.com.br --email dono@exemplo.com.br --versao 1.57.0 > "$WORK/.env"; rc=$?
check "gera sem erro" test "$rc" -eq 0
check "domínio normalizado para minúsculas" grep -qx 'DOMAIN=crmimob.exemplo.com.br' "$WORK/.env"
check "versão fixa, não tag móvel" grep -qx 'IMAGE_TAG=1.57.0' "$WORK/.env"
check "cadastro só por convite (CRM e Auth fecham juntos)" \
  bash -c 'grep -qx "SIGNUP_MODE=so_convite" "$1" && grep -qx "DISABLE_SIGNUP=true" "$1"' _ "$WORK/.env"
vazios="$(grep -E '^[A-Z_0-9]+=$' "$WORK/.env" | grep -vE '^SMTP_(HOST|USERNAME|PASSWORD|FROM_EMAIL)=$' || true)"
check "nenhum segredo sai vazio (só o SMTP opcional)" igual "$vazios" ''
check "domínio inválido é recusado" bash -c '! bash "$1" --dominio "https://x" --email a@b.co --versao 1.57.0 >/dev/null 2>&1' _ "$GERAR"
bash "$GERAR" --dominio a.exemplo.com --email a@exemplo.com --versao 1.57.0 > "$WORK/.env2"
check "duas rodadas geram segredos diferentes" \
  bash -c '[ "$(grep ^JWT_SECRET= "$1")" != "$(grep ^JWT_SECRET= "$2")" ] && [ "$(grep ^REALTIME_DB_ENC_KEY= "$1")" != "$(grep ^REALTIME_DB_ENC_KEY= "$2")" ]' _ "$WORK/.env" "$WORK/.env2"
check "REALTIME_DB_ENC_KEY: 16 caracteres hex, nunca o fixo 'supabaserealtime'" \
  grep -qxE 'REALTIME_DB_ENC_KEY=[0-9a-f]{16}' "$WORK/.env"
# --versao é OBRIGATÓRIA (D1): sem ela o primeiro deploy puxaria `stable`, que o
# registro do fork pode nem ter.
bash "$GERAR" --dominio a.exemplo.com --email a@exemplo.com > /dev/null 2> "$WORK/sem-versao"; rc=$?
check "sem --versao: recusa e ensina a listar as versões publicadas" \
  bash -c '[ "$1" -ne 0 ] && grep -q "git ls-remote --tags https://github.com/renoribeiro/DeskcommCRM-re9" "$2" && grep -q "pkgs/container/deskcommcrm" "$2"' _ "$rc" "$WORK/sem-versao"
for movel in stable latest main 1.57 '1.57.0;x'; do
  check "--versao '$movel' é recusada (tag que move ou formato inválido)" \
    bash -c '! bash "$1" --dominio a.exemplo.com --email a@exemplo.com --versao "$2" >/dev/null 2>&1' _ "$GERAR" "$movel"
done
check "--versao v1.57.0 vira IMAGE_TAG=1.57.0 (a tag git tem 'v', a imagem não)" \
  bash -c 'bash "$1" --dominio a.exemplo.com --email a@exemplo.com --versao v1.57.0 | grep -qx IMAGE_TAG=1.57.0' _ "$GERAR"
for ruim in 'a"b@exemplo.com' 'a\b@exemplo.com' "a'b@exemplo.com" 'a`b@exemplo.com' 'a$b@exemplo.com'; do
  check "e-mail com [${ruim:1:1}] é recusado (vai para o Environment e para o JSON do dono)" \
    bash -c '! bash "$1" --dominio a.exemplo.com --email "$2" --versao 1.57.0 >/dev/null 2>&1' _ "$GERAR" "$ruim"
done
check "e-mail comum com + e subdomínio passa" \
  bash -c 'bash "$1" --dominio a.exemplo.com --email "nome.sobre+crm@mail.exemplo.com.br" --versao 1.57.0 >/dev/null 2>&1' _ "$GERAR"

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

echo "variáveis do CRM (x-crm-env contra lib/env.ts):"
# D4: a lista do compose era fechada, e VAPID, Resend, Google, SUPPORT_EMAIL,
# LGPD_DPO_EMAIL… nunca chegavam ao app. Toda chave do schema de lib/env.ts tem
# de estar no x-crm-env; e toda chave que NÃO está em FIXAS tem de ler a
# variável de mesmo nome do Environment (dá para ligar sem editar o compose).
cobertura="$(python3 - "$ROOT/lib/env.ts" "$COMPOSE" <<'PY'
import re, sys
env_ts = open(sys.argv[1]).read()
corpo = env_ts[env_ts.index("const schema = z.object({"):]
corpo = corpo[:corpo.index("\n});")]
chaves = re.findall(r"^  ([A-Z][A-Z0-9_]+):", corpo, re.M)
comp = open(sys.argv[2]).read()
bloco = comp[comp.index("x-crm-env: &crm-env\n"):comp.index("\nservices:\n")]
x = dict(re.findall(r"^  ([A-Z][A-Z0-9_]+): (.*)$", bloco, re.M))
# Chaves que ficam FORA do x-crm-env — hoje nenhuma. Quem entrar aqui entra com
# o motivo escrito ao lado.
EXCLUIDAS = {}
# Chaves presentes com valor que NÃO vem da variável de mesmo nome, e por quê.
FIXAS = {
    "NODE_ENV": "é produção, sempre",
    "SUPABASE_DB_ADMIN_URL": "forçada vazia: a URL de admin é do kit com Supabase de fora",
    "INTERNAL_AGENT_RUN_STUB": "o trace falso do :test nunca vai para produção",
    "DEPLOY_MODE": "é 'dokploy' por definição: este arquivo É a instalação pelo Dokploy, e as telas de /admin leem isso",
    "NEXT_PUBLIC_APP_URL": "deriva de DOMAIN", "NEXT_PUBLIC_ADMIN_URL": "deriva de DOMAIN",
    "NEXT_PUBLIC_SUPABASE_URL": "deriva de DOMAIN",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "vem de ANON_KEY (o nome do gerar-env)",
    "SUPABASE_SERVICE_ROLE_KEY": "vem de SERVICE_ROLE_KEY",
    "SUPABASE_DB_URL": "apelido único + POSTGRES_PASSWORD",
    "WAHA_API_BASE_URL": "apelido único", "WAHA_WEBHOOK_BASE_URL": "apelido único",
    "UPSTASH_REDIS_REST_URL": "apelido único", "UPSTASH_REDIS_REST_TOKEN": "vem de SRH_TOKEN",
}
faltam = [k for k in chaves if k not in x and k not in EXCLUIDAS]
nao_liga = [k for k in chaves if k in x and k not in FIXAS and not x[k].startswith("${" + k + ":")]
print(f"{len(chaves)} chaves;" + (" faltam=" + ",".join(faltam) if faltam else "") + (" sem-${VAR}=" + ",".join(nao_liga) if nao_liga else ""))
PY
)"
n_chaves="$(grep -oE '^[0-9]+' <<<"$cobertura")"
check "lib/env.ts tem chaves que o teste achou (a sonda não está cega)" test "${n_chaves:-0}" -gt 50
check "toda chave de lib/env.ts está no x-crm-env e pode ser ligada pelo Environment" \
  igual "$cobertura" "${n_chaves} chaves;"

echo "gateway (reescrita do cds.yaml para os apelidos únicos):"
cp "$CDS" "$WORK/cds.orig"
printf '#!/bin/sh\necho "entrada oficial chamada: $*"\n' > "$WORK/oficial.sh"
CDS_ORIGEM="$CDS" CDS_DESTINO="$WORK/cds.yaml" ENTRADA_OFICIAL="$WORK/oficial.sh" \
  sh "$GW" --arg > "$WORK/gw.out" 2>&1; rc=$?
check "a entrada do gateway reescreve e segue para a entrada oficial" \
  bash -c '[ "$1" -eq 0 ] && grep -q "entrada oficial chamada: --arg" "$2"' _ "$rc" "$WORK/gw.out"
enderecos="$(python3 - "$WORK/cds.yaml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
par = []
for c in d["resources"]:
    for e in c["load_assignment"]["endpoints"]:
        for lb in e["lb_endpoints"]:
            par.append(f'{c["name"]}={lb["endpoint"]["address"]["socket_address"]["address"]}')
print(" ".join(sorted(par)))
PY
)"
check "o cds.yaml reescrito é YAML válido e cada cluster aponta para o apelido único" igual "$enderecos" \
  'auth=imobcrm-auth functions=imobcrm-functions meta=imobcrm-meta realtime=imobcrm-realtime rest=imobcrm-rest storage=imobcrm-storage studio=imobcrm-studio'
check "o arquivo vendorizado ficou intacto" cmp -s "$CDS" "$WORK/cds.orig"
check "fora os endereços, o arquivo reescrito é idêntico ao oficial" \
  bash -c 'diff <(grep -v "address: " "$1") <(grep -v "address: " "$2") >/dev/null' _ "$CDS" "$WORK/cds.yaml"
sed 's/address: storage$/address: kong/' "$CDS" > "$WORK/cds.estranho"
CDS_ORIGEM="$WORK/cds.estranho" CDS_DESTINO="$WORK/cds2.yaml" ENTRADA_OFICIAL="$WORK/oficial.sh" \
  sh "$GW" > "$WORK/gw2.out" 2>&1; rc=$?
check "endereço que ele não conhece: recusa subir (falha fechada), sem chamar o Envoy" \
  bash -c '[ "$1" -ne 0 ] && grep -q "address: kong" "$2" && ! grep -q "entrada oficial" "$2"' _ "$rc" "$WORK/gw2.out"

echo "compose (docker compose config):"
if ! docker compose version >/dev/null 2>&1; then
  echo "  - pulado: docker compose ausente"
else
  config() { (cd "$ROOT" && env -i PATH="$PATH" HOME="$HOME" docker compose -f "$COMPOSE" --env-file "$1" config --format json); }
  cfg="$(config "$WORK/.env" 2>"$WORK/err")"; rc=$?
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
r.append("versao-fixa" if all(s[n]["image"].endswith(":1.57.0") and s[n].get("pull_policy") == "missing" for n in ("app", "worker", "scheduler")) else "VERSAO-ERRADA")
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
r.append("db-url-privada" if s["app"]["environment"]["SUPABASE_DB_URL"].endswith("@imobcrm-db:5432/postgres") else "DB-URL-ERRADA")
print(" ".join(r))
PY
)"
  check "só app e api-gw no Traefik, sem porta no host, dados em volume, setup antes do app" igual "$sonda" \
    'sem-porta publicados=api-gw,app rede=api-gw,app rede-dokploy rotas-supabase versao-fixa setup-antes arquivos-ok dados-em-volume alias-realtime db-url-privada'

  # D3: nomes únicos. Cada serviço de longa vida tem o SEU apelido imobcrm-*, e
  # nenhum endereço interno usa o nome cru do serviço (na dokploy-network ele
  # pode ser o contêiner de outro sistema).
  apelidos="$(python3 - "$WORK/cfg.json" <<'PY'
import json, re, sys
s = json.load(open(sys.argv[1]))["services"]
ESPERADO = {"db": "imobcrm-db", "auth": "imobcrm-auth", "rest": "imobcrm-rest", "realtime": "imobcrm-realtime",
            "storage": "imobcrm-storage", "imgproxy": "imobcrm-imgproxy", "api-gw": "imobcrm-gw",
            "app": "imobcrm-app", "worker": "imobcrm-worker", "scheduler": "imobcrm-scheduler",
            "waha": "imobcrm-waha", "redis": "imobcrm-redis", "srh": "imobcrm-srh"}
r = []
for n, v in sorted(s.items()):
    if n == "setup":
        continue
    al = ((v.get("networks") or {}).get("default") or {}).get("aliases") or []
    if ESPERADO.get(n) not in al:
        r.append(f"SEM-APELIDO:{n}")
todos = [a for v in s.values() for a in (((v.get("networks") or {}).get("default") or {}).get("aliases") or []) if a.startswith("imobcrm-")]
if len(todos) != len(set(todos)):
    r.append("APELIDO-REPETIDO")
# Endereço interno com o NOME CRU de um serviço: host de URL (//x: ou @x:),
# ou uma variável *_HOST que é só o nome (DB_HOST: db). `APP_NAME: realtime`
# não é endereço.
nomes = "|".join(map(re.escape, list(s) + ["kong", "envoy", "meta", "studio", "functions", "supabase-db"]))
cru_url = re.compile(rf"(?:@|//)(?:{nomes})(?::|/|$)")
cru_host = re.compile(rf"^(?:{nomes})$")
for n, v in sorted(s.items()):
    for k, val in (v.get("environment") or {}).items():
        if isinstance(val, str) and (cru_url.search(val) or (k.endswith("_HOST") and cru_host.search(val))):
            r.append(f"CRU:{n}.{k}={val.split('@')[-1]}")
    hc = " ".join((v.get("healthcheck") or {}).get("test") or [])
    if re.search(rf"//(?:{nomes}):", hc):
        r.append(f"CRU:{n}.healthcheck")
print(" ".join(r) or "ok")
PY
)"
  check "todo serviço interno tem apelido único imobcrm-* e nenhum endereço usa o nome cru" igual "$apelidos" ok
  check "DEPLOY_MODE=dokploy chega a app e worker (as telas de /admin ensinam o Environment)" \
    igual "$(python3 -c 'import json,sys; s=json.load(open(sys.argv[1]))["services"]; print(s["app"]["environment"].get("DEPLOY_MODE"), s["worker"]["environment"].get("DEPLOY_MODE"))' "$WORK/cfg.json")" 'dokploy dokploy'
  check "o scheduler chama o app pelo apelido único" \
    igual "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["services"]["scheduler"]["environment"].get("SCHEDULER_APP_ORIGIN"))' "$WORK/cfg.json")" 'http://imobcrm-app:3000'
  gwcfg="$(python3 - "$WORK/cfg.json" <<'PY'
import json, sys
g = json.load(open(sys.argv[1]))["services"]["api-gw"]
vols = {v["target"]: v["source"].rsplit("/", 1)[-1] for v in g.get("volumes") or []}
ok = (g.get("entrypoint") == ["/bin/sh", "/gateway-entrypoint.sh"]
      and vols.get("/etc/envoy/cds.src.yaml") == "cds.yaml"
      and vols.get("/gateway-entrypoint.sh") == "gateway-entrypoint.sh"
      and "/etc/envoy/cds.yaml" not in vols
      and vols.get("/docker-entrypoint.sh") == "docker-entrypoint.sh")
print("ok" if ok else f"ERRADO {g.get('entrypoint')} {vols}")
PY
)"
  check "o gateway monta o cds oficial como cds.src.yaml e entra pela reescrita" igual "$gwcfg" ok

  # D6: teto de memória em TODO serviço, com os valores do plano.
  memoria="$(python3 - "$WORK/cfg.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))["services"]
M = 1024 * 1024
ESPERADO = {"db": 1536, "realtime": 512, "storage": 384, "imgproxy": 512, "auth": 256, "rest": 256, "api-gw": 256,
            "redis": 192, "srh": 128, "scheduler": 128, "setup": 256, "app": 768, "worker": 512, "waha": 1280}
r = []
for n, v in sorted(s.items()):
    lim = v.get("mem_limit")
    if lim is None:
        r.append(f"SEM-LIMITE:{n}")
    elif n in ESPERADO and int(lim) != ESPERADO[n] * M:
        r.append(f"{n}={int(lim) // M}m")
fora_do_plano = sorted(set(s) - set(ESPERADO))
if fora_do_plano:
    r.append("SERVICO-NOVO-SEM-PLANO:" + ",".join(fora_do_plano))
no_ar = sum(int(v["mem_limit"]) for n, v in s.items() if n != "setup" and v.get("mem_limit"))
r.append(f"soma-no-ar={no_ar // M}m")
print(" ".join(r))
PY
)"
  check "todo serviço tem mem_limit, com os valores do plano (soma dos que ficam no ar cabe em 8 GB)" \
    igual "$memoria" 'soma-no-ar=6720m'
  ajustes="$(python3 - "$WORK/cfg.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))["services"]
r = []
cmd = s["db"]["command"]
r.append("pg-ok" if "shared_buffers=512MB" in cmd and "effective_cache_size=2GB" in cmd else "PG-SEM-AJUSTE")
rc = s["redis"]["command"]
r.append("redis-ok" if rc[rc.index("--maxmemory") + 1] == "128mb" and rc[rc.index("--maxmemory-policy") + 1] == "allkeys-lru" else "REDIS-SEM-TETO")
e = s["imgproxy"]["environment"]
r.append("imgproxy-ok" if e.get("IMGPROXY_WORKERS") == "2" and e.get("IMGPROXY_CONCURRENCY") == "2" else "IMGPROXY-SEM-TETO")
r.append("rest-" + s["rest"]["environment"]["PGRST_DB_SCHEMAS"])
print(" ".join(r))
PY
)"
  check "Postgres com shared_buffers/effective_cache_size, Redis com teto, imgproxy com 2 workers, REST sem storage" \
    igual "$ajustes" 'pg-ok redis-ok imgproxy-ok rest-public,graphql_public'

  # D2 + D11: o setup espera o storage e a REST SAUDÁVEIS, e a imagem é fixa.
  setup="$(python3 - "$WORK/cfg.json" <<'PY'
import json, re, sys
st = json.load(open(sys.argv[1]))["services"]["setup"]
d = st["depends_on"]
r = [f"{k}={d[k]['condition']}" for k in ("db", "auth", "rest", "storage") if k in d]
# Versão do Postgres E do Alpine: `17.6-alpine` sozinha é republicada a cada Alpine novo.
r.append("imagem-fixa" if re.fullmatch(r"postgres:\d+\.\d+-alpine\d+\.\d+", st["image"]) else "IMAGEM-MOVEL:" + st["image"])
e = st["environment"]
r.append("baseline-da-versao" if e.get("IMAGE_TAG") == "1.57.0" and e.get("BASELINE_FONTE") == "versao" else f"BASELINE-FONTE:{e.get('IMAGE_TAG')}/{e.get('BASELINE_FONTE')}")
print(" ".join(r))
PY
)"
  check "setup depende de db, auth, rest e storage saudáveis; imagem fixa; baseline da versão IMAGE_TAG" igual "$setup" \
    'db=service_healthy auth=service_healthy rest=service_healthy storage=service_healthy imagem-fixa baseline-da-versao'
  # Dependência upstream com tag fixa (packaging.md): `redis:7-alpine` flutua no major.
  redis_img="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["services"]["redis"]["image"])' "$WORK/cfg.json")"
  check "redis com versão completa (major.minor.patch-alpineX.Y), não tag que flutua" \
    grep -qxE 'redis:[0-9]+\.[0-9]+\.[0-9]+-alpine[0-9]+\.[0-9]+' <<<"$redis_img"

  realtime_key="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["services"]["realtime"]["environment"]["DB_ENC_KEY"])' "$WORK/cfg.json")"
  check "o Realtime usa a chave gerada (D9), não a fixa" igual "$realtime_key" "$(sed -n 's/^REALTIME_DB_ENC_KEY=//p' "$WORK/.env")"

  # Assinatura do webhook: o knob chega a app e worker, desligado por padrão (o
  # WAHA Core não assina — ligar derrubaria a entrada de mensagens) e ligável
  # pelo Environment para quem usa WAHA Plus.
  assina() { python3 -c 'import json,sys; s=json.load(open(sys.argv[1]))["services"]; print(s["app"]["environment"]["WAHA_WEBHOOK_REQUIRE_SIGNATURE"], s["worker"]["environment"]["WAHA_WEBHOOK_REQUIRE_SIGNATURE"])' "$1"; }
  check "WAHA_WEBHOOK_REQUIRE_SIGNATURE chega a app e worker (padrão false, como o kit)" igual "$(assina "$WORK/cfg.json")" 'false false'
  { cat "$WORK/.env"; echo "WAHA_WEBHOOK_REQUIRE_SIGNATURE=true"; } > "$WORK/.env-assina"
  config "$WORK/.env-assina" > "$WORK/cfg-assina.json" 2>/dev/null
  check "…e liga pelo Environment, sem editar o compose" igual "$(assina "$WORK/cfg-assina.json")" 'true true'

  env -i PATH="$PATH" HOME="$HOME" docker compose -f "$COMPOSE" --env-file /dev/null config >/dev/null 2>"$WORK/err2"; rc=$?
  check "sem as variáveis, o compose recusa e diz qual falta" \
    bash -c '[ "$1" -ne 0 ] && grep -q "defina" "$2"' _ "$rc" "$WORK/err2"
  grep -v '^IMAGE_TAG=' "$WORK/.env" > "$WORK/.env-sem-tag"
  config "$WORK/.env-sem-tag" >/dev/null 2>"$WORK/err3"; rc=$?
  check "sem IMAGE_TAG, o compose recusa (não cai em 'stable') e aponta o runbook" \
    bash -c '[ "$1" -ne 0 ] && grep -q "IMAGE_TAG" "$2" && grep -q "03-instalacao-vps-dokploy" "$2"' _ "$rc" "$WORK/err3"
  grep -v '^REALTIME_DB_ENC_KEY=' "$WORK/.env" > "$WORK/.env-sem-rt"
  config "$WORK/.env-sem-rt" >/dev/null 2>"$WORK/err4"; rc=$?
  check "sem REALTIME_DB_ENC_KEY, o compose recusa e diz o que usar numa instalação antiga" \
    bash -c '[ "$1" -ne 0 ] && grep -q "REALTIME_DB_ENC_KEY" "$2" && grep -q "supabaserealtime" "$2"' _ "$rc" "$WORK/err4"
  grep -v '^OWNER_PASSWORD=' "$WORK/.env" > "$WORK/.env-sem-senha"
  config "$WORK/.env-sem-senha" >/dev/null 2>&1; rc=$?
  check "sem OWNER_PASSWORD o compose ainda resolve (depois da instalação ela pode sair)" test "$rc" -eq 0
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
check "setup: o JSON do dono sai do json_build_object do Postgres (escape correto)" \
  grep -q "json_build_object('email', :'email', 'password', :'senha'" "$SETUP"
check "setup: senha só é exigida quando o dono não existe" \
  bash -c '! grep -q "OWNER_PASSWORD:?" "$1" && grep -q "OWNER_PASSWORD está vazia" "$1"' _ "$SETUP"
check "setup: tolera os mesmos erros benignos do kit" \
  bash -c 'b="$(sed -n "s/^BENIGNOS=//p" "$1" | tr -d "\x27")"; k="$(sed -n "s/^BASELINE_ERROS_BENIGNOS=//p" "$2" | tr -d "\x27")"; [ -n "$b" ] && [ "$b" = "$k" ]' _ "$SETUP" "$ROOT/hostgator-setup-kit/_common.sh"

check "setup: tolera as mesmas disputas de conexão do kit (DISPUTA = BASELINE_ERROS_DE_DISPUTA)" \
  bash -c 'b="$(sed -n "s/^DISPUTA=//p" "$1" | tr -d "\x27")"; k="$(sed -n "s/^BASELINE_ERROS_DE_DISPUTA=//p" "$2" | tr -d "\x27")"; [ -n "$b" ] && [ "$b" = "$k" ]' _ "$SETUP" "$ROOT/hostgator-setup-kit/_common.sh"

echo "setup rodando DE VERDADE (psql, pg_isready e wget dublês):"
# O script roda sob `sh` com dublês no PATH: o psql devolve a saída que o caso
# pede e registra QUAL arquivo recebeu no -f; o wget serve o /health do Auth e
# o baseline "da tag" (ou falha, quando o caso pede).
FAKE="$WORK/fakebin"; mkdir -p "$FAKE"
cat > "$FAKE/pg_isready" <<'SH'
#!/bin/sh
exit 0
SH
cat > "$FAKE/psql" <<'SH'
#!/bin/sh
arquivo=""; tem_c=0; todos="$*"
while [ $# -gt 0 ]; do
  case "$1" in -f) arquivo="$2"; shift ;; -c) tem_c=1 ;; esac
  shift
done
if [ -n "$arquivo" ]; then
  printf '%s %s\n' "$arquivo" "$(head -1 "$arquivo")" >> "$FAKE_REGISTRO"
  [ -z "${FAKE_PSQL_SAIDA:-}" ] || printf '%s\n' "$FAKE_PSQL_SAIDA" >&2
  exit "${FAKE_PSQL_RC:-0}"
fi
case "$todos" in
  *"table_name='organizations'"*) echo "${FAKE_TEM_SCHEMA:-1}"; exit 0 ;;
  *"count(*)"*) echo 200; exit 0 ;;
esac
[ "$tem_c" -eq 1 ] && exit 0
entrada="$(cat)"
case "$entrada" in *"from auth.users"*"limit 1"*) echo 1 ;; esac
exit 0
SH
cat > "$FAKE/wget" <<'SH'
#!/bin/sh
saida=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -O) saida="$2"; shift ;;
    -T|--header|--post-data) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
printf '%s\n' "$url" >> "$FAKE_WGET_LOG"
case "$url" in
  */health) exit 0 ;;
  *raw.githubusercontent.com*)
    [ -n "${FAKE_BASELINE_REMOTO:-}" ] || { echo "wget: server returned error: HTTP/1.1 404 Not Found" >&2; exit 1; }
    cp "$FAKE_BASELINE_REMOTO" "$saida"; exit 0 ;;
esac
exit 0
SH
chmod +x "$FAKE/pg_isready" "$FAKE/psql" "$FAKE/wget"
{ echo '-- baseline DA TAG v1.57.0'; echo 'create table public.organizations (id uuid);'
  head -c 1100000 /dev/zero | tr '\0' '-'; echo; } > "$WORK/baseline-da-tag.sql"
printf '%s\n' '-- baseline DO CLONE' 'create table public.x (id int);' > "$WORK/baseline-do-clone.sql"
printf '%s\n' '<html><body>404: Not Found</body></html>' > "$WORK/baseline-pagina.sql"

# roda_setup <nome> [VAR=valor…]: roda o setup com os dublês; deixa a saída em
# $WORK/<nome>.out, o código em $WORK/<nome>.rc e os -f em $WORK/<nome>.reg.
roda_setup() {
  local nome="$1"; shift
  : > "$WORK/$nome.reg"; : > "$WORK/$nome.wget"
  env -i PATH="$FAKE:$PATH" HOME="$HOME" \
    DB_URL=postgresql://postgres:x@db:5432/postgres AUTH_URL=http://auth:9999 \
    SERVICE_ROLE_KEY=srk OWNER_EMAIL=dono@exemplo.com NUVEMSHOP_OAUTH_ENCRYPTION_KEY=k \
    IMAGE_TAG=1.57.0 BASELINE_ESPERA_S=0 FAKE_BASELINE_REMOTO="$WORK/baseline-da-tag.sql" \
    FAKE_REGISTRO="$WORK/$nome.reg" FAKE_WGET_LOG="$WORK/$nome.wget" "$@" \
    sh "$SETUP" > "$WORK/$nome.out" 2>&1
  echo $? > "$WORK/$nome.rc"
}
rc_de() { cat "$WORK/$1.rc"; }

# R9: só o que é do storage ou o psql que não chegou ao fim reprovam; o resto é
# aviso, como no update.sh do kit.
roda_setup benigno FAKE_PSQL_SAIDA='ERROR:  relation "crm_leads" already exists'
check "update: só 'already exists' → segue sem aviso" \
  bash -c '[ "$(cat "$1.rc")" = 0 ] && ! grep -q AVISO "$1.out" && grep -q "\[setup\] pronto" "$1.out"' _ "$WORK/benigno"
roda_setup inexistente FAKE_PSQL_SAIDA='ERROR:  function public.fn_antiga(uuid) does not exist'
check "update: 'does not exist' fora do storage → AVISO e segue (o kit tolera; não trava o redeploy)" \
  bash -c '[ "$(cat "$1.rc")" = 0 ] && grep -q "AVISO" "$1.out" && grep -q "fn_antiga" "$1.out" && grep -q "\[setup\] pronto" "$1.out"' _ "$WORK/inexistente"
roda_setup sem-bucket FAKE_PSQL_SAIDA='ERROR:  relation "storage.buckets" does not exist'
check "update: relation \"storage.…\" does not exist → REPROVA e manda olhar o storage" \
  bash -c '[ "$(cat "$1.rc")" != 0 ] && grep -q "NÃO se aplicou por inteiro" "$1.out" && grep -q "Logs do storage" "$1.out"' _ "$WORK/sem-bucket"
roda_setup sem-schema FAKE_PSQL_SAIDA='ERROR:  schema "storage" does not exist'
check "update: schema \"storage\" does not exist → REPROVA" \
  bash -c '[ "$(cat "$1.rc")" != 0 ] && grep -q "NÃO se aplicou por inteiro" "$1.out"' _ "$WORK/sem-schema"
roda_setup caiu FAKE_PSQL_SAIDA='psql: error: server closed the connection unexpectedly' FAKE_PSQL_RC=2
check "update: psql que não chega ao fim → tenta 3 vezes e REPROVA" \
  bash -c '[ "$(cat "$1.rc")" != 0 ] && [ "$(wc -l < "$1.reg")" -eq 3 ] && grep -q "o psql saiu com código 2" "$1.out"' _ "$WORK/caiu"

# R10: o schema aplicado é o da versão das imagens, não o da ponta do clone.
roda_setup da-tag
check "o baseline aplicado é o baixado da tag v\${IMAGE_TAG}, não o do clone" \
  bash -c '[ "$(cat "$1.rc")" = 0 ] && grep -q "baseline DA TAG" "$1.reg" && ! grep -q "^/baseline.sql" "$1.reg"' _ "$WORK/da-tag"
check "…baixado de raw.githubusercontent.com/renoribeiro/DeskcommCRM-re9/v1.57.0/supabase/baseline.sql" \
  grep -qx 'https://raw.githubusercontent.com/renoribeiro/DeskcommCRM-re9/v1.57.0/supabase/baseline.sql' "$WORK/da-tag.wget"
roda_setup tag-ausente FAKE_BASELINE_REMOTO=
check "download que falha → REPROVA com a tag no texto, sem aplicar schema nenhum" \
  bash -c '[ "$(cat "$1.rc")" != 0 ] && grep -q "v1.57.0" "$1.out" && grep -q "NÃO aplica o schema de outra versão" "$1.out" && [ ! -s "$1.reg" ]' _ "$WORK/tag-ausente"
roda_setup pagina FAKE_BASELINE_REMOTO="$WORK/baseline-pagina.sql"
check "download que devolve outra coisa (página de erro, arquivo curto) → REPROVA" \
  bash -c '[ "$(cat "$1.rc")" != 0 ] && grep -q "não parece um baseline" "$1.out" && [ ! -s "$1.reg" ]' _ "$WORK/pagina"
roda_setup sem-tag IMAGE_TAG=
check "sem IMAGE_TAG (modo padrão) → REPROVA antes de tocar no banco" \
  bash -c '[ "$(cat "$1.rc")" != 0 ] && grep -q "IMAGE_TAG" "$1.out" && [ ! -s "$1.reg" ]' _ "$WORK/sem-tag"
roda_setup clone BASELINE_FONTE=clone BASELINE="$WORK/baseline-do-clone.sql" FAKE_BASELINE_REMOTO=
check "BASELINE_FONTE=clone usa o arquivo montado, sem baixar nada" \
  bash -c '[ "$(cat "$1.rc")" = 0 ] && grep -q "baseline DO CLONE" "$1.reg" && ! grep -q raw.githubusercontent "$1.wget"' _ "$WORK/clone"
roda_setup fonte-errada BASELINE_FONTE=main
check "BASELINE_FONTE desconhecida → REPROVA" \
  bash -c '[ "$(cat "$1.rc")" != 0 ] && grep -q "BASELINE_FONTE=.main. não existe" "$1.out"' _ "$WORK/fonte-errada"

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo 'ok: o compose do Dokploy resolve, publica só o necessário, usa nomes únicos e o gerador produz chaves válidas'
