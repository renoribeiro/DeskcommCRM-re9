/**
 * A SESSÃO PRECISA PROVAR O SEGUNDO FATOR? — a regra pura, sem rede.
 *
 * É a pergunta "PROVAR" da doutrina de MFA (CLAUDE.md, "CADASTRAR e PROVAR são
 * perguntas diferentes"): quem TEM fator verificado prova na sessão, sempre,
 * independentemente da política de cadastro. A mesma resposta de `mfaEmDivida`
 * (`lib/auth/server.ts`), só que calculada a partir de dados que quem chama JÁ
 * tem — porque o `proxy.ts` roda em toda requisição e não pode pagar uma ida a
 * mais ao GoTrue para perguntar o que o `getUser()` acabou de responder.
 *
 * ⚠️ DE ONDE VEM CADA METADE, e por que não é `nextLevel`:
 *
 *  - **Tem fator?** Vem do `user.factors` devolvido por `getUser()`, que é a
 *    resposta do GoTrue para o JWT validado no servidor. O `nextLevel` de
 *    `mfa.getAuthenticatorAssuranceLevel()` (sem argumento) é calculado de
 *    `session.user.factors` — o objeto GRAVADO NO COOKIE. O cookie é do
 *    usuário: quem tem só a senha apaga os fatores dessa cópia e o `nextLevel`
 *    cai para `aal1`. Decidir por ele reabriria a porta que este gate fecha.
 *  - **Provou nesta sessão?** Vem do claim `aal` do access token — assinado
 *    pelo GoTrue e o mesmo token que o `getUser()` acabou de validar. Esse é
 *    confiável, e é o que `currentLevel` lê, sem rede.
 *
 * Falha FECHADA: nível desconhecido (`null`, leitura com erro) com fator
 * cadastrado é tratado como "não provou".
 */

export interface FatorDoUsuario {
  status?: string | null;
  factor_type?: string | null;
}

export interface UsuarioComFatores {
  factors?: FatorDoUsuario[] | null;
}

/**
 * O usuário tem ao menos um fator TOTP VERIFICADO?
 *
 * Só TOTP, e é de propósito: é o único fator que o produto cadastra e o único
 * que a tela `/login/mfa` sabe desafiar (`listFactors().totp`, a mesma régua de
 * `isMfaEnrolled`). Contar um fator de outro tipo mandaria a pessoa para uma
 * tela que a devolve para `/app` — e o proxy a mandaria de volta, num laço.
 * `factor_type` ausente conta como TOTP.
 */
export function temFatorVerificado(user: UsuarioComFatores | null | undefined): boolean {
  return !!user?.factors?.some(
    (f) => f?.status === "verified" && (f.factor_type ?? "totp") === "totp",
  );
}

/**
 * `true` = a sessão está em dívida: há fator verificado e o nível atual não é
 * `aal2`.
 */
export function sessaoDeveProvarSegundoFator(
  user: UsuarioComFatores | null | undefined,
  nivelAtual: string | null | undefined,
): boolean {
  if (!temFatorVerificado(user)) return false;
  return nivelAtual !== "aal2";
}

/** Mensagem única para o 403 `mfa_required` que o proxy e as rotas devolvem. */
export const MENSAGEM_MFA_REQUIRED = "Confirme a verificação em duas etapas para continuar.";
