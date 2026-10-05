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
 * 2. **O arquivo inteiro é ASCII.** O editor YAML do Docker Manager da Hostinger
 *    recusa o arquivo no primeiro caractere acentuado ("O arquivo YAML não pôde
 *    ser processado", com a linha 1 marcada no "à"). Comentários e mensagens do
 *    molde perdem o acento (`asciiDoTexto`); os arquivos embutidos que têm acento
 *    (mensagens do script de preparo) entram como string YAML entre aspas
 *    duplas com escapes `\uXXXX` — o contêiner recebe os MESMOS bytes, com
 *    acento, e o gate confere.
 *
 * 3. **A lista de variáveis do CRM não é copiada à mão.** Ela sai do bloco
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

/**
 * Arquivo com caractere não ASCII, como string YAML entre aspas duplas, uma linha
 * do arquivo por linha do YAML. Cada linha termina em `\n\` (quebra escapada: o
 * parser junta sem espaço) e espaço ou tab no começo da linha vira `\x20`/`\t`,
 * porque o YAML descarta o recuo de uma linha de continuação.
 */
export function arquivoComoAspasDuplas(conteudo: string, indentacao: string): string {
  const escapar = (trecho: string): string =>
    Array.from(trecho)
      .map((c) => {
        const cp = c.codePointAt(0)!;
        if (c === "\\") return "\\\\";
        if (c === '"') return '\\"';
        if (c === "$") return "$$";
        if (c === "\t") return "\\t";
        if (cp < 0x20 || cp === 0x7f) return "\\x" + cp.toString(16).padStart(2, "0");
        if (cp > 0x7e) {
          return cp > 0xffff
            ? "\\U" + cp.toString(16).padStart(8, "0")
            : "\\u" + cp.toString(16).padStart(4, "0");
        }
        return c;
      })
      .join("");
  const linhas = conteudo.split("\n");
  const ultima = linhas.pop() ?? "";
  const partes = linhas.map((linha, i) => {
    const corpo = escapar(linha).replace(/^ /, "\\x20");
    return (i === 0 ? '"' : indentacao) + corpo + "\\n\\";
  });
  partes.push((linhas.length === 0 ? '"' : indentacao) + escapar(ultima).replace(/^ /, "\\x20") + '"');
  return partes.join("\n");
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

  const saida: string[] = AVISO_DE_GERADO.map(asciiDoTexto);
  for (const linha of molde.slice(inicio).split("\n")) {
    if (linha === "#@crm-env") {
      saida.push(asciiDoTexto(blocoCrmEnv(lerArquivo(COMPOSE_DOKPLOY))));
      continue;
    }
    const embutido = linha.match(/^(\s+)#@arquivo (\S+)$/);
    if (embutido) {
      const conteudo = lerArquivo(embutido[2]!);
      if (/[^\x00-\x7f]/.test(conteudo)) {
        // A linha anterior é `content: |`: vira `content: "…"`, na mesma chave.
        const anterior = saida.pop() ?? "";
        const chave = anterior.match(/^(\s+content:) \|$/);
        if (!chave) throw new Error(`${MOLDE}: #@arquivo ${embutido[2]} sem "content: |" na linha anterior`);
        saida.push(`${chave[1]} ${arquivoComoAspasDuplas(conteudo, embutido[1]!)}`);
      } else {
        saida.push(arquivoEmbutido(conteudo, embutido[1]!));
      }
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
