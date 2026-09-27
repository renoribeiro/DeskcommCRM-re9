/**
 * Cron driver genérico do event_log — a peça prometida em dispatcher.ts.
 *
 * Seleciona SÓ event_types com handler registrado: tipos drenados por crons
 * dedicados (ex. ai_agent.dispatch_requested → agent-dispatcher) não têm
 * handler no registry e ficam intocados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  avisoDeEventoMorto,
  IA_QUE_NAO_RESPONDEU,
  MENSAGEM_QUE_NAO_ENTROU,
} from "@/lib/event-log/aviso-de-evento-morto";
import { dispatchEvent, getRegisteredHandlers, type EventRow } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";

const MAX_ATTEMPTS = 5;

/** Depois disto, um evento em `processing` é considerado órfão e volta à fila. */
const PROCESSING_STALE_MS = 10 * 60 * 1000;

/**
 * Teto de órfãos devolvidos por tique. Sem teto, um backlog grande de presos
 * (worker caído por horas) virava um SELECT sem limite e centenas de UPDATEs
 * num tique só; o resto volta nos tiques seguintes.
 */
const STALE_RECOVERY_LIMIT = 100;

export interface DrainSummary {
  /**
   * Os `skipped` COM motivo, para o resumo poder ser lido de fora do banco.
   *
   * Opcional de propósito: quem monta um `DrainSummary` literal (por exemplo
   * `tests/unit/event-log-drain-loop.test.ts`) não precisa mudar.
   */
  pulados?: string[];
  /**
   * Desfechos descartados porque a posse do evento foi perdida (o handler
   * passou da janela de órfão e outra instância o reclamou). Opcional pelo
   * mesmo motivo de `pulados`.
   */
  perdidos?: number;
  scanned: number;
  done: number;
  retried: number;
  failed: number;
  dead: number;
}

function backoffAt(attempts: number): string {
  // 1min, 2min, 4min, 8min... (2^n minutos)
  const minutes = Math.pow(2, attempts);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * O EVENTO QUE MORREU PRECISA DIZER A ALGUÉM QUE MORREU.
 *
 * O kind `event_dead` existia na constraint de `agent_inbox_items` desde a
 * migration 0050, na cópia (`lib/ai/agent-inbox-copy.ts`) e na política de
 * destino (`lib/ai/inbox-destino.ts`) — e **não tinha um único produtor no
 * repositório**. Um evento que esgotava as 5 tentativas virava `status='dead'`
 * e sumia: nenhum aviso, nenhuma tela, nenhum Sentry.
 *
 * Medido numa VPS em produção: quatro `media.derive_requested` mortos, com o
 * cliente ouvindo "não consigo ouvir áudio" e ninguém do lado de cá sabendo.
 * O evento morto é o fim da linha de um efeito colateral que o produto
 * prometeu — mídia que nunca foi derivada, mensagem que nunca saiu. Silêncio
 * aqui é a promessa quebrada sem recibo.
 *
 * ⚠️ NASCE SEM REFERÊNCIA, e isso é a política, não esquecimento:
 * `POLITICAS_DE_AVISO.event_dead` declara `refs: []` porque não existe tela de
 * `event_log` para onde mandar quem lê. Preencher `ref_kind` com uma entidade
 * sem destino faria o aviso oferecer um botão que não leva a lugar nenhum.
 *
 * Dedupe por `kind`, MENOS o aviso da IA que deixou de responder: um aviso
 * aberto por organização enquanto o problema durar, como `midia_nao_lida` e
 * `budget_exceeded` já fazem. Uma linha por evento inundaria a Central numa pane
 * de handler — e Central inundada é Central que ninguém abre, que é como o
 * alerta morre pela segunda vez. O aviso da IA (dreno do agent-engine) é outra
 * família e fica fora da consulta: sem isso, ele aberto calaria a mídia, e a
 * mídia aberta já não o cala (`aviso-de-evento-morto.ts`, "as duas famílias").
 *
 * Fire-and-forget: falhar ao avisar não pode derrubar o dreno.
 */
async function avisarEventoMorto(
  admin: SupabaseClient,
  row: Pick<EventRow, "id" | "organization_id" | "event_type" | "attempts">,
  motivo: string,
): Promise<void> {
  try {
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("kind", "event_dead")
      .eq("status", "open")
      .neq("title", IA_QUE_NAO_RESPONDEU.titulo)
      .neq("title", MENSAGEM_QUE_NAO_ENTROU.titulo)
      .limit(1)
      .maybeSingle();
    if (jaAberto) return;

    // `critical` e não `warn`: é a mesma classe de `job_dead` — algo que o
    // produto prometeu fazer parou de tentar. O CHECK de
    // `agent_inbox_items.severity` aceita info|warn|critical, e valor fora
    // disso é recusado com 23514: o aviso nunca abriria, exatamente no caso
    // que esta função existe para tornar visível.
    // O texto é o MESMO do dreno do agent-engine (`edge/crm/drain.ts`), que
    // desiste do `ai_agent.dispatch_requested` — ver `aviso-de-evento-morto.ts`.
    const { title, body } = avisoDeEventoMorto({
      eventType: row.event_type,
      tentativas: row.attempts + 1,
      motivo,
    });
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: row.organization_id,
      kind: "event_dead",
      severity: "critical",
      title,
      body,
    });
    if (error) {
      logger.error("[event-log.drain] aviso de evento morto recusado", {
        event_id: row.id,
        error: error.message,
      });
    }
  } catch (err) {
    logger.error("[event-log.drain] aviso de evento morto falhou", {
      event_id: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function drainEventLog(
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<DrainSummary> {
  const limit = opts.limit ?? 50;
  const summary: DrainSummary = {
    scanned: 0,
    done: 0,
    retried: 0,
    failed: 0,
    dead: 0,
    pulados: [],
  };

  const handledTypes = [...new Set(getRegisteredHandlers().flatMap((h) => h.events))];
  if (!handledTypes.length) return summary;

  const nowIso = new Date().toISOString();

  // ─── EVENTO PRESO EM `processing` VOLTA PARA A FILA ────────────────────────
  //
  // A linha é marcada `processing` ANTES de o handler rodar, e NADA no produto
  // a devolvia: um handler que não retorna — processo derrubado no meio, OOM,
  // ida a um serviço externo sem timeout — deixava o evento preso para SEMPRE.
  // Não é hipótese: foi medido nesta frente com o Redis do debounce apontando
  // para uma porta sem ninguém escutando. O evento ficou `processing`,
  // `attempts=0`, `consumed_by` vazio, e o material que a pessoa cadastrou
  // nunca foi preparado — sem erro em lugar nenhum, e sem uma segunda chance.
  //
  // `job_queue` tem reaper desde sempre; o `event_log` não tinha. É o
  // invariante 4 do Sistema Vivo (nenhuma demanda sem próximo passo) aplicado à
  // fila de eventos.
  //
  // A janela é generosa de propósito: o handler mais lento do registry é um
  // turno de agente, e reclamar cedo demais faria DOIS workers agirem sobre o
  // mesmo evento — trocar um evento parado por um efeito em dobro.
  //
  // `updated_at` é confiável como "quando alguém tocou esta linha": o trigger
  // `trg_event_log_touch` (BEFORE UPDATE) o reescreve em toda atualização, então
  // a linha carrega o instante do CLAIM enquanto o handler não volta.
  const limiteDePresos = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
  const { data: presos } = await admin
    .from("event_log")
    .select("id, organization_id, event_type, attempts")
    .eq("status", "processing")
    .lt("updated_at", limiteDePresos)
    .order("updated_at", { ascending: true })
    .limit(STALE_RECOVERY_LIMIT);

  // ─── E A VOLTA CONTA COMO TENTATIVA ────────────────────────────────────────
  //
  // Devolver o evento à fila com `attempts` intacto era o laço que derrubava o
  // worker de produção 313 vezes em 2026-09-15: um PDF de 18 KB estourava o
  // heap (`lib/ai/rag/extractors/pdf.ts` explica o custo), o processo morria
  // ANTES de o handler devolver erro — e só handler que devolve erro
  // incrementava `attempts`. O evento voltava a `pending` com `attempts=0`,
  // era reclamado de novo, matava de novo. Um evento envenenado tinha
  // tentativas infinitas, e o `MAX_ATTEMPTS` só valia para quem falhava
  // educadamente.
  //
  // Um evento que ficou `processing` além da janela é uma tentativa que não
  // voltou. Conta como as outras: mesmo `attempts + 1`, mesmo `dead` no limite,
  // mesmo aviso na Central. O backoff importa tanto quanto a contagem — sem ele,
  // o evento reclamado é o primeiro da fila do próximo tique, e o worker
  // recém-reiniciado morre no mesmo minuto.
  //
  // MAS ele entra a partir da SEGUNDA volta, e a exceção tem dono: o invariante
  // `tests/invariants/event-log-drain.test.ts`, caso 9, afirma que o órfão volta
  // para a fila E É PROCESSADO NO MESMO TIQUE, com a razão escrita lá — o órfão
  // legítimo (um deploy que reiniciou o worker no meio de um evento sadio) não
  // deve pagar espera nenhuma, porque a espera é o defeito que aquele caso veio
  // impedir. Cobrar backoff já na primeira volta trocaria o laço do evento
  // envenenado por uma lentidão em todo deploy.
  //
  // O laço quebra igual: o envenenado volta UMA vez de graça, derruba o processo
  // de novo, e da segunda em diante paga 2, 4, 8… minutos até `MAX_ATTEMPTS`.
  // Uma tentativa a mais por evento envenenado é o preço de não tirar do órfão
  // legítimo a volta imediata que ele sempre teve.
  //
  // Um por um, com o guarda da LINHA EXATA que foi lida como presa: `status =
  // 'processing'`, o MESMO `attempts` e `updated_at` ainda além da janela. Duas
  // instâncias do dreno (o laço do worker e o cron do app) podem ler a mesma
  // linha presa, e só a primeira a tocar incrementa.
  //
  // O guarda de `status` sozinho NÃO bastava: entre a leitura da instância Y e
  // o update dela, a instância Z devolve o preso à fila (attempts+1) e X o
  // reclama de novo — a linha volta a ser `processing`, agora com uma posse
  // fresca. O update de Y casava com ela e devolvia à fila o claim VIVO de X:
  // o evento rodava de novo em paralelo. `attempts` é a posse (ver o claim
  // abaixo) e `updated_at` é o instante do claim; com os dois no filtro, o
  // reaper só alcança o claim velho que de fato leu.
  let reclamados = 0;
  for (const preso of presos ?? []) {
    const attempts = preso.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    // `preso.attempts === 0` é a PRIMEIRA volta deste evento — ninguém o
    // reclamou antes. Ele volta pronto para o mesmo tique (ver acima).
    const primeiraVolta = preso.attempts === 0;
    const motivo = `tentativa não voltou em ${PROCESSING_STALE_MS / 60_000} min (processo derrubado?)`;
    const { data: tocado } = await admin
      .from("event_log")
      .update({
        status: dead ? "dead" : "pending",
        attempts,
        last_error: motivo,
        next_attempt_at: dead || primeiraVolta ? null : backoffAt(attempts),
        updated_at: nowIso,
      })
      .eq("id", preso.id)
      .eq("status", "processing")
      .eq("attempts", preso.attempts)
      .lt("updated_at", limiteDePresos)
      .select("id");
    if (!tocado?.length) continue;
    reclamados += 1;
    if (dead) {
      summary.dead += 1;
      await avisarEventoMorto(admin, preso, motivo);
    }
  }
  if (reclamados) {
    logger.warn("[event-log.drain] eventos presos em processing devolvidos à fila", {
      quantidade: reclamados,
    });
  }

  const { data: rows, error } = await admin
    .from("event_log")
    // `created_at` viaja porque um consumidor não consegue distinguir "evento de
    // agora" de "evento de três dias parado em `pending`" sem ele — e o drain
    // leva 50 por tick sem janela de recência, então um backlog vira enxurrada
    // de efeitos com data errada no primeiro tick depois de um deploy.
    .select(
      "id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts, created_at",
    )
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .in("event_type", handledTypes)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    logger.error("[event-log.drain] select failed", { error: error.message });

    return summary;
  }

  for (const raw of rows ?? []) {
    const row = raw as unknown as EventRow;
    summary.scanned += 1;

    // Claim otimista — outra instância pode ter pego a mesma linha.
    //
    // O `attempts` LIDO é a posse (lease) deste claim. Ninguém o reescreve para
    // o mesmo valor: o reaper de órfãos acima incrementa, e só quem tem a posse
    // grava o desfecho. Então "status = processing E attempts = o que eu li" é
    // verdade enquanto — e só enquanto — a posse for minha. Sem coluna nova.
    const { data: claimed } = await admin
      .from("event_log")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .eq("attempts", row.attempts)
      .select("id");
    if (!claimed?.length) continue;

    // ─── O DESFECHO SÓ É GRAVADO POR QUEM AINDA TEM A POSSE ──────────────────
    //
    // Um handler que passa da janela de órfão (10 min) tem o evento devolvido
    // à fila pelo reaper, e OUTRA instância o reclama e processa. Quando o
    // handler lento enfim volta, o update final antigo — `.eq("id")` sozinho —
    // sobrescrevia o desfecho do segundo: `done` virava `pending`, ou `dead`
    // abria aviso de um evento que já tinha dado certo, e `consumed_by`
    // regredia. Com o guarda, a gravação tardia não casa com linha nenhuma e o
    // desfecho de quem tem a posse fica.
    const finalizar = async (patch: Record<string, unknown>): Promise<boolean> => {
      const { data: tocado } = await admin
        .from("event_log")
        .update(patch)
        .eq("id", row.id)
        .eq("status", "processing")
        .eq("attempts", row.attempts)
        .select("id");
      if (tocado?.length) return true;
      summary.perdidos = (summary.perdidos ?? 0) + 1;
      logger.warn("[event-log.drain] posse perdida: desfecho tardio descartado", {
        event_id: row.id,
        event_type: row.event_type,
      });
      return false;
    };

    const results = await dispatchEvent(row);

    const okKeys = results
      .filter((r) => r.status === "ok" || r.status === "skipped")
      .map((r) => r.consumer_key);
    const consumedBy = [...new Set([...row.consumed_by, ...okKeys])];
    const retry = results.find((r) => r.status === "retry");
    const errors = results.filter((r) => r.status === "error");

    if (retry) {
      // Reagendamento benigno (ex. janela anti-ban): NÃO conta attempt — mesmo
      // que outro handler do mesmo tick tenha retornado erro (esse handler
      // nunca entrou em consumed_by, então ele reroda no próximo tick; aqui só
      // preservamos o last_error dele pra visibilidade/observabilidade).
      // retry_at é opcional no HandlerResult — sem ele, aplica o mesmo backoff
      // do branch de erro pra não busy-loop reprocessando a cada tick.
      const retryAt = retry.retry_at ?? backoffAt(row.attempts + 1);
      const gravou = await finalizar({
          status: "pending",
          consumed_by: consumedBy,
          next_attempt_at: retryAt,
          updated_at: new Date().toISOString(),
          ...(errors.length
            ? {
                last_error: errors
                  .map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`)
                  .join("; "),
              }
            : {}),
      });
      if (gravou) summary.retried += 1;
    } else if (errors.length) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const motivo = errors.map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`).join("; ");
      const gravou = await finalizar({
        status: dead ? "dead" : "pending",
        attempts,
        consumed_by: consumedBy,
        last_error: motivo,
        next_attempt_at: dead ? null : backoffAt(attempts),
        updated_at: new Date().toISOString(),
      });
      if (!gravou) continue;
      if (dead) await avisarEventoMorto(admin, row, motivo);
      summary[dead ? "dead" : "failed"] += 1;
    } else {
      // O MOTIVO DE UM `skipped` SOBREVIVE À LINHA.
      //
      // `skipped` conta como sucesso — e deve mesmo: o handler decidiu que não
      // era caso dele. Mas o `detail` era DESCARTADO por construção, e com ele
      // a única evidência de por que um evento não fez nada. Quem investigasse
      // "subi o material e não aconteceu nada" encontrava uma linha `done` sem
      // uma palavra de explicação.
      //
      // Não muda o desfecho do evento; só deixa de jogar fora a resposta.
      const pulados = results.filter((r) => r.status === "skipped" && r.detail);
      // E o motivo sai também no RESUMO, não só na linha.
      //
      // A linha basta para quem tem psql; não basta para o CI, onde o único
      // artefato que sobrevive ao job é o trace — e o trace guarda o CORPO da
      // resposta HTTP. Um e2e que morre porque o gatilho pulou ficava sem poder
      // dizer QUAL pulo foi: travou por horas o diagnóstico de
      // `gatilho-de-etapa.spec.ts`, com `failed=0` e nenhuma pista.
      if (pulados.length)
        summary.pulados?.push(
          ...pulados.map((r) => `${row.event_type}/${r.consumer_key}: ${r.detail}`),
        );
      const gravou = await finalizar({
        status: "done",
        consumed_by: consumedBy,
        updated_at: new Date().toISOString(),
        ...(pulados.length
          ? { last_error: pulados.map((r) => `${r.consumer_key}: ${r.detail}`).join("; ") }
          : {}),
      });
      if (gravou) summary.done += 1;
    }
  }
  return summary;
}
