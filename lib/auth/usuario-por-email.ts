/**
 * Achar o usuário do GoTrue pelo e-mail, com a service key.
 *
 * O `auth.admin.listUsers()` do supabase-js não filtra por e-mail — só pagina.
 * O código de recuperação buscava na PRIMEIRA página de 200 e parava: numa
 * instalação com mais usuários, quem estivesse além do 200º nunca conseguia
 * usar o próprio código (P9). Não há, no produto, uma leitura de
 * `auth.users` por e-mail que não seja esta API: criar uma RPC `security
 * definer` para isso seria mudança de schema (tripla de migration) para um
 * fluxo raro. Por isso aqui se pagina até achar, com um teto.
 *
 * Teto: 20 páginas de 1000 = 20.000 contas, muito acima de uma instalação
 * self-host. Chegar ao teto sem achar é tratado como "não achou" (o chamador
 * responde o erro genérico de sempre) — nunca como erro que revele algo.
 *
 * Comparação por e-mail normalizado (trim + minúsculas), igual ao chamador.
 */
import type { User } from "@supabase/supabase-js";

export const POR_PAGINA = 1000;
export const MAX_PAGINAS = 20;

interface ClienteAdmin {
  auth: {
    admin: {
      listUsers(params: { page: number; perPage: number }): Promise<{
        data: { users: User[] } | { users: [] };
        error: unknown;
      }>;
    };
  };
}

export type BuscaPorEmail = { ok: true; user: User | null } | { ok: false };

export async function usuarioPorEmail(admin: ClienteAdmin, email: string): Promise<BuscaPorEmail> {
  const alvo = email.trim().toLowerCase();
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: POR_PAGINA });
    if (error) return { ok: false };
    const usuarios = (data?.users ?? []) as User[];
    const achado = usuarios.find((u) => u.email?.trim().toLowerCase() === alvo);
    if (achado) return { ok: true, user: achado };
    if (usuarios.length < POR_PAGINA) break;
  }
  return { ok: true, user: null };
}
