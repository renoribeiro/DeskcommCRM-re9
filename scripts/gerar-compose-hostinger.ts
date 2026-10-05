/**
 * Gera o `docker-compose.hostinger.yml` a partir de `infra/hostinger/compose.template.yml`.
 *
 *   pnpm compose:hostinger              # escreve o arquivo
 *   pnpm compose:hostinger --conferir   # só confere; sai 1 se estiver fora de dia
 *
 * O Docker Manager da Hostinger recebe SÓ o YAML, sem o repositório ao lado. O
 * compose do Dokploy monta arquivos do clone (init do banco, gateway, script de
 * preparo); aqui eles entram no próprio YAML, em `configs:` com `content:`.
 *
 * Duas regras, e cada uma evita um defeito silencioso:
 *
 * 1. **Todo `$` vira `$$`.** O compose interpola `${…}` em qualquer valor do
 *    arquivo, `content` inclusive. Um `$POSTGRES_PASSWORD` dentro do script de
 *    preparo seria trocado pelo valor do painel na hora do deploy — ou por vazio —
 *    e o SQL `$$ … $$` das funções viraria `$ … $`. O gate confere, pela saída do
 *    próprio `docker compose config`, que cada arquivo chega ao contêiner byte a
 *    byte igual ao do repositório.
 *
 * 2. **A lista de variáveis do CRM não é copiada à mão.** Ela sai do bloco
 *    `x-crm-env` do `docker-compose.dokploy.yml`, que já é conferido contra
 *    `lib/env.ts`; só `DEPLOY_MODE` muda. Variável nova no CRM chega às duas
 *    instalações pelo mesmo lugar.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RAIZ = process.cwd();
const MOLDE = "infra/hostinger/compose.template.yml";
const DESTINO = "docker-compose.hostinger.yml";
const COMPOSE_DOKPLOY = "docker-compose.dokploy.yml";

/** Onde começa o texto que vai para o arquivo final (o que vem antes é nota do molde). */
const INICIO_DO_CABECALHO = "# ImobCRM / DeskcommCRM no DOCKER MANAGER DA HOSTINGER";

const AVISO_DE_GERADO = [
  "# ARQUIVO GERADO — não edite à mão.",
  `#   Origem: ${MOLDE} + ${COMPOSE_DOKPLOY} (x-crm-env) + arquivos de infra/dokploy/.`,
  "#   Para mudar: edite a origem e rode `pnpm compose:hostinger`.",
  "#",
];

const DEPLOY_MODE_DOKPLOY = [
  "  # Diz às telas de /admin que o login (GoTrue) desta instalação lê SMTP e",
  "  # cadastro do Environment do Dokploy — não do update.sh nem do painel da nuvem.",
  "  DEPLOY_MODE: dokploy",
].join("\n");

const DEPLOY_MODE_HOSTINGER = [
  "  # Diz às telas de /admin que o login (GoTrue) desta instalação lê SMTP e",
  "  # cadastro das variáveis do Docker Manager da Hostinger — e que só uma nova",
  "  # implantação as aplica.",
  "  DEPLOY_MODE: hostinger",
].join("\n");

function ler(caminho: string): string {
  return readFileSync(join(RAIZ, caminho), "utf8");
}

/** O bloco `x-crm-env` do compose do Dokploy, com o DEPLOY_MODE da Hostinger. */
export function blocoCrmEnv(composeDokploy: string): string {
  const inicio = composeDokploy.indexOf("x-crm-env: &crm-env\n");
  const fim = composeDokploy.indexOf("\nservices:\n");
  if (inicio < 0 || fim < 0 || fim < inicio) {
    throw new Error(`${COMPOSE_DOKPLOY}: bloco "x-crm-env: &crm-env" … "services:" não encontrado`);
  }
  const bloco = composeDokploy.slice(inicio, fim).replace(/\n+$/, "");
  if (!bloco.includes(DEPLOY_MODE_DOKPLOY)) {
    throw new Error(
      `${COMPOSE_DOKPLOY}: a linha de DEPLOY_MODE mudou de forma — atualize DEPLOY_MODE_DOKPLOY neste gerador`,
    );
  }
  return bloco.replace(DEPLOY_MODE_DOKPLOY, DEPLOY_MODE_HOSTINGER);
}

/** Conteúdo de arquivo pronto para `content: |`, com `$` escapado e indentado. */
export function arquivoEmbutido(conteudo: string, indentacao: string): string {
  if (/^[ \t]/.test(conteudo)) {
    // `|` deduz a indentação da primeira linha: começar com espaço a quebraria.
    throw new Error("arquivo embutido não pode começar com espaço ou tab");
  }
  const linhas = conteudo.replace(/\n$/, "").split("\n");
  return linhas
    .map((linha) => (linha.length === 0 ? "" : indentacao + linha.replaceAll("$", "$$$$")))
    .join("\n");
}

export function gerar(lerArquivo: (caminho: string) => string = ler): string {
  const molde = lerArquivo(MOLDE);
  const inicio = molde.indexOf(INICIO_DO_CABECALHO);
  if (inicio < 0) throw new Error(`${MOLDE}: cabeçalho "${INICIO_DO_CABECALHO}" não encontrado`);

  const saida: string[] = [...AVISO_DE_GERADO];
  for (const linha of molde.slice(inicio).split("\n")) {
    if (linha === "#@crm-env") {
      saida.push(blocoCrmEnv(lerArquivo(COMPOSE_DOKPLOY)));
      continue;
    }
    const embutido = linha.match(/^(\s+)#@arquivo (\S+)$/);
    if (embutido) {
      saida.push(arquivoEmbutido(lerArquivo(embutido[2]!), embutido[1]!));
      continue;
    }
    if (linha.includes("#@")) throw new Error(`${MOLDE}: marcador desconhecido: ${linha.trim()}`);
    saida.push(linha);
  }
  return saida.join("\n").replace(/\n*$/, "\n");
}

function principal(): void {
  const conferir = process.argv.includes("--conferir");
  const gerado = gerar();
  if (conferir) {
    let atual = "";
    try {
      atual = ler(DESTINO);
    } catch {
      // ausente conta como fora de dia
    }
    if (atual !== gerado) {
      process.stderr.write(
        `${DESTINO} está fora de dia com ${MOLDE}, ${COMPOSE_DOKPLOY} ou infra/dokploy/. Rode: pnpm compose:hostinger\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${DESTINO}: em dia\n`);
    return;
  }
  writeFileSync(join(RAIZ, DESTINO), gerado);
  process.stdout.write(`${DESTINO} gerado (${gerado.split("\n").length} linhas)\n`);
}

if (process.argv[1]?.endsWith("gerar-compose-hostinger.ts")) principal();
