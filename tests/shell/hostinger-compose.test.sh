#!/usr/bin/env bash
# Gate do docker-compose.hostinger.yml — a instalação colada no editor .yaml do
# Docker Manager da Hostinger. Não sobe contêiner: usa `docker compose config`,
# que resolve o arquivo como o painel resolve, e RODA os três scripts de
# entrada (download dos arquivos, banco e gateway) contra dublês.
#
# O que se guarda, e por quê:
#
# 1. O ARQUIVO ESTÁ EM DIA COM A ORIGEM (gerado por `pnpm compose:hostinger`).
# 2. SÓ O QUE O EDITOR DA HOSTINGER ACEITA. Medido em duas rodadas: ele recusou
#    o arquivo com acento e, depois, sem acento mas com blocos `x-` no topo,
#    `<<:` e `configs` (117 KB). Aqui: ASCII, só `services` e `volumes` no topo,
#    nada de `x-`, `<<:`, `configs` nem `networks`, e tamanho de um YAML comum.
# 3. OS ARQUIVOS DO SUPABASE CHEGAM INTEIROS E NO LUGAR. O serviço `arquivos`
#    baixa da tag; db e api-gw copiam do volume. Cada script roda aqui com um
#    `wget` dublê que serve o repositório, e o resultado é comparado byte a
#    byte com o que o compose do Dokploy monta — inclusive o caminho de destino.
# 4. MESMAS IMAGENS E MESMAS VARIÁVEIS DO DOKPLOY, só DEPLOY_MODE e o prefixo
#    `imobcrm-` dos endereços diferentes.
# 5. O TRAEFIK DA HOSTINGER ACHA O APP (rede <projeto>_default, nenhuma porta).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
COMPOSE="$ROOT/docker-compose.hostinger.yml"
DOKPLOY="$ROOT/docker-compose.dokploy.yml"
fail=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

check() {
  local nome="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  ✓ %s\n' "$nome"
  else printf '  ✗ %s\n' "$nome"; fail=1; fi
}
igual() { [ "$1" = "$2" ]; }

echo "hostinger: o arquivo gerado está em dia e é aceitável pelo editor do painel"
check "pnpm compose:hostinger --conferir" \
  bash -c 'cd "$1" && node_modules/.bin/tsx scripts/gerar-compose-hostinger.ts --conferir' _ "$ROOT"
check "100% ASCII (o editor recusa acento)" \
  bash -c '! LC_ALL=C grep -q "[^ -~	]" "$1"' _ "$COMPOSE"
check "no topo, só services e volumes (o editor recusou x-* e configs)" \
  igual "$(grep -E '^[A-Za-z_-]+:' "$COMPOSE" | tr -d ':' | sort | tr '\n' ' ')" "services volumes "
check "nada de <<:, configs: nem networks: (o editor recusou; a rede do projeto basta)" \
  bash -c '! grep -nE "^[[:space:]]*(<<|configs|networks):" "$1"' _ "$COMPOSE"
check "tamanho de YAML comum (< 40 KB; a versão recusada tinha 117 KB)" \
  test "$(wc -c < "$COMPOSE")" -lt 40000

if ! docker compose version >/dev/null 2>&1; then
  echo "  - pulado: docker compose ausente (o resto do gate precisa dele)"
  [ "$fail" -eq 0 ] && echo "OK — o que pôde ser medido passou." || echo "FALHOU."
  exit "$fail"
fi

bash "$ROOT/infra/dokploy/gerar-env.sh" --dominio crmimob.exemplo.com.br --email dono@exemplo.com.br --versao 1.58.1 > "$WORK/.env"
config() { (cd "$WORK" && env -i PATH="$PATH" HOME="$HOME" docker compose -p crmimob -f "$1" --env-file "$WORK/.env" config --format json); }
if ! config "$COMPOSE" > "$WORK/cfg.json" 2> "$WORK/err"; then
  echo "  ✗ docker compose config recusou o arquivo:"; sed 's/^/      /' "$WORK/err"; exit 1
fi
config "$DOKPLOY" > "$WORK/dokploy.json" 2>/dev/null || { echo "  ✗ docker compose config recusou o compose do Dokploy"; exit 1; }

# Os scripts de entrada, como o contêiner os recebe: a saída do `config`
# re-escapa `$` como `$$`; desfeito uma vez, é o texto que o sh executa.
python3 - "$WORK/cfg.json" "$WORK" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for servico in ("arquivos", "db", "api-gw"):
    ep = d["services"][servico]["entrypoint"]
    assert ep[:2] == ["/bin/sh", "-c"], (servico, ep[:2])
    open(f"{sys.argv[2]}/{servico}.sh", "w").write(ep[2].replace("$$", "$"))
PY

echo "arquivos da versão (o serviço que baixa da tag):"
mkdir -p "$WORK/bin" "$WORK/arquivos"
cat > "$WORK/bin/wget" <<EOF
#!/bin/sh
# Dublê: serve o repositório no lugar de raw.githubusercontent.com/<repo>/v<tag>/.
while [ \$# -gt 1 ]; do [ "\$1" = "-O" ] && saida="\$2"; shift; done
url="\$1"
case "\$url" in
  https://raw.githubusercontent.com/renoribeiro/DeskcommCRM-re9/v9.9.9/*) ;;
  *) echo "url inesperada: \$url" >&2; exit 1 ;;
esac
caminho="\${url#https://raw.githubusercontent.com/renoribeiro/DeskcommCRM-re9/v9.9.9/}"
[ -f "$ROOT/\$caminho" ] || exit 1
cat "$ROOT/\$caminho" > "\$saida"
EOF
chmod +x "$WORK/bin/wget"
sed "s#/arquivos#$WORK/arquivos#g" "$WORK/arquivos.sh" > "$WORK/arquivos.local.sh"
IMAGE_TAG=9.9.9 PATH="$WORK/bin:$PATH" sh "$WORK/arquivos.local.sh" > "$WORK/arquivos.out" 2>&1; rc=$?
check "baixa tudo da tag v<IMAGE_TAG> e termina com sucesso" \
  bash -c '[ "$1" -eq 0 ] && grep -q "pronto: arquivos da versao 9.9.9" "$2"' _ "$rc" "$WORK/arquivos.out"
[ "$rc" -eq 0 ] || sed 's/^/      /' "$WORK/arquivos.out"

# O que o compose do Dokploy monta em cada serviço (origem → destino) é a
# régua: o banco e o gateway da Hostinger têm de receber o MESMO arquivo no
# MESMO caminho.
python3 - "$WORK/dokploy.json" > "$WORK/montagens.txt" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for servico in ("db", "api-gw"):
    for v in d["services"][servico].get("volumes", []):
        if v.get("type") == "bind" and "/infra/dokploy/" in v["source"]:
            origem = v["source"][v["source"].index("infra/dokploy/"):]
            print(servico, origem, v["target"])
PY
check "a régua leu as montagens do Dokploy (7 do banco + 5 do gateway)" \
  test "$(wc -l < "$WORK/montagens.txt")" -eq 12

echo "banco (init do Supabase no lugar e a entrada original da imagem):"
mkdir -p "$WORK/initdb/init-scripts" "$WORK/initdb/migrations" "$WORK/dbbin"
printf '#!/bin/sh\necho "entrada original: $*"\n' > "$WORK/dbbin/docker-entrypoint.sh"; chmod +x "$WORK/dbbin/docker-entrypoint.sh"
sed -e "s#/arquivos#$WORK/arquivos#g" -e "s#/docker-entrypoint-initdb.d/#$WORK/initdb/#g" "$WORK/db.sh" > "$WORK/db.local.sh"
# Como o contêiner roda: `sh -c <script> db <command…>` — `db` vira $0.
PATH="$WORK/dbbin:$PATH" sh -c "$(cat "$WORK/db.local.sh")" db postgres -c x > "$WORK/db.out" 2>&1; rc=$?
check "chama a entrada original com o command (postgres …)" \
  bash -c '[ "$1" -eq 0 ] && grep -qx "entrada original: postgres -c x" "$2"' _ "$rc" "$WORK/db.out"
falta_db="$(awk '$1=="db"' "$WORK/montagens.txt" | while read -r _ origem destino; do
  local_="$WORK/initdb/${destino#/docker-entrypoint-initdb.d/}"
  cmp -s "$ROOT/$origem" "$local_" || echo "$destino"
done)"
check "os 7 scripts de init chegam iguais, no mesmo caminho que o Dokploy monta" igual "$falta_db" ""

echo "gateway (configuração em /etc/envoy e a entrada oficial do Supabase):"
mkdir -p "$WORK/etc-envoy"
sed -e "s#/arquivos#$WORK/arquivos#g" -e "s#/etc/envoy/#$WORK/etc-envoy/#g" "$WORK/api-gw.sh" > "$WORK/gw.local.sh"
cp "$WORK/arquivos/envoy/docker-entrypoint.sh" "$WORK/entrada-oficial.real"
printf '#!/bin/sh\necho "entrada oficial do Supabase"\n' > "$WORK/arquivos/envoy/docker-entrypoint.sh"
sh "$WORK/gw.local.sh" > "$WORK/gw.out" 2>&1; rc=$?
cp "$WORK/entrada-oficial.real" "$WORK/arquivos/envoy/docker-entrypoint.sh"
check "copia a configuração e passa para a entrada oficial do Supabase" \
  bash -c '[ "$1" -eq 0 ] && grep -q "entrada oficial do Supabase" "$2"' _ "$rc" "$WORK/gw.out"
for arq in envoy.yaml lds.template.yaml; do
  check "/etc/envoy/$arq igual ao do repositório" \
    cmp -s "$ROOT/infra/dokploy/supabase/api/envoy/$arq" "$WORK/etc-envoy/$arq"
done
check "a entrada oficial do Supabase baixada é a do repositório" \
  cmp -s "$ROOT/infra/dokploy/supabase/api/envoy/docker-entrypoint.sh" "$WORK/arquivos/envoy/docker-entrypoint.sh"
dif="$(diff "$ROOT/infra/dokploy/supabase/api/envoy/cds.yaml" "$WORK/etc-envoy/cds.yaml" | grep -E '^[<>]' | sed -E 's/[[:space:]]+/ /g' | sort | tr '\n' '|')"
check "cds.yaml: só o endereço do Realtime muda (realtime-dev.supabase-realtime → realtime)" \
  igual "$dif" "< address: realtime-dev.supabase-realtime|> address: realtime|"
[ "$dif" = "< address: realtime-dev.supabase-realtime|> address: realtime|" ] || echo "      diff: $dif"
check "todo endereço do cds.yaml é um serviço deste projeto ou um que o CRM não usa" \
  bash -c 'grep -qE "^[[:space:]]+address:[[:space:]]" "$1" && ! grep -E "^[[:space:]]+address:[[:space:]]" "$1" | grep -vE "address: (auth|rest|storage|realtime|functions|meta|studio)$"' _ "$WORK/etc-envoy/cds.yaml"
check "o setup roda o script de preparo baixado, igual ao do repositório" \
  bash -c 'grep -q "\"/arquivos/setup/primeira-instalacao.sh\"" "$1" && cmp -s "$2/infra/dokploy/primeira-instalacao.sh" "$3/arquivos/setup/primeira-instalacao.sh"' _ "$WORK/cfg.json" "$ROOT" "$WORK"

# Download que falha tem de PARAR a implantação (db e setup dependem dele).
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/wget"
rm -rf "$WORK/arquivos"; mkdir -p "$WORK/arquivos"
IMAGE_TAG=9.9.9 PATH="$WORK/bin:$PATH" sh "$WORK/arquivos.local.sh" > "$WORK/falha.out" 2>&1; rc=$?
check "download que falha sai com erro e diz o que conferir" \
  bash -c '[ "$1" -ne 0 ] && grep -q "NAO consegui baixar" "$2"' _ "$rc" "$WORK/falha.out"

echo "espelho do Dokploy e Traefik da Hostinger:"
sonda="$(python3 - "$WORK/cfg.json" "$WORK/dokploy.json" <<'PY'
import json, re, sys
h, d = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
out = []
esperados = set(d["services"]) | {"arquivos"}
if set(h["services"]) != esperados:
    out.append("SERVICOS:" + ",".join(sorted(set(h["services"]) ^ esperados)))
for nome, s in h["services"].items():
    if nome in d["services"] and s["image"] != d["services"][nome]["image"]:
        out.append(f"IMAGEM:{nome}")
    if s.get("ports"):
        out.append(f"PORTA:{nome}")
    for v in s.get("volumes", []):
        if v.get("type") == "bind":
            out.append(f"BIND:{nome}")
def sem_prefixo(env):
    return {k: re.sub(r"imobcrm-([a-z]+)", r"\1", str(v)) for k, v in (env or {}).items()}
for nome in ("app", "worker"):
    he, de = dict(h["services"][nome]["environment"]), sem_prefixo(d["services"][nome]["environment"])
    if he.pop("DEPLOY_MODE", None) != "hostinger": out.append(f"DEPLOY_MODE:{nome}")
    de.pop("DEPLOY_MODE", None)
    if he != de: out.append(f"ENV:{nome}:" + ",".join(sorted(k for k in set(he) | set(de) if he.get(k) != de.get(k))))
for nome in h["services"]:
    if nome in ("app", "worker", "arquivos"): continue
    he, de = sem_prefixo(h["services"][nome].get("environment")), sem_prefixo(d["services"][nome].get("environment"))
    if nome == "setup":
        # Sem o repositório ao lado, o schema vem sempre da tag (versao).
        de["BASELINE_FONTE"] = "versao"
    if he != de: out.append(f"ENV:{nome}:" + ",".join(sorted(k for k in set(he) | set(de) if he.get(k) != de.get(k))))
lab = h["services"]["app"].get("labels", {})
for k, v in {
    "traefik.docker.network": "crmimob_default",
    "traefik.http.routers.crmimob.rule": "Host(`crmimob.exemplo.com.br`)",
    "traefik.http.routers.crmimob.entrypoints": "websecure",
    "traefik.http.routers.crmimob.tls.certresolver": "letsencrypt",
    "traefik.http.services.crmimob.loadbalancer.server.port": "3000",
    "traefik.http.routers.crmimob-waha-block.middlewares": "crmimob-deny",
}.items():
    if lab.get(k) != v: out.append(f"LABEL-APP:{k}={lab.get(k)}")
gw = h["services"]["api-gw"].get("labels", {})
if gw.get("traefik.docker.network") != "crmimob_default" or "/auth/v1" not in gw.get("traefik.http.routers.crmimob-supabase.rule", ""):
    out.append("LABEL-GW")
print(" ".join(out))
PY
)"
check "mesmas imagens e variáveis do Dokploy; Traefik pela rede do projeto; nenhuma porta nem bind" igual "$sonda" ""
[ -z "$sonda" ] || echo "      sonda: $sonda"

check "sem DOMAIN, o painel recusa a implantação em vez de subir sem endereço" \
  bash -c 'grep -v "^DOMAIN=" "$1" > "$1.sem" && ! (cd "$2" && env -i PATH="$PATH" HOME="$HOME" docker compose -p crmimob -f "$3" --env-file "$1.sem" config -q)' _ "$WORK/.env" "$WORK" "$COMPOSE"

[ "$fail" -eq 0 ] && echo "OK — o compose da Hostinger é aceitável pelo editor, baixa os arquivos certos e espelha o do Dokploy." || echo "FALHOU."
exit "$fail"
