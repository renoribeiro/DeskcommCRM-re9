-- ═══════════════════════════════════════════════════════════════════════════
-- 5000 (fork imob, ex-0439) — Endurecimento do banco: mensagem presa à organização da conversa,
-- definer sem ator fora do alcance do usuário logado, TRUNCATE fora da REST,
-- efêmero do agente fora do teto de tokens e índices das chaves estrangeiras.
--
-- Achados B1, B2, B3, B5, B6 e a parte de banco do A5 de
-- `docs/imobiliario/04-auditoria-seguranca-e-qualidade.md` (seção 2.5).
--
-- ─── B1 — mensagem injetada em conversa de outra organização ──────────────
--
-- `messages_select` só perguntava "você enxerga a conversa apontada?" e
-- `messages_insert` só perguntava "a LINHA é da sua organização?". Um atendente
-- da organização A gravava uma mensagem com `organization_id = A` e o
-- `conversation_id` de uma conversa de B; a linha passava no INSERT (org A é
-- dele) e aparecia para quem enxerga a conversa de B (o `exists` da SELECT).
-- Reproduzido em SQL, com a sessão de um `agent`.
--
-- As duas perguntas passam a ser feitas JUNTAS nas duas pontas, como já faz o
-- `cae_select` (migration 0173): a linha é de uma organização do usuário E a
-- conversa apontada é da MESMA organização da linha. O `exists` continua sob a
-- RLS de `conversations`, então o escopo de visibilidade da conversa segue
-- herdado, não reescrito. A cláusula de administrador da plataforma fica.
-- UPDATE ganha a mesma conferência (senão um `update ... set conversation_id`
-- repetiria o ataque); DELETE não muda — apagar só alcança linha da própria
-- organização e não move nada.
--
-- ─── B2 — `fn_resolve_inbound_number` alcançável por qualquer usuário ────
--
-- A 0347 (módulo VoIP) revogou `public` e `anon`, mas o
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO authenticated` do
-- corpo do baseline também concede EXECUTE direto a `authenticated` — e a
-- função é `security definer` SEM ator: devolve organização, modo de
-- roteamento, agente e usuário de fallback de QUALQUER número discado, de
-- qualquer organização. Quem chama é o worker de voz, pelo admin client
-- (`workers/voice-agent/index.ts`). Fica só `service_role`, e o `search_path`
-- deixa de ser o do chamador (era a única definer de `public` sem ele).
--
-- `fn_colegas_podem_mexer_na_agenda(uuid)` respondia o booleano de QUALQUER
-- organização a quem estivesse logado. Passa a responder só para organização do
-- usuário (ou para chamada sem JWT — service role e o núcleo interno — e para o
-- administrador da plataforma); fora disso devolve `null`. Os dois chamadores
-- (a rota da agenda e `fn_appointment_change_core`) já perguntam pela
-- organização da sessão depois de conferir o papel, então nada muda para eles.
-- `fn_support_write_allowed(uuid)` NÃO muda: ela não lê dado de organização —
-- responde pela sessão de suporte do próprio `auth.uid()`, e fora dela devolve
-- `true` constante (é policy RESTRITIVA; ver
-- `tests/invariants/definer-membership-varredura.test.ts`).
--
-- ─── B3 — TRUNCATE concedido a anon/authenticated ─────────────────────────
--
-- O default ACL do Supabase concede `arwdDxt` aos papéis do PostgREST, e o
-- TRUNCATE ignora RLS. Hoje a REST não expõe TRUNCATE, mas o privilégio não
-- serve a caminho nenhum do produto. Revoga em todas as tabelas de `public` e no
-- default ACL (para tabela criada depois, inclusive a de módulo instalado).
--
-- ─── A5 (banco) — token efêmero do agente fora do teto ────────────────────
--
-- Cada turno do agente grava um token `agent-run:<run_id>` com validade de 5
-- minutos (`lib/ai/runtime/mcp_token.ts`). O teto de 50 da 0415 contava esses
-- tokens junto com os humanos: numa organização movimentada o agente ocupava o
-- teto dos humanos, e 50 turnos concorrentes derrubavam a emissão do 51º turno.
-- Efêmero = nome `agent-run:%` E validade de no máximo 1 hora a partir da
-- criação. Não entra na contagem; e a inserção de um efêmero sem JWT (service
-- role, que é quem minta) não é barrada pelo teto. Um usuário logado que imite
-- o formato continua passando pelo teto na inserção.
--
-- ─── B5/B6 — índices ──────────────────────────────────────────────────────
--
-- Chave estrangeira sem índice no lado que referencia faz o `on delete` da
-- linha referenciada varrer a tabela inteira: apagar um lead, uma etapa, uma
-- demanda ou um token varria `messages`, `crm_lead_activities`, `crm_leads` e
-- `api_audit_log`. Índices parciais quando a coluna aceita nulo. E as quatro
-- tabelas de histórico que crescem com o uso ganham índice iniciado por
-- `organization_id` (é por onde a RLS filtra e por onde o `on delete cascade`
-- da organização passa). Sem `concurrently`: o runner envolve a migration em
-- transação.
--
-- Idempotente e sem `begin`/`commit`. No baseline: as três policies de
-- `messages` são redefinidas no LUGAR da versão antiga (uma versão
-- intermediária diferente da final seria reinstalada a cada update); as funções
-- num bloco ANTES da varredura de anon (0116); o resto no fim do arquivo,
-- depois de toda tabela.
-- ═══════════════════════════════════════════════════════════════════════════

-- ---- B1 ----
drop policy if exists "messages_select" on public.messages;
drop policy if exists "messages_insert" on public.messages;
drop policy if exists "messages_update" on public.messages;

create policy "messages_select" on public.messages
  for select using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1 from public.conversations c
         where c.id = messages.conversation_id
           and c.organization_id = messages.organization_id
      )
    )
  );

create policy "messages_insert" on public.messages
  for insert with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1 from public.conversations c
         where c.id = messages.conversation_id
           and c.organization_id = messages.organization_id
      )
    )
  );

create policy "messages_update" on public.messages
  for update using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids()))
  ) with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1 from public.conversations c
         where c.id = messages.conversation_id
           and c.organization_id = messages.organization_id
      )
    )
  );

-- ---- B2 ----
revoke execute on function public.fn_resolve_inbound_number(text) from public, anon, authenticated;
grant  execute on function public.fn_resolve_inbound_number(text) to service_role;
alter function public.fn_resolve_inbound_number(text) set search_path = public, pg_temp;

create or replace function public.fn_colegas_podem_mexer_na_agenda(p_org uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select case
   when auth.uid() is not null
    and not public.fn_is_platform_admin()
    and not (p_org in (select public.fn_user_org_ids()))
   then null
   else coalesce(
     (select (o.settings->'colegas_podem_mexer_na_agenda') is distinct from 'false'::jsonb
        from public.organizations o where o.id = p_org),
     true)
 end;
$$;
revoke all on function public.fn_colegas_podem_mexer_na_agenda(uuid) from public, anon;
grant execute on function public.fn_colegas_podem_mexer_na_agenda(uuid) to authenticated, service_role;

-- ---- A5 (banco) ----
create or replace function public.fn_teto_de_tokens_ativos() returns trigger
    language plpgsql security definer
    set search_path = ''
as $$
declare
  v_teto   constant integer := 50;
  v_ativos integer;
begin
  -- O efêmero do turno do agente (nome `agent-run:%`, validade de até 1 hora)
  -- mintado sem JWT (service role) não disputa o teto dos humanos.
  if auth.uid() is null
     and new.name like 'agent-run:%'
     and new.expires_at is not null
     and new.expires_at <= coalesce(new.created_at, now()) + interval '1 hour' then
    return new;
  end if;

  select count(*)
    into v_ativos
    from public.api_tokens
   where organization_id = new.organization_id
     and revoked_at is null
     and (expires_at is null or expires_at > now())
     and not (name like 'agent-run:%'
              and expires_at is not null
              and expires_at <= created_at + interval '1 hour');

  if v_ativos >= v_teto then
    raise exception
      'Teto de tokens ativos por organização atingido: % de %. Revogue um token que não esteja mais em uso (Configurações → Tokens de API → Revogar) para liberar espaço — tokens revogados ou expirados não contam — e tente criar outro.',
      v_ativos, v_teto
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;
revoke execute on function public.fn_teto_de_tokens_ativos() from public, anon, authenticated;

-- ---- B3 ----
revoke truncate on all tables in schema public from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke truncate on tables from public, anon, authenticated;

-- ---- B5 ----
create index if not exists idx_messages_activity_id
  on public.messages (activity_id) where activity_id is not null;
create index if not exists idx_messages_demanda_id
  on public.messages (demanda_id) where demanda_id is not null;
create index if not exists idx_messages_sent_by_user_id
  on public.messages (sent_by_user_id) where sent_by_user_id is not null;
create index if not exists idx_crm_lead_activities_lead_id
  on public.crm_lead_activities (lead_id);
create index if not exists idx_contacts_is_merged_into
  on public.contacts (is_merged_into) where is_merged_into is not null;
create index if not exists idx_crm_leads_stage_id
  on public.crm_leads (stage_id);
create index if not exists idx_crm_leads_pipeline_id
  on public.crm_leads (pipeline_id);
create index if not exists idx_crm_leads_contact_id
  on public.crm_leads (contact_id) where contact_id is not null;
create index if not exists idx_conversations_contact_id
  on public.conversations (contact_id);
create index if not exists idx_conversations_channel_session_id
  on public.conversations (channel_session_id);
create index if not exists idx_audit_actor_api_token
  on public.api_audit_log (actor_api_token_id) where actor_api_token_id is not null;
-- As demais FKs de uma coluna das mesmas tabelas que a varredura
-- (`tests/invariants/indices-das-chaves-estrangeiras.test.ts`) achou sem índice.
-- Todas aceitam nulo e são nulas na maioria das linhas: o parcial é pequeno.
create index if not exists idx_conversations_active_ai_agent_id
  on public.conversations (active_ai_agent_id) where active_ai_agent_id is not null;
create index if not exists idx_conversations_current_demanda_id
  on public.conversations (current_demanda_id) where current_demanda_id is not null;
create index if not exists idx_conversations_snoozed_by_user_id
  on public.conversations (snoozed_by_user_id) where snoozed_by_user_id is not null;
create index if not exists idx_conversations_usable_for_rag_marked_by
  on public.conversations (usable_for_rag_marked_by) where usable_for_rag_marked_by is not null;
create index if not exists idx_crm_leads_lost_from_stage_id
  on public.crm_leads (lost_from_stage_id) where lost_from_stage_id is not null;
create index if not exists idx_crm_leads_owner_agent_id
  on public.crm_leads (owner_agent_id) where owner_agent_id is not null;

-- ---- B6 ----
create index if not exists idx_conversation_notes_org_conversation
  on public.conversation_notes (organization_id, conversation_id, created_at);
create index if not exists idx_cae_org_conversation
  on public.conversation_assignment_events (organization_id, conversation_id, created_at desc);
create index if not exists idx_followup_events_org_enrollment
  on public.followup_enrollment_events (organization_id, enrollment_id, created_at);
create index if not exists idx_agent_case_events_org_case
  on public.agent_case_events (organization_id, case_id, created_at);

notify pgrst, 'reload schema';
