/**
 * Chave DEDICADA para assinar o `state` (e o vínculo) dos fluxos OAuth.
 *
 * Auditoria P7 (`docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`): o
 * `INTERNAL_SECRET` também é o bearer dos crons, e o runbook do relógio HTTP
 * mandava cadastrá-lo num serviço de terceiros. Quem visse aquele bearer
 * forjava `state` de OAuth — plantava a conta Google/Nuvemshop DELE na
 * organização de outra pessoa. Um segredo, dois usos, duas superfícies.
 *
 * Separação de domínio: a chave do `state` é `HMAC-SHA256(INTERNAL_SECRET,
 * rótulo)`. Conhecer a chave derivada não revela o segredo (HMAC não inverte),
 * e o segredo, usado como bearer, não é mais a chave de assinatura. O rótulo
 * é versionado para uma troca futura não colidir com esta.
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

export function chaveDoEstadoOAuth(segredoMestre: string): Buffer {
  return createHmac("sha256", segredoMestre).update(ROTULO_DA_CHAVE_DO_ESTADO_OAUTH, "utf8").digest();
}
