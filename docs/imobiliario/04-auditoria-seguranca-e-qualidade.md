---
type: audit
project: ImobCRM (fork re9 do DeskcommCRM)
status: plano aprovado para implementação
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
| D3 | 🟠 | Na rede compartilhada `dokploy-network`, o nome de outro contêiner (`db`, `auth`, `rest`, `meta`…) vence o nosso, e o app ou o gateway podem mandar senha e tráfego para outro sistema. Além disso, qualquer contêiner dessa rede alcança o webhook global do WAHA | Aliases únicos (`imobcrm-*`) para todo serviço interno, usados em todas as URLs. O `cds.yaml` do Envoy é reescrito na partida para os aliases únicos (o arquivo vendorizado fica intacto). `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true` |
| D4 | 🟡 | A lista de variáveis do CRM é fechada: VAPID, Resend, Google Calendar, SUPPORT_EMAIL, LGPD_DPO_EMAIL etc. nunca chegam ao app | Todas as variáveis opcionais de `lib/env.ts` entram na lista com `${VAR:-}`. Um teste confere a lista contra `lib/env.ts` |
| D5 | 🟡 | O SMTP e o modo de cadastro do Auth não acompanham as telas `/admin/email` e `/admin/cadastro` | Runbook: no Dokploy, SMTP e cadastro são configurados no Environment (com redeploy), e a tela explica o motivo |
| D6 | 🟡 | Só 3 de 14 serviços têm limite de memória, e o Postgres roda sem ajuste: risco de o sistema matar o banco numa VPS de 8 GB | `mem_limit` em todos. Postgres com `shared_buffers=512MB` e `effective_cache_size=2GB`. Redis com `maxmemory 128mb`. imgproxy com `IMGPROXY_CONCURRENCY=2` |
| D7 | 🟡 | Não há backup dos arquivos nem das sessões do WhatsApp, nem procedimento de restauração | `infra/dokploy/backup.sh`: dump do banco + `tar` dos volumes `storage-data` e `waha-data`, com conferência. Restauração documentada |
| D8 | 🔵 | O PostgREST expõe o schema `storage`, e o CRM não usa | `PGRST_DB_SCHEMAS=public,graphql_public`, igual ao oficial |
| D9 | 🔵 | `DB_ENC_KEY` do Realtime é fixo (`supabaserealtime`) | Gerado aleatório pelo `gerar-env.sh` |
| D10 | 🔵 | O JSON do dono é montado sem escape, e `OWNER_PASSWORD` fica obrigatório para sempre | JSON montado com escape. Senha só exigida quando o dono ainda não existe |
| D11 | 🔵 | `postgres:17-alpine` é tag móvel | Versão fixa |
| D12 | ⚪ | App e worker falam com o Supabase pelo domínio público | Sem ação: é o mesmo desenho do kit. Registrado no runbook |

### 2.2 API e mídia

| ID | Sev. | Achado | Ajuste |
|---|---|---|---|
| P1 | 🔴 | `media_url` vinda do cliente vira um **proxy autenticado para a API do WAHA**, que é compartilhado por todas as organizações: um atendente lê sessões e conversas de outra empresa. No Zernio, a mesma URL vaza a chave da organização | O envio **não aceita** `media_url` do cliente (só `media_storage_path`, validado). `fetchWahaMedia` só busca caminhos de arquivo do WAHA (`/api/files/…`). O fallback do `GET /media` vale só para mensagem recebida |
| P2 | 🟡 | Travessia de caminho em `media_storage_path` (`org/conv/../../outraOrg/…`) | Validação estrita: sem `..`, `//`, `\` ou `%`, e com prefixo conferido depois de normalizar |
| P3 | 🟠 | Mídia recebida é servida na **origem do app** com o `Content-Type` do remetente: um `.html` enviado pelo WhatsApp executa script no CRM | Lista fechada de tipos exibidos no navegador (imagem raster, áudio, vídeo, pdf). O resto sai como `attachment`, e toda resposta leva `Content-Security-Policy: sandbox` e `nosniff` |
| P4 | 🟡 | O `base_url` de provedor de IA (openrouter, deepseek, requesty e embeddings) não passa pela régua anti-SSRF | Validação de destino no POST/PATCH e `fetch` com guarda anti-SSRF em todo cliente que recebe `base_url` de configuração |
| P5 | 🟡 | O webhook global do WAHA fica exposto na topologia NPM | Resolvido pelo A2 (assinatura obrigatória quando a sessão tem segredo) |
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
| A1 | 🟠 | **Um cliente no WhatsApp pode pedir ao agente dados de outros clientes:** busca e leitura de contato, lead e compromisso não se restringem ao contato da conversa | Com ator `ai_agent` e contato no turno, as ferramentas de contato, lead e agenda só enxergam e alteram **esse** contato. O resto é recusado com mensagem para o modelo |
| A2 | 🟡 | O webhook do WAHA aceita evento **sem assinatura** mesmo quando a sessão tem segredo | Com segredo de 16+ caracteres, a assinatura é obrigatória |
| A3 | 🟠 | **Cadastrar contato com CPF falha:** a função `encrypt_cpf` nunca existiu, e o CHECK `contacts_cpf_consistency` recusa `cpf_hash` sem `cpf_encrypted`. Além disso, o hash é SHA-256 sem chave (reversível em minutos) | Cifragem AES-256-GCM no servidor com `CPF_ENCRYPTION_KEY` e hash **HMAC-SHA256** com chave derivada. A leitura (decifrar) usa a mesma biblioteca |
| A4 | 🟡 | Token de API continua valendo depois que quem o criou sai da organização; os escopos são texto livre (dá para forjar `actor:ai_agent`) | Escopos validados por lista fechada. A resolução confere que o criador ainda é membro com papel suficiente |
| A5 | 🟡 | Cada turno do agente grava um token efêmero que nunca é apagado, conta no teto de 50 dos humanos e enche a tela de tokens | Efêmeros fora do teto e da listagem, com poda diária no cron de retenção |
| A6 | 🟡 | Chamadas ao modelo sem timeout: um provedor travado prende a fila e pode repetir o turno | `AbortSignal.timeout` configurável (`LLM_CALL_TIMEOUT_MS`, padrão 90 s) em toda chamada |
| A7 | 🟡 | O dreno do `event_log` pode processar o mesmo evento duas vezes quando um handler passa de 10 min | `claim_token` no claim, exigido nas gravações finais, e `limit` na recuperação de presos |
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

Atualizado na entrega: ver a seção 5.

## 5. Resultado
