---
type: audit
project: ImobCRM (fork re9 do DeskcommCRM)
status: implementado e revisado
last_updated: 2026-09-27
audited_against: main @ 10e7a2f
---

# Auditoria de segurança, correção e eficiência

> **Retrato de `main @ 10e7a2f` (27/09/2026).** Cada achado traz a evidência que o sustenta e o
> ajuste que o resolve. A coluna **Estado** é atualizada à medida que os ajustes entram.

## 1. Método

Seis frentes independentes, cada uma só relatando o que **verificou**:

| Frente | Como foi medido |
|---|---|
| Instalação pelo Dokploy | Docker local com o Postgres do Supabase, Envoy e Traefik v3 reais numa rede `dokploy-network` falsa. `.env` gerado pelo `gerar-env.sh`, baseline aplicado, rotas medidas com `curl` |
| API HTTP (375 rotas) | Varredura por script de todas as rotas e server actions, e leitura ponta a ponta dos caminhos suspeitos |
| Banco e RLS | Suíte de invariantes completa (295 arquivos, 2.446 casos) num Postgres 16 real. Consultas ao catálogo e reprodução de ataques em SQL com o JWT de cada papel |
| Web e frontend | Cabeçalhos, XSS, vazamento para o bundle (fecho de imports dos 643 módulos `"use client"`), fluxos de login/MFA e uploads |
| IA, MCP e processos em segundo plano | Varredura de toda chamada ao banco em `lib/mcp`, `lib/agent-engine` e `workers`. Autenticação, cripto, filas e timeouts |
| Gates de qualidade | `typecheck`, `lint`, `lint:channels`, `cercas`, `test:unit` (15.176 casos), `build` e `pnpm audit` |

**O que já estava bom:**

- 0 vulnerabilidades nas dependências de produção;
- typecheck e build limpos;
- RLS ligada em 175 de 175 tabelas;
- nenhuma função `security definer` exposta a `anon`;
- todas as 33 rotas de cron autenticadas em tempo constante e fechadas quando falta o segredo;
- webhooks com HMAC em tempo constante;
- cookie de sessão `HttpOnly` + `SameSite=Strict`;
- nenhum segredo alcançável pelo bundle do navegador;
- nenhuma organização lida do corpo da requisição.

## 2. Achados e plano de ajuste

Severidade: 🔴 crítico · 🟠 alto · 🟡 médio · 🔵 baixo · ⚪ informativo.

### 2.1 Instalação pelo Dokploy

| ID | Sev. | Achado | Ajuste |
|---|---|---|---|
| D1 | 🔴 | `IMAGE_TAG` tem padrão `stable`, que não existe no GHCR do fork: o primeiro deploy falha no `pull` | `gerar-env.sh` passa a **exigir** `--versao`. O compose recusa `IMAGE_TAG` vazio (`${IMAGE_TAG:?…}`). O runbook explica como ver as versões publicadas |
| D2 | 🟠 | O `setup` não espera o `storage` criar o schema dele. Num banco novo, o baseline falha em `storage.buckets`; num redeploy, os buckets e as policies somem em silêncio | `setup` depende de `storage` e `rest` saudáveis. No modo atualização, erro que cite `storage.` reprova o `setup` |
| D3 | 🟠 | Na rede compartilhada `dokploy-network`, o nome de outro contêiner (`db`, `auth`, `rest`, `meta`…) vence o nosso, e o app ou o gateway podem mandar senha e tráfego para outro sistema. Além disso, qualquer contêiner dessa rede alcança o webhook global do WAHA | Aliases únicos (`imobcrm-*`) para todo serviço interno, usados em todas as URLs. O `cds.yaml` do Envoy é reescrito na partida para os aliases únicos (o arquivo vendorizado fica intacto). O webhook global do WAHA é negado pelo Traefik; a exigência de assinatura fica **desligada por padrão** (`WAHA_WEBHOOK_REQUIRE_SIGNATURE=false`) porque o WAHA Core não assina — ver A2 |
| D4 | 🟡 | A lista de variáveis do CRM é fechada: VAPID, Resend, Google Calendar, SUPPORT_EMAIL, LGPD_DPO_EMAIL etc. nunca chegam ao app | Todas as variáveis opcionais de `lib/env.ts` entram na lista com `${VAR:-}`. Um teste confere a lista contra `lib/env.ts` |
| D5 | 🟡 | O SMTP e o modo de cadastro do Auth não acompanham as telas `/admin/email` e `/admin/cadastro` | Runbook: no Dokploy, SMTP e cadastro são configurados no Environment (com redeploy), e a tela explica o motivo |
| D6 | 🟡 | Só 3 de 14 serviços têm limite de memória, e o Postgres roda sem ajuste: risco de o sistema matar o banco numa VPS de 8 GB | `mem_limit` em todos. Postgres com `shared_buffers=512MB` e `effective_cache_size=2GB`. Redis com `maxmemory 128mb`. imgproxy com `IMGPROXY_CONCURRENCY=2` |
| D7 | 🟡 | Não há backup dos arquivos nem das sessões do WhatsApp, nem procedimento de restauração | `infra/dokploy/backup.sh`: dump do banco + `tar` dos volumes `storage-data` e `waha-data`, com conferência. Restauração documentada |
| D8 | 🔵 | O PostgREST expõe o schema `storage`, e o CRM não usa | `PGRST_DB_SCHEMAS=public,graphql_public`, igual ao oficial |
| D9 | 🔵 | `DB_ENC_KEY` do Realtime é fixo (`supabaserealtime`) | Gerado aleatório pelo `gerar-env.sh` |
| D10 | 🔵 | O JSON do dono é montado sem escape, e `OWNER_PASSWORD` fica obrigatório para sempre | JSON montado com escape. Senha só exigida quando o dono ainda não existe |
| D11 | 🔵 | `postgres:17-alpine` e `redis:7-alpine` são tags móveis | Versões fixas: `postgres:17.6-alpine3.22` e `redis:7.4.11-alpine3.21` |
| D12 | ⚪ | App e worker falam com o Supabase pelo domínio público | Sem ação: é o mesmo desenho do kit. Registrado no runbook |

### 2.2 API e mídia

| ID | Sev. | Achado | Ajuste |
|---|---|---|---|
| P1 | 🔴 | `media_url` vinda do cliente vira um **proxy autenticado para a API do WAHA**, que é compartilhado por todas as organizações: um atendente lê sessões e conversas de outra empresa. No Zernio, a mesma URL vaza a chave da organização | O envio **não aceita** `media_url` do cliente (só `media_storage_path`, validado). `fetchWahaMedia` só busca caminhos de arquivo do WAHA (`/api/files/…`). O fallback do `GET /media` vale só para mensagem recebida |
| P2 | 🟡 | Travessia de caminho em `media_storage_path` (`org/conv/../../outraOrg/…`) | Validação estrita: sem `..`, `//`, `\` ou `%`, e com prefixo conferido depois de normalizar |
| P3 | 🟠 | Mídia recebida é servida na **origem do app** com o `Content-Type` do remetente: um `.html` enviado pelo WhatsApp executa script no CRM | Lista fechada de tipos exibidos no navegador (imagem raster, áudio, vídeo, pdf). O resto sai como `attachment`, e toda resposta leva `Content-Security-Policy: sandbox` e `nosniff` |
| P4 | 🟡 | O `base_url` de provedor de IA (openrouter, deepseek, requesty e embeddings) não passa pela régua anti-SSRF | Validação de destino no POST/PATCH e `fetch` com guarda anti-SSRF em todo cliente que recebe `base_url` de configuração |
| P5 | 🟡 | O webhook global do WAHA fica exposto na topologia NPM | **Risco aceito** junto com o A2: a rota é negada pelo proxy público e o caminho de arquivo do WAHA exige a sessão; quem usa WAHA Plus liga `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true` |
| P6 | 🟡 | O limite de tentativas de TOTP fica num cookie que o próprio usuário apaga | Limite por usuário no Redis (`authRateLimited`) |
| P7 | 🟡 | `INTERNAL_SECRET` também assina o `state` dos OAuth e é o segredo que o runbook do relógio manda cadastrar num serviço de terceiros | Chave do `state` derivada por HMAC com rótulo próprio (separação de domínio). O runbook passa a usar `INTERNAL_CRON_SECRET` |
| P8 | 🔵 | O webhook de captação aceita evento quando o segredo configurado não decifra | Resposta 503, sem aceitar |
| P9 | 🔵 | Código de recuperação sem limite de tentativas, e busca só nos 200 primeiros usuários | Limite por e-mail e busca direta pelo e-mail |
| P10 | 🔵 | Comparação de segredo feita à mão em `/api/internal/agents/run`; dois PATCH sem Zod | `timingSafeStringEqual` e schemas Zod |

### 2.3 Login, MFA e web

| ID | Sev. | Achado | Ajuste |
|---|---|---|---|
| W1 | 🟠 | **MFA contornável com a senha:** quem tem a senha e para no passo do código já navega em `/app` e obtém o JWT | O `proxy.ts` confere o nível de garantia (`aal`): com fator cadastrado e sessão `aal1`, a tela vai para `/login/mfa` e a API responde 403 `mfa_required` |
| W2 | 🟠 | 19 rotas de administração da plataforma aceitam sessão sem o segundo fator de quem tem TOTP | `requirePlatformAdmin` exige `aal2` sempre que o admin tiver fator cadastrado |
| W4 | 🟡 | Sem HSTS nem CSP | HSTS quando o domínio é https. CSP sem quebrar o Next: `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`, `form-action 'self'` |
| W5 | 🟡 | `realtime-token` entrega o JWT a qualquer sessão, inclusive sem o segundo fator | Exige `aal2` quando há fator, com limite de requisições e `Cache-Control: no-store` |
| W6 | 🟡 | O `X-Request-Id` do proxy não chega aos handlers, e o que o cliente manda é aceito sem validação | Id validado (UUID ou `[\w-]{1,64}`) e gravado nos cabeçalhos **antes** de criar a resposta |
| W7 | 🔵 | O upload de saída confia em `file.type` e aceita SVG | Tipo farejado pelos bytes, com SVG e HTML recusados |
| W9 | 🔵 | O `redirectTo` do reset e do cadastro vem do cabeçalho `Origin` | Sempre `NEXT_PUBLIC_APP_URL` |
| W10 | 🔵 | O túnel do Sentry (`/monitoring`) exige sessão, e os erros do login se perdem | Caminho público |
| W11 | 🔵 | `LoginForm` usa `next` sem sanitizar (ramo hoje inalcançável) | `safeNext` |

### 2.4 IA, MCP e processos em segundo plano

| ID | Sev. | Achado | Ajuste |
|---|---|---|---|
| A1 | 🟠 | **Um cliente no WhatsApp pode pedir ao agente dados de outros clientes:** busca e leitura de contato, lead e compromisso não se restringem ao contato da conversa | Com ator `ai_agent` e contato no turno, as ferramentas de contato, lead e agenda só enxergam e alteram **esse** contato. O resto é recusado com mensagem para o modelo. Listagens (contatos, negócios, casos) recebem o contato como filtro no servidor, sem paginação; gravar memória da empresa fica fora do atendimento |
| A2 | 🟡 | O webhook do WAHA aceita evento **sem assinatura** mesmo quando a sessão tem segredo | **Descartado na implementação — risco aceito.** O WAHA Core não assina webhooks e as sessões por QR nascem com segredo provisório: exigir assinatura derrubaria o recebimento de toda instalação Core. Ficou: assinatura **errada** é sempre recusada; a exigência vale para a instalação inteira quando `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true` (WAHA Plus). As três pontas estão travadas em `lib/waha/webhook-auth.test.ts` |
| A3 | 🟠 | **Cadastrar contato com CPF falha:** a função `encrypt_cpf` nunca existiu, e o CHECK `contacts_cpf_consistency` recusa `cpf_hash` sem `cpf_encrypted`. Além disso, o hash é SHA-256 sem chave (reversível em minutos) | Cifragem AES-256-GCM no servidor com `CPF_ENCRYPTION_KEY` e hash **HMAC-SHA256** com chave derivada. A leitura (decifrar) usa a mesma biblioteca |
| A4 | 🟡 | Token de API continua valendo depois que quem o criou sai da organização; os escopos são texto livre (dá para forjar `actor:ai_agent`) | Escopos validados por lista fechada. A resolução confere que o criador ainda é membro com papel suficiente |
| A5 | 🟡 | Cada turno do agente grava um token efêmero que nunca é apagado, conta no teto de 50 dos humanos e enche a tela de tokens | Efêmeros fora do teto e da listagem, com poda diária no cron de retenção |
| A6 | 🟡 | Chamadas ao modelo sem timeout: um provedor travado prende a fila e pode repetir o turno | Dois tetos: `LLM_CALL_TIMEOUT_MS` (padrão 90 s) por requisição HTTP ao provedor, no `fetch` da fábrica, e `LLM_TURN_TIMEOUT_MS` (padrão 300 s, abaixo de `QUEUE_VISIBILITY_TIMEOUT_MS`) no turno inteiro; embeddings com teto também |
| A7 | 🟡 | O dreno do `event_log` pode processar o mesmo evento duas vezes quando um handler passa de 10 min | Posse pelo par (`status='processing'`, `attempts` lido no claim): o desfecho só grava se o evento ainda está com quem o pegou; o reaper só devolve à fila o claim velho que leu; `limit` na recuperação de presos |
| A9 | 🔵 | O AES-GCM não confere o tamanho da tag nem do IV ao decifrar | `authTagLength: 16` e validação de tamanhos |
| A10 | 🔵 | O MCP devolve a mensagem crua do banco ao cliente; há `console.*` fora do logger | Mensagem genérica com `request_id`, e logger estruturado |

### 2.5 Banco de dados

| ID | Sev. | Achado | Ajuste |
|---|---|---|---|
| B1 | 🟠 | **Mensagem injetada em conversa de outra organização:** `messages_select` não confere a organização da linha, e `messages_insert` não confere a da conversa (reproduzido em SQL) | Migration: as duas policies passam a exigir que conversa e mensagem sejam da mesma organização. Invariante novo prova o ataque barrado |
| B2 | 🟡 | `fn_resolve_inbound_number` pode ser chamada por qualquer usuário logado e devolve dados de outra organização; é a única `security definer` sem `search_path` | Revogar de `authenticated` e fixar o `search_path`. A varredura de `security definer` passa a medir também `authenticated` |
| B3 | 🔵 | `TRUNCATE` concedido a `anon`/`authenticated` em 55 tabelas (ignora RLS; hoje não é alcançável pela REST) | Revogar em todas as tabelas de `public` e no default ACL |
| B4 | ⚪ | 19 tabelas com RLS e sem policies (só a service role acessa) | Sem ação: é intencional. Registrado |
| B5 | 🟡 | Chaves estrangeiras sem índice nas tabelas grandes: apagar lead, etapa ou token varre `messages`, `crm_lead_activities` e `api_audit_log` | Índices nas colunas das chaves (parciais quando a coluna aceita nulo) |
| B6 | 🔵 | Tabelas que crescem com o uso sem índice iniciado por `organization_id` | Índices `(organization_id, …)` nas 4 que crescem |
| B7 | 🟡 | O STOP não alcança um follow-up em `paused_manual` (defeito já documentado por um teste `it.fails`) | `paused_manual` entra nos estados vivos. O teste deixa de ser `.fails` |

### 2.6 Gates e eficiência

| ID | Sev. | Achado | Ajuste |
|---|---|---|---|
| G1 | 🟡 | `test:unit` vermelho: `pdf-extractor.test.ts` quebra por interop CJS no `--eval` do tsx (não é defeito de produção) | Desembrulhar o `default` no script do teste |
| G2 | 🟡 | O editor de agente baixa **1 MB gzip** (`gpt-tokenizer` inteiro) só para contar tokens | Carregamento sob demanda |
| G3 | 🔵 | Um teste de cerca leva 8,7 s num limite de 15 s e fica instável sob carga | Timeout explícito |
| G4 | 🔵 | 6 diretivas `eslint-disable` sem efeito; o PDF de LGPD diz `pades_key_missing` quando o que falta é a implementação | Remover as diretivas; usar o código `pades_not_implemented` |

## 3. Revisão do relatório

Antes da implementação, cada achado 🔴 e 🟠 foi reconferido no código por quem escreve este
relatório, fora das frentes:

- **P1:** `sendMessageSchema` aceita `media_url: z.string().url()`, e `fetchWahaMedia` reaproveita o caminho e a query com a `X-Api-Key` global. Confirmado.
- **A3:** `grep encrypt_cpf supabase/baseline.sql` devolve 0. O CHECK está em `baseline.sql:1374`. Confirmado.
- **B1:** reproduzido em SQL pela frente de banco, com o JWT de dois papéis de organizações diferentes.
- **D2:** reproduzido: `ERROR: relation "storage.buckets" does not exist` num banco novo.
- **W1 e W2:** o `proxy.ts` e o `requirePlatformAdmin` não consultam `aal` para quem tem fator. Confirmado na leitura.

Nenhum achado foi descartado. Os ⚪ ficam registrados sem ação, com a justificativa.

## 4. Estado da implementação

**Todos os achados com ajuste foram implementados**, com duas exceções declaradas como risco
aceito (A2 e P5, acima). Os ⚪ (D12, B4) seguem sem ação, como planejado.

| Grupo | Estado | Onde |
|---|---|---|
| D1–D11 | ✅ | `docker-compose.dokploy.yml`, `infra/dokploy/*`, `tests/shell/dokploy-*.test.sh` |
| P1–P4, P6–P10 | ✅ | rotas de mensagem e mídia, `lib/messaging/media/*`, `lib/auth/*`, `lib/ai/*` |
| P5, A2 | ⚠️ risco aceito | `lib/waha/webhook-auth.ts` |
| W1, W2, W4–W7, W9–W11 | ✅ | `proxy.ts`, `lib/auth/garantia-da-sessao.ts`, `lib/http/cabecalhos-de-seguranca.ts` |
| A1, A3–A7, A9, A10 | ✅ | `lib/mcp/*`, `lib/contacts/cpf.ts`, `lib/event-log/drain.ts`, `lib/ai/tempo-da-chamada.ts` |
| B1–B3, B5–B7 | ✅ | migrations `5000_imob_` e `5001_imob_`, apêndice do `baseline.sql`, `lib/followup/reactivity.ts` |
| G1–G4 | ✅ | testes e lint |

As migrations saíram na faixa do fork (`NNNN` ≥ 5000, slug `imob_`), para não colidir com as do
projeto de origem.

### 4.1 Segunda rodada: revisão independente da implementação

Uma revisão independente do código já corrigido achou 13 pontos, todos tratados:

| ID | Achado | Ajuste |
|---|---|---|
| R1 | O reaper do `event_log` podia devolver à fila um evento que outro processo acabara de pegar | Só devolve o claim velho que leu (mesmo `attempts` e `updated_at`) |
| R2 | Um teto único de tempo cortava turnos longos legítimos | Dois tetos: por requisição (`LLM_CALL_TIMEOUT_MS`) e por turno (`LLM_TURN_TIMEOUT_MS`) |
| R3 | A auditoria do token efêmero apontava FK para linha que a poda apagava | Token efêmero vai só no `metadata`; FK nula; a poda volta a apagá-lo |
| R4 | P5, A2 e a parte de assinatura do D3 não foram implementados, e o relatório dizia “P5 resolvido pelo A2” | Registrados como risco aceito, com a justificativa (WAHA Core não assina) e a mitigação (§4.3) |
| R5 | O farejador de tipo recusava CSV do Excel, UTF-16 com BOM, BMP/TIFF e MOV | Aceitos pelos bytes |
| R6 | Listagens do agente filtravam o contato depois de paginar; memória da empresa gravável no atendimento | Filtro no servidor; `crm_save_org_memory` recusado no atendimento |
| R7 | Token criado por pessoa podia levar escopo reservado ao agente | Gatilho no banco (migration `5001_imob_`) |
| R8 | O token de convite usava o segredo interno cru, com recurso de desenvolvimento | Chave com rótulo próprio; sem segredo, o convite fecha. O segredo dedicado veio na 3ª rodada (T2) |
| R9 | O `setup` do Dokploy reprovava erros benignos do baseline | Só reprova o que é do `storage` |
| R10 | O setup aplicava o baseline do clone, não o da versão das imagens | Baixa o baseline da tag `v${IMAGE_TAG}` |
| R11 | O caminho de arquivo do WAHA não exigia a sessão | Exige 2 segmentos, o primeiro sendo a sessão da conversa |
| R12 | `DEPLOY_MODE` lido sem estar em `lib/env.ts`; documentação do CPF descrevia a cifra antiga | Declarado; documentação corrigida |
| R13 | Não há rotação da chave do CPF | Declarado como limitação na regra L-07 e na spec 02 |

Pontos menores da mesma revisão, também tratados: a linha do MANIFEST deixou de atribuir o B7 à
migration (foi só código); a migration `0439` foi renumerada para `5000_imob_`, para não colidir
com o projeto de origem; e o fragmento que tira `media_url` do envio segue `nada_mudou` — o campo
nunca entregou a mídia ao contato (só `media_storage_path` entrega), então nenhuma integração que
funcionava deixa de funcionar; a nota pública explica o caminho certo.

### 4.1.1 Terceira rodada: revisão independente do código integrado

| ID | Sev. | Achado | Ajuste |
|---|---|---|---|
| T1 | 🟡 | O gatilho da 5001 só conferia o UPDATE quando escopo ou nome mudavam: um admin pela REST trocava o `token_hash` de um token do agente ou de integração (tomando a identidade dele) ou reativava um token revogado; no INSERT, `created_by` podia ser de outro membro | Com ator humano, UPDATE só revoga (em nome de quem revoga; `revoked_by` só muda junto com a revogação; token revogado não volta) e INSERT exige `created_by = auth.uid()`. 6 casos novos no invariante |
| T2 | 🟡 | A chave derivada do `INTERNAL_SECRET` não protege contra quem vazou esse segredo: o rótulo é público. O comentário do código afirmava o contrário | `INVITE_TOKEN_SECRET` e `OAUTH_STATE_SECRET` dedicados (o segundo cobre Google Agenda, Google Ads e Nuvemshop), gerados pelo `gerar-env.sh`; comentários e notas públicas corrigidos |
| T3 | 🔵 | `crm_list_conversations` filtrava o contato depois de paginar | O contato vai no SQL (`recorte` do handler), com teste que prova o filtro no banco |
| T4 | 🔵 | A mídia do eco do celular (saída com `sent_via='external_device'`) ficou 404 até ser persistida | O proxy aceita também o eco, sempre pelo caminho de arquivo da sessão |
| T5 | 🔵 | Recusar `media_url` quebrava quem mandava `body` + `media_url` | O campo é aceito e descartado; só `media_url` sozinho é recusado, por falta de conteúdo |
| T6 | 🔵 | Mensagens novas sem espanhol/chinês, e três fixas em português | Traduções acrescentadas; `/win` e `realtime-token` passam pelo tradutor. O `proxy.ts` e o guarda de admin seguem em português: não conhecem o idioma de quem chama |
| T7 | 🔵 | O `/win` passou a responder 422 onde antes ignorava o corpo inválido | Registrado na nota pública |

### 4.2 Achados durante a implementação (fora do relatório original)

- **Agenda:** compromisso em andamento ia para "Passados" e oferecia "Faltou". Corrigido; o `it.fails` que documentava o defeito virou teste normal.
- **Convite com e-mail errado:** o botão "Sair" apontava para uma rota inexistente. Passou a usar a server action de saída, com teste que confere todo `action=` de formulário contra as rotas que existem.
- **PDF recebido:** o Chrome não abre PDF sob `sandbox`. Servido pela origem do app, sai como download; já persistido, abre pela URL assinada (outra origem).
- **`INVITE_TOKEN_SECRET`:** lido pelo código sem estar em `lib/env.ts`, no `.env.example` e no compose do Dokploy. Declarado nos três.

### 4.3 Riscos aceitos e limitações conhecidas

| Risco | Por que fica | Mitigação |
|---|---|---|
| Convite e `state` de OAuth numa instalação que não define os segredos dedicados (ex.: kit HostGator) | O kit do projeto de origem não os gera | Chave derivada separa os usos; o runbook do relógio usa `INTERNAL_CRON_SECRET`; o Dokploy gera os dois |
| Webhook do WAHA Core sem assinatura (A2/P5) | O Core não assina | Rota negada no proxy público; assinatura errada sempre recusada; WAHA Plus liga a exigência |
| Rascunho do agente mantém o token efêmero do turno | O rascunho é revisado por humano antes de sair | Escopo mínimo e poda diária |
| O gateway de IA da Vercel não aceita `fetch` por requisição | Limite da biblioteca | Vale o teto do turno inteiro |
| Banco externo livre para o agente (A1) | Consulta a imóveis e dados públicos, não a contatos | O filtro por contato vale para contato, lead e agenda |
| Restauração do backup não ensaiada | Exige o ambiente real | Procedimento documentado; ensaiar no primeiro deploy |
| Sem rotação da chave do CPF | Exige recifrar a base | Declarado em L-07 e na spec 02 |

## 5. Resultado

Bateria completa rodada sobre o código final (commit da 3ª rodada), com o banco de teste
reconstruído do `baseline.sql`:

| Verificação | Resultado |
|---|---|
| Invariantes de banco (Postgres 16 + pgvector; RLS, isolamento entre organizações, baseline em modo instalação e atualização) | 301 arquivos, 2.493 casos passando, 1 pulado de propósito, 0 falhas |
| `pnpm typecheck` | 0 erros |
| `pnpm test:unit` (o repositório inteiro, não só `tests/unit/`) | 1.531 arquivos, 15.479 casos, 0 falhas, 0 erros não tratados |
| `pnpm test:shell` (kit, scheduler, compose e scripts do Dokploy) | verde |
| `pnpm lint` | 0 erros (436 avisos, todos anteriores a este trabalho) |
| `pnpm lint:channels` | ok, nenhum arquivo novo de dívida |
| `pnpm build` | compilado sem erro |
| `pnpm release:conferir` | 18 fragmentos válidos: 1.56.0 + minor = **1.57.0** |
| `pnpm checar:colisao-de-migration` | sem colisão; nenhum PR aberto no fork (conferido pela API do GitHub) |

**Revisões:** três rodadas de revisão independente depois da implementação. A 2ª achou 13 pontos
(R1–R13), a 3ª achou 7 (T1–T7), todos tratados. A revisão final dos consertos da 3ª rodada
**não encontrou defeito**; a única observação menor dela (`revoked_by` gravável num token ativo)
também foi fechada, com caso próprio no invariante.

**Não medido aqui:** o `e2e` (Playwright contra Supabase local) e a instalação real pelo Dokploy,
que dependem de Docker com acesso aos registros de imagem, bloqueado neste ambiente. Os dois são
cobertos pelo CI do PR (`e2e`, `imagens-ok`) e pelo primeiro deploy em `crmimob.re9imob.com.br`.
