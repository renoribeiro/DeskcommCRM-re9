/**
 * Chave DEDICADA para assinar o `state` (e o vínculo) dos fluxos OAuth.
 *
 * Auditoria P7 (`docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`): o
 * `INTERNAL_SECRET` também é o bearer dos crons, e o runbook do relógio HTTP
 * mandava cadastrá-lo num serviço de terceiros. Quem visse aquele bearer
 * forjava `state` de OAuth — plantava a conta Google/Nuvemshop DELE na
 * organização de outra pessoa. Um segredo, dois usos, duas superfícies.
 *
 * A chave do `state` é `HMAC-SHA256(segredo, rótulo)`, e o segredo é
 * `OAUTH_STATE_SECRET` quando definido — só então o vazamento do bearer de cron
 * deixa de valer para forjar `state`. Sem ele, o segredo é o `INTERNAL_SECRET`
 * que o chamador passa, e a derivação é só SEPARAÇÃO DE DOMÍNIO: o rótulo é
 * público, então quem tem o `INTERNAL_SECRET` calcula a mesma chave. Por isso
 * o `gerar-env.sh` do Dokploy gera o segredo dedicado, e o runbook do relógio
 * usa `INTERNAL_CRON_SECRET`, nunca o `INTERNAL_SECRET`. O rótulo é versionado
 * para uma troca futura não colidir com esta.
 *
 * O rótulo não leva o nome do produto de propósito: o produto é revendido com
 * outra marca (`tests/unit/branding.test.ts`).
 *
 * Sem período de transição: todo `state` e vínculo vale 10 minutos
 * (`VALIDADE_DO_ESTADO_MS`, `VALIDADE_DO_VINCULO_S`, `TTL_MS` da Nuvemshop). O
 * efeito da troca é, no pior caso, quem estava NA tela de consentimento durante
 * a atualização refazer o clique de conectar.
 */
import { createHmac } from "node:crypto";

export const ROTULO_DA_CHAVE_DO_ESTADO_OAUTH = "crm:oauth-state:v1";

/** O segredo dedicado, quando o ambiente o define (vazio conta como ausente). */
export function segredoDedicadoDoEstadoOAuth(): string {
  return (process.env.OAUTH_STATE_SECRET ?? "").trim();
}

export function chaveDoEstadoOAuth(segredoMestre: string): Buffer {
  const segredo = segredoDedicadoDoEstadoOAuth() || segredoMestre;
  return createHmac("sha256", segredo).update(ROTULO_DA_CHAVE_DO_ESTADO_OAUTH, "utf8").digest();
}
