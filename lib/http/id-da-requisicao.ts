/**
 * O `X-Request-Id` que o proxy aceita do cliente — ou gera.
 *
 * O id correlaciona resposta, log e auditoria (`api_audit_log.request_id`).
 * Aceitar qualquer valor do cliente punha no log o que o cliente quisesse:
 * quebra de linha, texto enorme, ou o id de OUTRA requisição para confundir a
 * correlação. Aceita-se só a forma de um identificador (UUID, ou
 * `[A-Za-z0-9_-]{1,64}`, que cobre os ids de proxies e balanceadores comuns);
 * qualquer outra coisa é descartada e um UUID novo é gerado.
 */
const FORMA_ACEITA = /^[\w-]{1,64}$/;

export function idDaRequisicao(recebido: string | null | undefined): string {
  const valor = recebido?.trim();
  if (valor && FORMA_ACEITA.test(valor)) return valor;
  return crypto.randomUUID();
}
