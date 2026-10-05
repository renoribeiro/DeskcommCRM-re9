/**
 * Gera o `docker-compose.hostinger.yml` a partir de `infra/hostinger/compose.template.yml`.
 *
 *   pnpm compose:hostinger              # escreve o arquivo
 *   pnpm compose:hostinger --conferir   # só confere; sai 1 se estiver fora de dia
 *
 * O editor YAML do Docker Manager da Hostinger é mais estrito que o Docker
 * Compose, e recusa o arquivo inteiro com "O arquivo YAML não pôde ser
 * processado" (marcando a linha 1) sem dizer o porquê. Medido em duas rodadas:
 * recusou a versão com acento e, depois, a versão sem acento que tinha blocos
 * `x-` no topo, `<<:` e `configs` com os arquivos do Supabase embutidos. Por
 * isso o molde usa só o que o YAML do Typebot, que o painel aceita, já usa, e
 * os arquivos do Supabase são baixados da tag da versão pelo serviço `arquivos`.
 *
 * O gerador faz duas coisas, e cada uma evita um defeito silencioso:
 *
 * 1. **A lista de variáveis do CRM não é copiada à mão.** Ela sai do bloco
 *    `x-crm-env` do `docker-compose.dokploy.yml`, que já é conferido contra
 *    `lib/env.ts`, e entra sob `environment: &crm-env` do app (o worker usa
 *    `*crm-env`). Mudam só DEPLOY_MODE e os endereços internos (sem o prefixo
 *    `imobcrm-`, que só existe na rede compartilhada do Dokploy).
 *
 * 2. **O arquivo inteiro é ASCII.** Comentários e mensagens perdem o acento
 *    (`asciiDoTexto`), e o gerador recusa produzir arquivo com outro caractere.
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

/**
 * As variáveis do CRM do bloco `x-crm-env` do compose do Dokploy, prontas para
 * ficar sob `environment:` do app (recuo `indentacao`), com DEPLOY_MODE=hostinger
 * e os endereços internos pelos NOMES DOS SERVIÇOS: no Dokploy eles levam o
 * prefixo `imobcrm-` porque o app também está na rede compartilhada do Traefik;
 * na Hostinger cada projeto tem a rede dele, e o apelido não existe.
 */
export function variaveisDoCrm(composeDokploy: string, indentacao: string): string {
  const inicio = composeDokploy.indexOf("x-crm-env: &crm-env\n");
  const fim = composeDokploy.indexOf("\nservices:\n");
  if (inicio < 0 || fim < 0 || fim < inicio) {
    throw new Error(`${COMPOSE_DOKPLOY}: bloco "x-crm-env: &crm-env" … "services:" não encontrado`);
  }
  let bloco = composeDokploy
    .slice(inicio + "x-crm-env: &crm-env\n".length, fim)
    .replace(/\n+$/, "");
  if (!bloco.includes(DEPLOY_MODE_DOKPLOY)) {
    throw new Error(
      `${COMPOSE_DOKPLOY}: a linha de DEPLOY_MODE mudou de forma — atualize DEPLOY_MODE_DOKPLOY neste gerador`,
    );
  }
  bloco = bloco
    .replace(DEPLOY_MODE_DOKPLOY, DEPLOY_MODE_HOSTINGER)
    .replace(/imobcrm-([a-z]+)/g, "$1")
    .replace(
      "  # ── Endereços (apelidos únicos da rede privada; ver o cabeçalho) ──",
      "  # ── Endereços internos (os nomes dos serviços deste projeto) ──",
    );
  return bloco
    .split("\n")
    .map((linha) => {
      if (linha.length === 0) return "";
      if (!linha.startsWith("  ")) throw new Error(`${COMPOSE_DOKPLOY}: linha fora do recuo do x-crm-env: ${linha}`);
      return indentacao + linha.slice(2);
    })
    .join("\n");
}

/** Troca o que não é ASCII por um equivalente ASCII, em texto que é só para leitura. */
const EQUIVALENTE_ASCII: Record<string, string> = {
  "—": "-", "–": "-", "─": "-", "═": "=", "…": "...", "→": "->", "›": ">", "‹": "<",
  "“": '"', "”": '"', "‘": "'", "’": "'", "×": "x", "≥": ">=", "≤": "<=", "º": "o", "ª": "a",
};

export function asciiDoTexto(texto: string): string {
  const semAcento = texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7f]/g, (c) => EQUIVALENTE_ASCII[c] ?? c);
  const sobra = semAcento.match(/[^\x00-\x7f]/);
  if (sobra) {
    throw new Error(
      `caractere sem equivalente ASCII no texto do molde: "${sobra[0]}" (U+${sobra[0].codePointAt(0)!.toString(16)}) — acrescente-o a EQUIVALENTE_ASCII`,
    );
  }
  return semAcento;
}

export function gerar(lerArquivo: (caminho: string) => string = ler): string {
  const molde = lerArquivo(MOLDE);
  const inicio = molde.indexOf(INICIO_DO_CABECALHO);
  if (inicio < 0) throw new Error(`${MOLDE}: cabeçalho "${INICIO_DO_CABECALHO}" não encontrado`);

  const saida: string[] = AVISO_DE_GERADO.map(asciiDoTexto);
  for (const linha of molde.slice(inicio).split("\n")) {
    const crmEnv = linha.match(/^(\s+)#@crm-env$/);
    if (crmEnv) {
      saida.push(asciiDoTexto(variaveisDoCrm(lerArquivo(COMPOSE_DOKPLOY), crmEnv[1]!)));
      continue;
    }
    if (linha.includes("#@")) throw new Error(`${MOLDE}: marcador desconhecido: ${linha.trim()}`);
    saida.push(asciiDoTexto(linha));
  }
  const gerado = saida.join("\n").replace(/\n*$/, "\n");
  const naoAscii = gerado.match(/[^\x00-\x7f]/);
  if (naoAscii) throw new Error(`o arquivo gerado tem caractere não ASCII: "${naoAscii[0]}"`);
  return gerado;
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
