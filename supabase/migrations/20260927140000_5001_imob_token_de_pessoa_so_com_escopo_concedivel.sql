-- ═══════════════════════════════════════════════════════════════════════════
-- 5001 (fork imob) — Token gravado por PESSOA só leva escopo concedível.
--
-- Achado R7 da revisão do endurecimento (a parte de banco do A4 de
-- `docs/imobiliario/04-auditoria-seguranca-e-qualidade.md`).
--
-- ─── O defeito ────────────────────────────────────────────────────────────
--
-- A rota `POST /api/v1/settings/api-tokens` fechou a lista de escopos
-- (`ESCOPOS_DE_TOKEN_CONCEDIVEIS`, `lib/schemas/team.ts`), recusa o nome
-- reservado `agent-run:` e não deixa o token passar o papel de quem o cria
-- (`papelDoTokenCabeNoCriador`). Mas a policy `api_tokens_admin_only` deixa o
-- administrador da organização INSERIR direto pela REST (PostgREST, com o JWT
-- da sessão e a anon key que está no navegador), e ali nada disso vale: dava
-- para gravar `actor:ai_agent` + `agent_run:<id>` e se passar pelo agente
-- publicado (audit, FK de atividade, gate de canal), `role:ai_operator`, ou um
-- nome `agent-run:` que a listagem esconde dos outros administradores. A regra
-- morava só na rota; quem desse a volta na rota levava o token.
--
-- ─── O conserto ───────────────────────────────────────────────────────────
--
-- Gatilho BEFORE INSERT OR UPDATE em `api_tokens` que, quando há ator humano
-- (`auth.uid()` não nulo — JWT de sessão), recusa com SQLSTATE PT403:
--   * escopo que não é texto, ou fora da lista FECHADA (espelho literal de
--     `ESCOPOS_DE_TOKEN_CONCEDIVEIS`; o prefixo `actor:`/`agent_run:` cai
--     aqui também e é nomeado na mensagem);
--   * nome começando por `agent-run:` (sem diferenciar caixa e espaço à
--     esquerda, como o Zod da rota);
--   * `role:X` acima do papel de quem grava NAQUELA organização
--     (`fn_user_role_in_org`, que já inclui o papel do suporte temporário);
--     o administrador da plataforma sem vínculo passa, como na policy.
-- No INSERT, `created_by` tem de ser o próprio `auth.uid()`. No UPDATE, pessoa
-- só REVOGA (`revoked_at`/`revoked_by` = ela, `updated_at`): todas as outras
-- colunas ficam congeladas — trocar `token_hash` de um token do agente ou de
-- integração era tomar a identidade dele — e token revogado não volta.
-- Revogar um `integration:*` ou um efêmero pela tela continua possível.
--
-- Sem JWT (`auth.uid()` nulo) nada muda: o mint efêmero do agente
-- (`lib/ai/runtime/mcp_token.ts`), o provisionamento (`lib/tenants/api-key.ts`)
-- e os seeds gravam pelo service role, e são eles os donos desses prefixos.
--
-- O nome do gatilho começa por `trg_v…` de propósito: gatilhos de mesma
-- ocasião disparam em ordem alfabética, e este fica DEPOIS do
-- `trg_teto_de_tokens_ativos` (0415/5000) — o teto continua respondendo PT409
-- primeiro, como a rota e os invariantes esperam.
--
-- Função SECURITY INVOKER: tudo o que ela consulta (`auth.uid`,
-- `fn_user_role_in_org`, `fn_is_platform_admin`) já é executável por
-- `authenticated`; não há por que elevar. `search_path` vazio e nomes
-- qualificados. Execução revogada de `public` e `anon` (as duas origens da
-- doutrina) e de `authenticated` — função de gatilho não é RPC.
--
-- A lista SQL e a TS são comparadas por
-- `tests/unit/escopos-de-token-banco-x-typescript.test.ts`; o comportamento,
-- por `tests/invariants/token-de-pessoa-so-com-escopo-concedivel.test.ts`.
-- Idempotente (create or replace + drop trigger if exists).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_token_de_pessoa_so_com_escopo_concedivel()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Espelho literal de ESCOPOS_DE_TOKEN_CONCEDIVEIS (lib/schemas/team.ts).
  v_escopos_concediveis constant text[] := array[
    'mcp:read',
    'mcp:write',
    'role:viewer',
    'role:agent',
    'role:manager',
    'role:admin',
    'contacts:read',
    'contacts:write',
    'leads:read',
    'leads:write',
    'messages:read',
    'messages:write',
    'messages:on_behalf',
    'audit:read'
  ];
  v_escopo     jsonb;
  v_texto      text;
  v_rank_quem  integer;
  v_rank_token integer;
begin
  -- Sem ator humano: service role (mint efêmero, provisionamento, seeds).
  if auth.uid() is null then
    return new;
  end if;

  -- INSERT: a autoria é de quem grava. Sem isto a linha nasce em nome de
  -- outro membro (e herda o papel dele na conferência de `resolveApiToken`).
  if tg_op = 'INSERT' and new.created_by is distinct from auth.uid() then
    raise exception 'O token precisa ser criado em nome de quem o grava.'
      using errcode = 'PT403';
  end if;

  -- UPDATE por pessoa só REVOGA. Qualquer outra coluna fica congelada: trocar
  -- `token_hash` de um token do agente (`agent-run:`) ou de integração
  -- (`integration:`) seria tomar a identidade dele com um segredo novo, e
  -- limpar `revoked_at`/`expires_at` ressuscitaria um token morto. O uso
  -- (`last_used_at`/`last_used_ip`) é gravado pelo service role, que não
  -- passa por aqui; `updated_at` acompanha a revogação.
  if tg_op = 'UPDATE' then
    if new.id              is distinct from old.id
       or new.organization_id is distinct from old.organization_id
       or new.created_by   is distinct from old.created_by
       or new.name         is distinct from old.name
       or new.prefix       is distinct from old.prefix
       or new.token_hash   is distinct from old.token_hash
       or new.scopes       is distinct from old.scopes
       or new.expires_at   is distinct from old.expires_at
       or new.created_at   is distinct from old.created_at
       or new.last_used_at is distinct from old.last_used_at
       or new.last_used_ip is distinct from old.last_used_ip then
      raise exception 'Um token só pode ser revogado; para mudar qualquer outra coisa, crie um novo.'
        using errcode = 'PT403';
    end if;
    if old.revoked_at is not null
       and (new.revoked_at is distinct from old.revoked_at
            or new.revoked_by is distinct from old.revoked_by) then
      raise exception 'Token revogado não volta a valer.'
        using errcode = 'PT403';
    end if;
    if new.revoked_at is not null and new.revoked_by is distinct from auth.uid()
       and old.revoked_at is null then
      raise exception 'A revogação é registrada em nome de quem revoga.'
        using errcode = 'PT403';
    end if;
    return new;
  end if;

  if coalesce(new.name, '') ~* '^\s*agent-run:' then
    raise exception 'O nome "%" é reservado para uso interno. Escolha outro.', new.name
      using errcode = 'PT403';
  end if;

  if pg_catalog.jsonb_typeof(new.scopes) is distinct from 'array' then
    raise exception 'Os escopos do token precisam ser uma lista.'
      using errcode = 'PT403';
  end if;

  v_rank_quem := case public.fn_user_role_in_org(new.organization_id)
    when 'viewer'  then 1
    when 'agent'   then 2
    when 'manager' then 3
    when 'admin'   then 4
    else 0
  end;

  for v_escopo in select e from pg_catalog.jsonb_array_elements(new.scopes) as t(e) loop
    if pg_catalog.jsonb_typeof(v_escopo) is distinct from 'string' then
      raise exception 'Escopo de token inválido: %.', v_escopo
        using errcode = 'PT403';
    end if;
    v_texto := v_escopo #>> '{}';

    if v_texto like 'actor:%' or v_texto like 'agent_run:%' then
      raise exception 'O escopo "%" é do servidor e não pode ser concedido a um token de pessoa.', v_texto
        using errcode = 'PT403';
    end if;

    if not (v_texto = any (v_escopos_concediveis)) then
      raise exception 'Escopo de token não concedível: "%".', v_texto
        using errcode = 'PT403';
    end if;

    if v_texto like 'role:%' then
      v_rank_token := case pg_catalog.substr(v_texto, 6)
        when 'viewer'  then 1
        when 'agent'   then 2
        when 'manager' then 3
        when 'admin'   then 4
      end;
      if v_rank_token > v_rank_quem and not public.fn_is_platform_admin() then
        raise exception 'O papel do token não pode ser maior que o seu.'
          using errcode = 'PT403';
      end if;
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.fn_token_de_pessoa_so_com_escopo_concedivel() from public, anon, authenticated;

drop trigger if exists trg_valida_token_de_pessoa on public.api_tokens;
create trigger trg_valida_token_de_pessoa
  before insert or update on public.api_tokens
  for each row execute function public.fn_token_de_pessoa_so_com_escopo_concedivel();

comment on function public.fn_token_de_pessoa_so_com_escopo_concedivel() is
  'Gatilho de api_tokens (migration 5001, fork imob, achado R7/A4): com ator humano (auth.uid() não nulo) recusa com PT403 escopo fora da lista concedível (espelho de ESCOPOS_DE_TOKEN_CONCEDIVEIS), prefixos actor:/agent_run:, nome agent-run:, role: acima do papel de quem grava e created_by alheio; no UPDATE só permite revogar. Service role passa.';
