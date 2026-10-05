#!/usr/bin/env bash
# Gate do docker-compose.hostinger.yml — a instalação colada no Docker Manager
# da Hostinger. Não sobe contêiner: usa `docker compose config`, que resolve o
# arquivo exatamente como o painel resolve na hora de implantar.
#
# O que se guarda, e por quê:
#
# 1. O ARQUIVO ESTÁ EM DIA COM A ORIGEM. Ele é gerado (pnpm compose:hostinger)
#    do molde em infra/hostinger/, do x-crm-env do compose do Dokploy e dos
#    arquivos de infra/dokploy/. Editar a origem sem regerar deixaria o painel
#    instalando a versão velha — sem erro nenhum.
# 2. CADA ARQUIVO EMBUTIDO CHEGA BYTE A BYTE IGUAL AO DO REPOSITÓRIO. O compose
#    interpola `${…}` dentro de `configs.content`; um `$` sem escape trocaria um
#    pedaço do script de preparo ou do SQL pelo valor (ou vazio) do painel. A
#    saída do `config` re-escapa `$` como `$$`; desfeito uma vez, tem de bater.
# 3. AUTOCONTIDO. Nenhum bind mount (o painel não tem o repositório ao lado) e
#    nenhuma porta publicada (publicar contornaria o Traefik e o bloqueio do
#    webhook do WhatsApp que mora nele).
# 4. MESMAS IMAGENS E MESMAS VARIÁVEIS DO DOKPLOY, só DEPLOY_MODE diferente. Uma
#    troca de versão do Supabase num arquivo e não no outro reprova aqui.
# 5. O TRAEFIK DA HOSTINGER ACHA O APP. Ele roda em `network_mode: host` e chega
#    pela rede <projeto>_default; router com o nome do projeto, domínio = DOMAIN.
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

echo "hostinger: o arquivo gerado está em dia com a origem"
check "pnpm compose:hostinger --conferir" \
  bash -c 'cd "$1" && node_modules/.bin/tsx scripts/gerar-compose-hostinger.ts --conferir' _ "$ROOT"

# O editor YAML do Docker Manager da Hostinger recusa o arquivo no primeiro
# caractere acentuado (medido: "O arquivo YAML não pôde ser processado", linha 1
# marcada no "à"). O gerador escreve tudo em ASCII; isto prende a regra.
check "o arquivo é 100% ASCII (o editor da Hostinger recusa acento)" \
  bash -c '! LC_ALL=C grep -q "[^ -~	]" "$1"' _ "$COMPOSE"

if ! docker compose version >/dev/null 2>&1; then
  echo "  - pulado: docker compose ausente (o resto do gate precisa dele)"
  [ "$fail" -eq 0 ] && echo "OK — o que pôde ser medido passou." || echo "FALHOU."
  exit "$fail"
fi

bash "$ROOT/infra/dokploy/gerar-env.sh" --dominio crmimob.exemplo.com.br --email dono@exemplo.com.br --versao 1.57.0 > "$WORK/.env"
config() { (cd "$WORK" && env -i PATH="$PATH" HOME="$HOME" docker compose -p crmimob -f "$1" --env-file "$WORK/.env" config --format json); }
if ! config "$COMPOSE" > "$WORK/cfg.json" 2> "$WORK/err"; then
  echo "  ✗ docker compose config recusou o arquivo:"; sed 's/^/      /' "$WORK/err"; exit 1
fi
config "$DOKPLOY" > "$WORK/dokploy.json" 2>/dev/null || { echo "  ✗ docker compose config recusou o compose do Dokploy"; exit 1; }

sonda="$(python3 - "$ROOT" "$WORK/cfg.json" "$WORK/dokploy.json" <<'PY'
import json, re, sys
raiz, h, d = sys.argv[1], json.load(open(sys.argv[2])), json.load(open(sys.argv[3]))
out = []

# 2. arquivos embutidos: o molde diz de onde vem cada config.
molde = open(f"{raiz}/infra/hostinger/compose.template.yml").read()
origem = dict(re.findall(r"^  ([a-z0-9-]+):\n    content: \|\n      #@arquivo (\S+)$", molde, re.M))
configs = h.get("configs", {})
out.append(f"configs={len(configs)} origens={len(origem)}")
for nome, caminho in sorted(origem.items()):
    conteudo = (configs.get(nome) or {}).get("content")
    if conteudo is None:
        out.append(f"SEM-CONFIG:{nome}")
    elif conteudo.replace("$$", "$") != open(f"{raiz}/{caminho}").read():
        out.append(f"DIVERGE:{nome}")

# 3. autocontido
for nome, s in h["services"].items():
    for v in s.get("volumes", []):
        if v.get("type") == "bind":
            out.append(f"BIND:{nome}:{v.get('source')}")
    if s.get("ports"):
        out.append(f"PORTA:{nome}")
if set(h.get("networks", {})) != {"default"}:
    out.append("REDE-EXTRA:" + ",".join(sorted(h.get("networks", {}))))

# 4. mesmas imagens e mesmas variáveis do Dokploy
if set(h["services"]) != set(d["services"]):
    out.append("SERVICOS-DIFEREM")
for nome in h["services"]:
    if nome in d["services"] and h["services"][nome]["image"] != d["services"][nome]["image"]:
        out.append(f"IMAGEM:{nome}")
for nome in ("app", "worker"):
    he, de = dict(h["services"][nome]["environment"]), dict(d["services"][nome]["environment"])
    if he.pop("DEPLOY_MODE", None) != "hostinger": out.append(f"DEPLOY_MODE:{nome}")
    de.pop("DEPLOY_MODE", None)
    if he != de: out.append(f"ENV-DIFERE:{nome}:" + ",".join(sorted(k for k in set(he) | set(de) if he.get(k) != de.get(k))))
for nome in h["services"]:
    if nome in ("app", "worker", "api-gw"): continue
    if h["services"][nome].get("environment") != d["services"][nome].get("environment"):
        out.append(f"ENV-DIFERE:{nome}")

# 5. Traefik da Hostinger
lab = h["services"]["app"].get("labels", {})
gw = h["services"]["api-gw"].get("labels", {})
espera = {
    "traefik.docker.network": "crmimob_default",
    "traefik.http.routers.crmimob.rule": "Host(`crmimob.exemplo.com.br`)",
    "traefik.http.routers.crmimob.entrypoints": "websecure",
    "traefik.http.routers.crmimob.tls.certresolver": "letsencrypt",
    "traefik.http.services.crmimob.loadbalancer.server.port": "3000",
    "traefik.http.routers.crmimob-waha-block.middlewares": "crmimob-deny",
}
for k, v in espera.items():
    if lab.get(k) != v: out.append(f"LABEL-APP:{k}={lab.get(k)}")
if gw.get("traefik.docker.network") != "crmimob_default" or "/auth/v1" not in gw.get("traefik.http.routers.crmimob-supabase.rule", ""):
    out.append("LABEL-GW")
print(" ".join(out))
PY
)"
n_configs="$(grep -oE '^configs=[0-9]+' <<<"$sonda" | grep -oE '[0-9]+')"
check "a sonda leu os arquivos embutidos (não está cega)" test "${n_configs:-0}" -ge 13
check "cada arquivo embutido chega igual ao do repositório, e só eles" \
  igual "$sonda" "configs=${n_configs} origens=${n_configs}"
[ "$sonda" = "configs=${n_configs} origens=${n_configs}" ] || echo "      sonda: $sonda"

check "sem DOMAIN, o painel recusa a implantação em vez de subir sem endereço" \
  bash -c 'grep -v "^DOMAIN=" "$1" > "$1.sem" && ! (cd "$2" && env -i PATH="$PATH" HOME="$HOME" docker compose -p crmimob -f "$3" --env-file "$1.sem" config -q)' _ "$WORK/.env" "$WORK" "$COMPOSE"

[ "$fail" -eq 0 ] && echo "OK — o compose da Hostinger resolve, é autocontido e espelha o do Dokploy." || echo "FALHOU."
exit "$fail"
