---
type: plan
project: ImobCRM (fork re9 do DeskcommCRM — vertical imobiliário de VENDA)
status: aprovado em direção — decisões do dono registradas na §0 (27/09/2026, duas rodadas)
last_updated: 2026-09-27
base: auditoria em 01-auditoria.md (HEAD 38dd469)
---

# Plano: ImobCRM

> **Objetivo:** transformar o DeskcommCRM no **ImobCRM**, um SaaS de **vendas imobiliárias com
> agentes de IA nativos no WhatsApp**. Ele cobre toda a jornada, do lead do portal até as chaves,
> com estoque próprio, publicação no Grupo OLX e no Imovelweb, e compliance do setor.
>
> Base: a auditoria em [`01-auditoria.md`](01-auditoria.md). Cada épico diz **o que reaproveitar**
> (arquivo real do repositório) e **o que construir**.

---

## 0. Decisões do dono do produto (27/09/2026)

| # | Decisão | Consequência no plano |
|---|---|---|
| 1 | **Só venda** (sem locação) | Sai do escopo: locação, administração, cobrança de aluguel, repasse, reajuste, garantias locatícias e Lei do Inquilinato. Os funis são **Venda**, **Lançamento** e **Captação** (lançamentos entraram na fase 1 pela decisão 11) |
| 2 | **Acompanhar o upstream** | Fork vivo: merge periódico de `melgarafael/DeskcommCRM` e código imobiliário isolado (§2) |
| 3 | **SaaS** | A RE9 opera **uma plataforma multi-imobiliária**. Entram cadastro público com teste grátis, planos e limites, cobrança da assinatura, domínio próprio da vitrine, operação 24/7 (backup, monitoramento, escala) e contrato de operador LGPD. O kit self-host deixa de ser prioridade |
| 4 | **Nome: ImobCRM** | Vem do banco (`platform_branding`), sem nome no código (`tests/unit/branding.test.ts`) |
| 5 | **Sem ERP; o ImobCRM é o sistema principal** | O **cadastro de imóveis entra na fase 1**. A ponte com ERP (`banco_externo`) e a importação de ERP deixam de ser prioridade. Fica só a importação por planilha/XML para quem troca de sistema |
| 6 | **Portais: Grupo OLX e Imovelweb** | Entrada de leads e saída de feed XML só desses dois na primeira onda |
| 7 | **Soluções open source ou sem custo** | Stack da §2.4: DocuSeal (assinatura), MapLibre + OpenFreeMap (mapa), BrasilAPI/ViaCEP/Nominatim (CEP e geocodificação), BCB SGS (índices e taxas), `@react-pdf/renderer` (PDF, já no projeto), Web Push (já no projeto), MinIO (armazenamento, se sair do Supabase) |
| 8 | **Piloto: RE9 Imob** | A imobiliária do próprio dono é a primeira organização. As conversas reais dela formam o corpus de avaliação do agente |
| 9 (A) | **Cada imobiliária usa a própria chave de IA** | Usa o que já existe (`ai_provider_credentials`, chave do cliente por organização). Os planos **não** incluem créditos de IA. O onboarding ganha um passo guiado "Conectar sua IA", com tutorial em linguagem leiga, teste da chave na hora e estimativa de custo mensal. O controle de gasto (`ai_budgets`) vem **ligado** por padrão, com teto sugerido |
| 10 (B) | **WhatsApp: API oficial da Meta como padrão, com WAHA e Evolution API v2 prontos** | A Meta Cloud e o WAHA já existem (`lib/channels/adapters/meta-cloud.ts`, `waha.ts`). Entra um **adaptador novo para a Evolution API v2** (épico E20), no mesmo contrato dos demais. A tela de conexão oferece os três, com a oficial recomendada |
| 11 (C) | **Lançamentos entram na primeira fase** | O épico E12 (empreendimento, torres, unidades, espelho de vendas, tabela de preços, reserva) sobe para a fase 1, junto com o cadastro de imóveis, porque unidade **é** imóvel e as duas coisas compartilham o modelo. Os funis passam a ser três: Venda, Lançamento e Captação |
| 12 (D) | **Uso inicial: só a RE9 Imob, numa VPS, em `crmimob.re9imob.com.br`** | A fase 1 é uma **instalação self-host de uma organização**, usando o kit que já existe (`hostgator-setup-kit/`) com as imagens do fork. A camada comercial SaaS (E19) continua no plano, mas só depois que a RE9 Imob validar o produto. Nenhuma decisão desta fase pode impedir o multi-imobiliária depois |
| 13 (E) | **Banco Inter** | A cobrança da assinatura SaaS (E19) usa a **API Pix/boleto do Inter** (OAuth + certificado mTLS da conta PJ, webhook de pagamento). Não é necessária na fase 1 |

---

## Sumário

1. [Tese do produto](#1-tese-do-produto)
2. [Arquitetura](#2-arquitetura)
3. [Modelo de domínio](#3-modelo-de-domínio)
4. [O agente de IA imobiliário](#4-o-agente-de-ia-imobiliário)
5. [Épicos](#5-épicos)
6. [Compliance e regulação](#6-compliance-e-regulação)
7. [Métricas do negócio](#7-métricas-do-negócio)
8. [Roadmap](#8-roadmap)
9. [Riscos e mitigação](#9-riscos-e-mitigação)
10. [Definição de pronto do vertical](#10-definição-de-pronto-do-vertical)
11. [Decisões ainda em aberto](#11-decisões-ainda-em-aberto)
12. [Apêndice: telas — manter, adaptar e esconder](#12-apêndice-telas--manter-adaptar-e-esconder)

---

## 1. Tese do produto

### 1.1 O problema

Imobiliárias de venda perdem negócio em cinco pontos:

1. **Lead de portal esfria em minutos.** O Grupo OLX e o Imovelweb entregam o mesmo lead para
   várias imobiliárias, e quem responde primeiro, com o imóvel certo, leva.
2. **O corretor não sabe o que oferecer.** O estoque está numa planilha ou na cabeça do captador.
3. **A carteira é do corretor, não da empresa.** Quando ele sai, os clientes saem com ele.
4. **O ciclo é longo** (30 a 180 dias) e documental: visita → proposta → contraproposta →
   documentação e financiamento → contrato → escritura → chaves.
5. **A regulação é específica:** CRECI na publicidade, COAF/PLD, LGPD sobre documentos pessoais e
   DIMOB.

### 1.2 A proposta do ImobCRM

| Pilar | Na prática |
|---|---|
| **Resposta em segundos, 24/7** | A IA responde o lead do portal na hora e qualifica (região, faixa, quartos, financiamento/FGTS). Ela **busca no estoque real**, envia fotos, vídeo e localização, e **agenda a visita** com o corretor certo |
| **Estoque no centro** | Cadastro de imóveis com fotos, mapa e códigos, publicado automaticamente no Grupo OLX e no Imovelweb e na vitrine própria |
| **Match contínuo** | Cada imóvel novo ou com preço reduzido é cruzado com todos os perfis de busca, e a IA propõe o contato (com aprovação humana) |
| **Carteira da empresa** | Todo histórico fica no CRM. A roleta de leads tem prazo de resposta, e a gestão acompanha por equipe |
| **Do lead às chaves** | Visita, proposta, documentos, contrato com assinatura eletrônica e comissão rateada |
| **Compliance embutido** | CRECI em toda saída, trilha COAF, LGPD por titular com retenção legal |

### 1.3 Personas

| Persona | Precisa de | Papel |
|---|---|---|
| **Dono/diretor** | VGV, conversão, custo por lead por portal, produtividade | `admin` |
| **Gerente de vendas** | Distribuir, cobrar prazo, ver a equipe, aprovar proposta | `manager` com escopo de equipe (novo) |
| **Corretor** | Leads do dia, agenda de visitas, imóveis para enviar, app no celular | `agent` |
| **Captador** | Proprietários, avaliações, autorizações, fotos | `agent` com papel de captação |
| **Agente de IA** | Estoque, agenda, funil e regras de promessa | `ai_operator` (já existe) |
| **Operador da plataforma (RE9)** | Clientes, planos, cobrança, saúde, suporte | `platform_admin` (já existe) |

Público-alvo: primeiro imobiliárias de usados (2 a 50 corretores) e corretores autônomos. Depois,
imobiliárias e corretores que vendem lançamentos (desde a fase 1).

---

## 2. Arquitetura

### 2.1 Fork vivo com domínio isolado

O código imobiliário mora em pastas próprias. O motor (canal, IA, agenda, governança, LGPD)
continua vindo do upstream por `git merge`, nunca rebase.

| Camada | Onde |
|---|---|
| Domínio (TS puro) | `lib/imobiliario/**`: imóveis, match, financiamento, comissão, portais, ACM |
| Telas | `app/app/imoveis/**`, `app/app/captacao/**`, `app/app/propostas/**`, `app/app/contratos/**`, `app/app/comissoes/**` |
| Componentes | `components/imobiliario/**` |
| API | `app/api/v1/imoveis/**`, `app/api/v1/portais/**`, `app/api/v1/feeds/**` |
| Vitrine pública | `app/(site)/**` |
| Ferramentas de IA | `lib/mcp/tools/imoveis.ts` + `lib/mcp/tools/catalogo/imoveis.ts` |
| Assinatura SaaS | `lib/saas/**`, `app/(admin)/**` (console da RE9) |
| Testes | `tests/unit/imobiliario/**`, `tests/invariants/imob-*.test.ts`, `tests/e2e/imob-*.spec.ts` |

**Schema.** Como o ImobCRM **é** imobiliário e roda como SaaS de uma instalação só, as tabelas
imobiliárias entram pela **tripla normal**: migration + apêndice idempotente do `baseline.sql` +
MANIFEST. A função provisionadora da ADR-0002 servia para instalações que não queriam o módulo, e
esse caso não existe aqui.

Para reduzir conflito com o upstream:

- as migrations do fork usam o **slug com prefixo `imob_`** e uma **faixa de NNNN própria**
  (a partir de 5000);
- o apêndice imobiliário fica num **bloco único e contíguo** no fim do `baseline.sql`;
- `scripts/migration-populacao.sh` e o guarda de colisão passam a medir contra o fork **e** o
  upstream.

**Ganchos genéricos** úteis a qualquer nicho vão para o núcleo e podem ser devolvidos ao upstream
por PR, o que diminui a divergência:

- roleta de **lead** com critérios e prazo de resposta com repasse;
- equipes;
- gatilho recorrente e condição numérica nas automações;
- filtro de campanha por campo personalizado;
- página pública de agendamento;
- `vocabulary` aplicado em toda a interface;
- repositório de documentos com retenção legal;
- Meta Lead Ads;
- envio de vídeo, arquivo e localização pelo agente;
- validação de tipo dos campos personalizados.

### 2.2 Arquitetura SaaS

| Tema | Decisão |
|---|---|
| **Tenancy** | Uma instalação e N imobiliárias, cada uma uma `organization`. O RLS com teste de isolamento já existe e continua obrigatório |
| **Hospedagem** | **Agora (fase 1–2):** a VPS da RE9 em `crmimob.re9imob.com.br`, instalada pelo kit (`install.sh`) com as imagens do fork, `app` + `worker` + `scheduler` atrás do proxy, Supabase gerenciado. **Depois (SaaS):** mesma arquitetura com mais capacidade, staging idêntico com dados sintéticos e Supabase Pro (backups diários, sem pausa) |
| **Domínios** | `app.<dominio-imobcrm>` para o CRM. Vitrine em `<imobiliaria>.<dominio-imobcrm>` ou **domínio próprio do cliente**, com TLS automático pelo **on-demand TLS do Caddy** (gratuito, Let's Encrypt), liberado por um endpoint `ask` que confere o domínio na tabela |
| **Cadastro** | Cadastro público com teste grátis (14 dias), sobre o fluxo que já existe (`registration_requests`, `lib/auth/registration-requests.ts`), sem aprovação manual quando o plano for self-service. O onboarding aplica o **kit imobiliário** (E1) |
| **Planos e limites** | Tabela `saas_plans` com limites (corretores, imóveis ativos, números de WhatsApp, GB de fotos, portais; a IA não entra no plano porque a chave é de cada imobiliária) e `saas_subscriptions` por organização. Os limites são aplicados no servidor, e o bloqueio por inadimplência usa a tela `app/account-suspended` (já existe) |
| **Cobrança da assinatura** | Pix e boleto emitidos pela **API do Banco Inter** (conta PJ da RE9: OAuth + certificado mTLS; conferir a tarifa atual). Webhook de baixa. A régua de cobrança pelo WhatsApp e por e-mail usa os follow-ups e campanhas existentes. A lógica de planos é código próprio e simples; não é preciso um motor de billing de terceiros no começo |
| **WhatsApp** | Três caminhos, escolhidos por número: **API oficial da Meta** (padrão; já suportada em `lib/channels/meta`, custo por conversa na conta Meta do cliente), **WAHA** (QR; já suportado; o WAHA Plus é licenciado, conferir o custo e o limite de sessões) e **Evolution API v2** (QR; open source Apache-2.0, sem licença; adaptador novo no E20). Os dois não oficiais passam pelo mesmo anti-banimento (throttle, jitter, janela, STOP) |
| **IA** | **Chave da própria imobiliária** (decisão A), cadastrada no onboarding. O controle de gasto por organização (`ai_budgets`) vem ligado com teto sugerido, e o painel de uso já existente (`/app/ai/usage`) mostra o custo |
| **Armazenamento** | Supabase Storage no começo. Quando fotos passarem de algumas centenas de GB, **MinIO** (S3 open source) ou Cloudflare R2 (sem taxa de saída). Fotos convertidas para WebP ≤ 300 KB no upload |
| **Observabilidade** | Sentry (já integrado; plano gratuito ou self-host) + uptime externo. A Central de avisos do produto é o laço de retorno para o cliente |
| **Deploy** | CI publica as imagens do fork no GHCR, deploy em staging e depois em produção. Migrations aplicadas pelo `baseline.sql` idempotente ou pela cadeia de migrations com backup antes. Rollback por imagem anterior |
| **LGPD de SaaS** | A RE9 é **operadora**, e cada imobiliária é **controladora** dos seus leads. Precisa de termos de uso, DPA (acordo de tratamento de dados), lista de suboperadores (Supabase, Meta, provedor de IA) e canal do DPO. O PDF de LGPD já nomeia o controlador e não a marca (`lib/legal/operador.ts`) |

### 2.3 Fundação do fork (épico E0)

1. Remoto `upstream` e rotina de merge a cada 1–2 semanas, sempre com a suíte completa verde antes
   de publicar.
2. Faixa de migrations (§2.1).
3. **Imagens próprias:** `publish-image.yml` já publica em `ghcr.io/${owner}`. Ajustar
   `docker-compose.prod.yml`, `hostgator-setup-kit/_common.sh:1271` e
   `tests/unit/namespace-das-imagens.test.ts`.
4. **Versão própria sem hífen** (o kit descarta prerelease com `-`): por exemplo, linha `1.x`
   própria do ImobCRM, registrando a base do upstream no CHANGELOG. `release.yml:479` só corta tag
   no repositório do upstream e precisa ser ajustado.
5. **Proteção da branch `main`** com os cinco checks obrigatórios.
6. **Marca ImobCRM** configurada no banco (nome, logo, cor, e-mail remetente).
7. **Ambientes:** a produção da fase 1 é a VPS da RE9 Imob (`crmimob.re9imob.com.br`: DNS, TLS, proxy), instalada pelo kit do fork. Um ambiente de testes local ou numa segunda VPS pequena. Backup automático (`backup.sh`, já existe) testado com restauração mensal.
8. **Depois de cada deploy**, confirmar que o domínio responde 307 (redireciona para o login) e não 404, como manda `docs/runbooks/deploy.md`.

### 2.4 Stack técnica — open source ou sem custo

| Necessidade | Escolha | Licença/custo | Observação |
|---|---|---|---|
| **Assinatura eletrônica** | **DocuSeal** self-hosted (container ao lado do app) | AGPL-3.0, gratuito self-hosted | Tem API, templates, campos, webhook de "assinado" e trilha de auditoria. Integrado por adaptador `lib/imobiliario/assinatura/` (trocável). Alguns recursos são da versão Pro; confirmar se a API e o webhook necessários estão no gratuito. **Validade jurídica:** assinatura eletrônica avançada vale para contratos particulares entre as partes que a aceitam (MP 2.200-2/2001, art. 10 §2º; Lei 14.063/2020). Escritura continua no cartório |
| **Assinatura ICP-Brasil (opcional)** | Assinador PAdES que **já existe** no projeto (`lib/lgpd/pades-signer.ts`) com certificado A1 da imobiliária | gratuito (o certificado é do cliente) | Para documentos emitidos pela imobiliária (ficha, avaliação) com validade qualificada |
| **Mapa** | **MapLibre GL JS** + tiles do **OpenFreeMap** (sem chave, sem limite declarado) ou **Protomaps/PMTiles** self-hosted | BSD / gratuito | Busca por raio e por área desenhada no mapa |
| **CEP → endereço** | **BrasilAPI** (CEP v2) e **ViaCEP** como reserva | gratuitos | Com cache em tabela |
| **Geocodificação** | **Nominatim** (OSM). Em escala SaaS, **self-host** ou **Photon**, porque o servidor público limita a 1 req/s | ODbL / gratuito | O pin no mapa é ajustável à mão |
| **PDF** (ficha, proposta, avaliação, contrato) | **`@react-pdf/renderer`** (já é dependência) | MIT | Mesmo motor do PDF de LGPD |
| **Índices e taxas** | **API SGS do Banco Central** (dados abertos) | gratuito | INCC para lançamentos e taxas médias de financiamento imobiliário como referência do simulador. Confirmar a série antes de usar |
| **Visualizador 360°** | **Pannellum** | MIT | Fotos panorâmicas próprias. Tours de terceiros (Matterport, Kuula) entram como link |
| **Imagens** (WebP, marca d'água, miniaturas) | **sharp** no servidor + compressão no navegador | Apache-2.0 | — |
| **OCR de documentos** | IA multimodal que o projeto já usa (`media-derive`) ou **Tesseract** para reduzir custo | Apache-2.0 | Classificar "isto é um RG/comprovante" |
| **Push no celular** | **Web Push** (`web-push`, já é dependência) + PWA | MIT | Sem Firebase |
| **E-mail transacional** | SMTP que já existe (`lib/email/roteador.ts`) com **Amazon SES** (baixo custo) ou **Postal** self-hosted | — | Para convite, alerta e proposta |
| **WhatsApp não oficial** | **WAHA** (já existe) e **Evolution API v2** (container ao lado do app) | Apache-2.0 (Evolution) | Evolution v2 roda com o próprio Postgres/Redis ou com os da instalação; fixar a tag da imagem (doutrina de packaging) |
| **Cobrança da assinatura (SaaS)** | **API do Banco Inter** (Pix com vencimento e boleto) | tarifas da conta PJ | Só no E19 |
| **Busca** | **Postgres** (`pg_trgm` + `pgvector`, já instalados) | — | Sem Elasticsearch |
| **Armazenamento** | Supabase Storage, depois **MinIO** | AGPL | — |
| **BI interno** (opcional) | Telas próprias com **Recharts** (já é dependência); **Metabase OSS** para a RE9 | MIT / AGPL | — |

---

## 3. Modelo de domínio

Todas as tabelas levam:

- `organization_id uuid not null references organizations(id) on delete cascade`;
- RLS `tenant_isolation_<tabela>_all`, ou as policies de visibilidade no molde de `crm_leads`
  quando o corretor só deve ver os seus registros;
- dinheiro em `_cents` + `currency`;
- `type`/`status` como `text` + CHECK;
- `created_at`/`updated_at`;
- `revoke execute ... from public, anon` em toda função.

Tudo isso entra pela tripla de migration.

### 3.1 Diagrama

```
                      ┌────────────────┐   (lançamentos — fase 1)
                      │  developments  │──► development_blocks ──► properties (unidades)
                      └────────────────┘
 contacts ◄─owner──┐  ┌────────────────┐  ┌──────────────────────┐
 (proprietário)    └──┤   properties   ├──┤ property_media        │ fotos, vídeo, planta, 360
 auth.users ◄captador─┤   (imóvel)     ├──┤ property_price_history│
                      └──┬──────┬──────┘  └──────────────────────┘
                         │      │
          property_mandates   property_keys / key_movements
          (autorização)       (chaves)

 crm_leads ─1:1─► lead_search_profiles ─► match (CALCULADO em SQL, sem tabela)
 crm_leads ─N:N─► properties via crm_lead_links (target_kind='property'; interesse|enviado|visitado|descartado)
 calendar_appointments ─1:1─► visit_details (imóvel, chave, check-in, ficha pós-visita)
 crm_leads ─1:N─► proposals ─1:N─► proposal_events
 proposals ─► contracts ─► contract_parties, documents, signature_requests (DocuSeal)
 contracts ─► commission_splits
 contacts/contracts ─► compliance_records (PLD/COAF)
 portal_integrations ─► portal_listings (Grupo OLX, Imovelweb)
```

### 3.2 `properties`: o imóvel

| Grupo | Colunas |
|---|---|
| Identidade | `id`, `code text` (referência, única por organização, ex.: `AP1234`), `development_id null`, `block_id null`, `unit_label null` |
| Classificação | `kind text` CHECK (`apartamento`,`casa`,`casa_condominio`,`cobertura`,`kitnet_studio`,`flat`,`terreno`,`lote_condominio`,`sala_comercial`,`loja`,`galpao`,`predio`,`chacara_sitio`,`fazenda`,`outro`); `segment` (`residencial`,`comercial`,`rural`); `stage` (`pronto`,`na_planta`,`em_construcao`); `condition` (`novo`,`usado`) |
| Endereço | `cep`, `street`, `number`, `complement`, `neighborhood`, `city`, `state char(2)`, `latitude numeric(9,6)`, `longitude numeric(9,6)`, `address_visibility` (`exato`,`aproximado`,`so_bairro`) |
| Medidas | `area_private_m2`, `area_total_m2`, `area_land_m2`, `bedrooms`, `suites`, `bathrooms`, `parking_spaces`, `floor`, `total_floors`, `year_built`, `sun_position` |
| Valores | `sale_price_cents`, `condo_fee_cents`, `iptu_cents` + `iptu_period`, `currency`, `price_on_request`, `min_price_cents` (piso de negociação autorizado pelo proprietário; **nunca exposto** à vitrine nem à IA como número, só como regra) |
| Condições | `accepts_financing`, `accepts_fgts`, `mcmv_eligible`, `accepts_exchange` (permuta), `exchange_notes` |
| Características | `features text[]` com vocabulário controlado no TS (piscina, churrasqueira, varanda gourmet, portaria 24h, elevador, academia, pet friendly, mobiliado, ar-condicionado…) + índice GIN |
| Documentação | `registry_number` (matrícula), `registry_office`, `iptu_registration`, `habite_se`, `documentation_status` (`regular`,`pendente`,`irregular`) |
| Estado | `status` CHECK (`draft`,`available`,`reserved`,`proposal`,`sold`,`suspended`,`archived`), `status_changed_at`, `published`, `featured` |
| Pessoas | `owner_contact_id → contacts`, `captured_by_user_id`, `responsible_user_id` |
| Conteúdo | `title`, `description` (rascunho pela IA, editável), `internal_notes`, `video_url`, `tour_url`, `embedding vector(1536)` |
| Rastreio | `source` (`manual`,`planilha`,`xml`,`ia_captacao`), `external_ids jsonb` (código em cada portal, com esquema Zod central) |

**Índices:**

- `(organization_id, status, kind)`
- `(organization_id, city, neighborhood)`
- `(organization_id, sale_price_cents)`
- GIN em `features`
- trigram em `title`/`neighborhood`
- `ivfflat` em `embedding`
- `(latitude, longitude)`

### 3.3 Tabelas satélites

| Tabela | Para quê | Pontos-chave |
|---|---|---|
| `property_owners` | Coproprietários | `contact_id`, `share_percent`, `is_primary`. Reusa `contacts`, que já tem CPF criptografado e cascata de LGPD |
| `property_media` | Mídia | `kind` (`photo`,`video`,`floorplan`,`panorama`), `storage_path`, `position numeric` (fractional indexing), `is_cover`, `publishable`, `caption`, `ai_description`. Até 50 fotos (limite do plano) |
| `property_price_history` | Histórico de preço | Append-only. Alimenta "queda de preço" e o tempo de mercado |
| `property_mandates` | Autorização de venda | `kind` (`exclusiva`,`aberta`), vigência, `commission_percent`, `document_id`, `signature_request_id`. Alerta de vencimento |
| `property_keys` / `key_movements` | Chaves | Onde está (imobiliária, portaria, proprietário, corretor), retirada, devolução, quem e quando |
| `lead_search_profiles` | Perfil de busca (1:1 com o lead) | `kinds[]`, `cities[]`, `neighborhoods[]`, `center_lat/lng` + `radius_km`, `price_min/max_cents`, `bedrooms_min`, `suites_min`, `parking_min`, `area_min`, `features_must[]`, `features_nice[]`, `payment` (`a_vista`,`financiamento`,`fgts`,`consorcio`,`permuta`), `income_band`, `down_payment_band`, `move_deadline`, `has_property_to_sell`, `free_text`, `embedding` |
| `visit_details` | Complemento da visita (1:1 com `calendar_appointments`) | `property_id`, `key_movement_id`, `checkin_at`, `checkin_lat/lng`, `feedback_score`, `feedback_likes`, `feedback_dislikes`, `next_step`. **A agenda existente é reaproveitada inteira** |
| `proposals` | Proposta | `lead_id`, `property_id`, `buyer_contact_id`, `amount_cents`, `payment_terms jsonb` (Zod: sinal, financiamento, FGTS, permuta, parcelas), `valid_until`, `status` (`rascunho`,`enviada`,`contraproposta`,`aceita`,`recusada`,`expirada`,`cancelada`), `document_id` |
| `proposal_events` | Negociação | Cada contraproposta é uma linha nova. Nada é sobrescrito |
| `contracts` | Contrato | `kind` (`promessa_compra_venda`,`compra_venda`,`autorizacao_venda`,`recibo_sinal`), `contract_parties` (`vendedor`,`comprador`,`conjuge`,`procurador`,`corretor`), valores, datas (sinal, financiamento, escritura, chaves), `status`, `retention_until` |
| `signature_requests` | Envio para assinatura (DocuSeal) | `document_id`, `provider`, `external_id`, signatários, `status`, `completed_at`, `audit_trail_path`. Webhook idempotente (`unique (organization_id, external_id)`) |
| `commission_policies` / `commission_splits` | Comissão | A política define, por exemplo, 6% no total, sendo 40% captação e 60% venda. Os splits têm beneficiário (`user`,`parceiro`,`imobiliaria`), papel (`captador`,`vendedor`,`gerente`,`parceiro`,`plantao`), percentual, valor, status e estorno por contra-lançamento. Integra com `financial_entries` |
| `portal_integrations` / `portal_listings` | Portais | Por portal (`grupo_olx`,`imovelweb`): `feed_token` (hash), credenciais em segredo, limites de destaque do plano contratado com o portal, último envio, último erro; por imóvel: nível de destaque, status, id externo, leads recebidos |
| `compliance_records` | PLD/COAF | `kind` (`cadastro_pld`,`operacao_registrada`,`comunicacao_coaf`,`declaracao_nao_ocorrencia`), `pep`, `beneficial_owner`, valores (inclusive em espécie), protocolo. **Visível só ao papel `compliance`** |
| `saas_plans` / `saas_subscriptions` / `saas_invoices` | Assinatura do ImobCRM | Plano, limites, ciclo, status (`trial`,`active`,`past_due`,`suspended`,`cancelled`), cobranças Pix/boleto. **Sem RLS de tenant para escrita**: só a plataforma escreve, e a organização lê a sua |

**Lançamentos (fase 1, decisão C):**

| Tabela | Para quê | Pontos-chave |
|---|---|---|
| `developments` | Empreendimento | Nome, incorporadora (`developer_contact_id`), endereço, `stage` (`breve_lancamento`,`lancamento`,`em_obras`,`pronto`), previsão de entrega, registro da incorporação (RI), memorial, links de book, decorado e tour, VGV previsto, comissão padrão do empreendimento |
| `development_blocks` | Torre/bloco/quadra | Nome, andares, unidades por andar. A geração em lote das unidades cria linhas em `properties` com `development_id` |
| `development_typologies` | Tipologia (planta) | Nome (ex.: "2 dorms com suíte"), área, quartos, vagas, planta. As unidades herdam os dados da tipologia |
| `development_price_tables` | Tabela de preços | Versionada por ponteiro (igual a `promise_table_versions`): preço por unidade, fluxo (entrada, mensais, intermediárias, chaves), índice de correção (INCC até as chaves) e validade |
| `unit_reservations` | Reserva de unidade | `lead_id`, `property_id`, corretor, `expires_at`. **Uma reserva ativa por unidade** (índice único parcial). Expiração por cron, fila de espera por unidade |

**Mudanças no núcleo:**

- `crm_lead_links.target_kind` passa a aceitar `property`, `proposal` e `contract`.
- `teams`/`team_members` e `visibility_mode='team'`.
- `user_organizations.creci`/`creci_uf` e `organizations.creci_pj`.
- `documents` genérica com `sensitivity`, `retention_basis` e `retention_until`.
- A cascata de LGPD respeita a retenção legal.

### 3.4 Match: calculado, nunca sincronizado

`fn_imob_match(org, lead_id | property_id, limite)` é SQL puro, em três etapas:

1. **Filtro duro:** tipo, cidade/bairro ou raio, preço com tolerância configurável (±10%), quartos
   ≥ mínimo, e `status = available`.
2. **Pontuação** de 0 a 100:
   - preço: 30
   - localização (bairro 25; vizinho ou raio 15)
   - quartos/suítes/vagas: 15
   - obrigatórios: 15
   - desejáveis: 5
   - similaridade semântica: 10
3. **Explicação por item:** "dentro do orçamento", "falta 1 vaga".

Os consumidores são a tela de Match, a ferramenta `crm_match_properties`, o gatilho
`imovel.compativel` e a campanha segmentada.

---

## 4. O agente de IA imobiliário

### 4.1 Ferramentas novas

| Ferramenta | Pacote | Risco | O que faz |
|---|---|---|---|
| `crm_search_properties` | vender | baixo | Busca híbrida (filtros + texto). Até 5 imóveis, com código, resumo, preço e link da vitrine. Tem `motivoDoVazio` ("o mais próximo custa 430 mil") |
| `crm_get_property` | vender | baixo | Ficha, respeitando `address_visibility` |
| `crm_match_properties` | vender | baixo | Compatíveis com o perfil, com explicação |
| `crm_save_search_profile` | vender | baixo | Grava o perfil estruturado (Zod) |
| `crm_simulate_financing` | vender | baixo | SAC e PRICE **determinísticos**: entrada, prazo, taxa de referência, renda mínima (comprometimento ≤ 30%), enquadramento MCMV. Tabela de taxas e faixas **versionada e editável** por imobiliária. Aviso fixo: "simulação, sujeita à análise de crédito do banco" |
| `crm_book_visit` | atender | médio | Visita com imóvel, endereço, corretor responsável (imóvel, região ou roleta) e chave |
| `crm_register_visit_feedback` | reter | baixo | Ficha pós-visita pela conversa |
| `crm_create_proposal_draft` | vender | **crítico** | Rascunho que **sempre** passa por aprovação humana |
| `crm_create_property_draft` | atender | médio | Agente de captação: proprietário descreve e manda fotos, e o sistema cria um rascunho para o captador |
| `crm_list_developments` / `crm_get_unit_availability` | vender | baixo | Lançamentos: tipologias, unidades disponíveis e tabela vigente, com o fluxo de pagamento calculado |

**Envio de mídia.** Generalizar `send_message.produto_codigo` para `imovel_codigo`: capa + 4 fotos,
resumo, link da vitrine e, se houver, vídeo (`sendVideo`), ficha em PDF (`sendFile`) e pino de
localização aproximada. **Tudo passa pelo `runBeforeSend`.**

### 4.2 Qualificação

O `update_lead_state` ganha, além de BANT, um bloco imobiliário:

- `forma_pagamento`
- `renda_faixa`
- `entrada_faixa`
- `usa_fgts`
- `prazo_mudanca`
- `ja_visitou_outros`
- `tem_imovel_para_vender`

O bloco é gravado em `lead_search_profiles`. Renda é sempre pedida **em faixa**, e documentos só no
estágio de proposta, com finalidade declarada. A regra de `platform.md:29` ganha uma exceção por
base legal (`guardrails/lgpd/legal-basis.ts`).

### 4.3 Guardrails novos

| Gate | Veta |
|---|---|
| `financing_promise` | "Financiamento aprovado", "taxa garantida". Estende `guardrails/promise/engine.ts` |
| `price_negotiation` | Desconto fora da regra do proprietário (`min_price_cents`), revelar o piso, negociar sem humano |
| `address_privacy` | Endereço exato quando a visibilidade não permite |
| `creci_disclosure` | Primeira mensagem e material de divulgação sem a identificação e o CRECI da imobiliária |
| `availability_truth` | Oferecer imóvel que não está `available` |

### 4.4 Agentes, roteador e skills do kit

| Agente | Função |
|---|---|
| **Atendimento de Vendas** | Qualifica, busca, envia, simula, agenda visita |
| **Captação** | Proprietário que quer vender: dados, fotos e avaliação agendada |
| **Lançamentos** | Tipologias, unidades disponíveis, tabela e fluxo de pagamento vigentes, visita ao decorado/estande, reserva (com humano) |
| **Pós-visita e reengajamento** | Ficha pós-visita e reativação por match |

**Roteador:** *comprar pronto/usado* · *lançamento/na planta* · *vender/anunciar meu imóvel* · *já sou cliente/falar com corretor* ·
*outros*. Pedidos de **aluguel** recebem uma resposta educada de que a imobiliária trabalha só com
venda, que é configurável.

**Skills:**

- `qualificacao-compra`
- `objecao-preco-imovel`
- `financiamento-e-fgts`
- `mcmv`
- `permuta`
- `visita-e-chaves`
- `documentos-da-compra`
- `custos-da-compra` (ITBI, escritura, registro, avaliação bancária)

### 4.5 Follow-ups de venda

Criar `lib/followup/modelos/imobiliaria.ts` e incluir o nicho em `NICHOS_DE_MODELO`.

| Cadência | Gatilho | Passos |
|---|---|---|
| Lead de portal sem resposta | `lead_created` + `silence` | 5 min, 2 h, 24 h (imóveis similares), 72 h |
| Perfil definido sem visita | etapa "Qualificado" + 48 h | Nova seleção via match |
| Pós-visita | `appointment.completed` | 2 h: ficha; 48 h: alternativas |
| Não compareceu | `appointment.no_show` | Reagendar (`fn_appointment_recover`) |
| Proposta parada | etapa "Proposta" + 72 h | **Tarefa para o corretor**, não a IA |
| Reengajamento | evento `imovel.compativel` | Proposta de contato com aprovação humana |
| Pós-venda | contrato assinado + 30/180/365 dias | Indicação, avaliação, aniversário do imóvel |

---

## 5. Épicos

### E0 — Fundação do fork e da operação SaaS · *infraestrutura*

Ver §2.2 e §2.3.

**Aceite:** staging e produção de pé com a marca ImobCRM, deploy pelo CI, backup restaurado com
sucesso, e um merge de `upstream/main` sem conflito em migration.

### E1 — Kit imobiliário e vocabulário · ⚡ primeira entrega

- **Onboarding.** O ImobCRM só atende imobiliária, então **não há seleção de nicho**. O passo
  "Seu negócio" pergunta: nome, CRECI-J, cidade(s) e bairros de atuação, número de corretores,
  portais que usa. O kit aplica de uma vez (`app/actions/onboarding/montarQuadro.ts` passa a gravar
  tudo):
  - **Funis:**
    - **Venda:** Novo lead → Em atendimento → Qualificado → Visita agendada → Visitou → Proposta → Documentação/Financiamento → Vendido | Perdido
    - **Lançamento:** Interessado → Em atendimento → Visitou decorado/estande → Simulação → Reserva → Contrato → Vendido | Perdido
    - **Captação:** Proprietário novo → Avaliação agendada → Avaliado → Autorização assinada → Fotos e anúncio → Publicado | Não captado
  - **Vocabulário:** Cliente / Negócio / Vendido / Perdido.
  - **Motivos de perda:** crédito negado, comprou com outro, desistiu, preço, localização, imóvel
    vendido, sem retorno.
  - **Campos obrigatórios por etapa:** imóvel e valor em "Proposta".
  - **Tipos de agenda:** Visita, Avaliação, Assinatura, Plantão.
  - **Agentes, roteador, skills, follow-ups e FAQ** da §4.
  - **Passo "Conectar sua IA"** (decisão A): tutorial leigo com prints para criar a chave, teste da chave na hora, estimativa de custo mensal e teto de gasto já ligado.
  - **Menu imobiliário:** saem Comandas, Faturamento de comanda, Produtos, Prospecção B2B e
    Nuvemshop, pelo `interface_settings` ou por um módulo desligado na instância.
- **Vocabulário em toda a interface:** `useVocabulario(pipelineId)` em `NewLeadDialog`,
  `pipelines/[id]/_client.tsx`, `CRMSidePanel`, `LeadDossier` e `LoseLeadDialog`. Troca também os
  textos de outros nichos ("paciente", "combo presente").
- **Aceite:** um leigo cria conta, faz o onboarding e, sem configurar nada, tem os 2 funis, a
  agenda com "Visita" e o agente respondendo "procuro 2 quartos até 400 mil". Provado por
  Playwright em ambiente fresco.

### E2 — Cadastro de imóveis · *fase 1*

- `/app/imoveis` em lista, grade e **mapa**, com filtros laterais.
- **Ficha do imóvel**, com as abas Dados, Mídia, Proprietários, Interessados, Visitas, Propostas,
  Documentos e Histórico.
- **Formulário por etapas:**
  - CEP → endereço (BrasilAPI) → pin ajustável (Nominatim);
  - campos condicionais por tipo, porque terreno não tem quartos.
- **Mídia:**
  - upload em lote pelo celular, com arrastar e reordenar;
  - WebP e marca d'água opcional;
  - descrição de cada foto pela IA;
  - **texto do anúncio gerado pela IA** como rascunho editável.
- **Código de referência automático** (prefixo por tipo, configurável).
- **Importação por planilha e XML**, para quem migra de outro sistema. É idempotente por
  `external_ids`.
- **Reaproveita** o padrão de `app/app/products/_client.tsx`, `lib/catalogo/planilha.ts`,
  `lib/catalogo/busca.ts` e `fotos-do-produto.ts`.
- **Aceite:**
  - um imóvel com 20 fotos é cadastrado pelo celular em menos de 5 minutos;
  - reimportar a mesma planilha não duplica;
  - o teste de isolamento entre 2 organizações passa.

### E3 — Captação e avaliação · *fase 3*

- Funil de captação, com o proprietário como contato e o imóvel como rascunho.
- **ACM** (análise comparativa de mercado): comparáveis do estoque e das vendas registradas, preço
  por m² (média e mediana), faixa sugerida e **PDF de avaliação** com a marca.
- **Autorização de venda** em modelo com variáveis, assinada no DocuSeal, com alerta de vencimento
  em 30/15/5 dias.
- **Agente de captação.**
- **Aceite:** "quero vender meu apartamento" termina com o imóvel em rascunho, as fotos da conversa
  e uma avaliação agendada para o captador da região.

### E4 — Perfil de busca e match · *fase 2*

- Aba "Perfil de busca" no dossiê e no painel lateral do inbox.
- Tela Match com as duas direções: imóvel → quem avisar, e lead → imóveis.
- Gatilho `imovel.compativel`: um trigger grava no `event_log` e um worker gera as propostas de
  contato na Central, com aprovação humana e pacing.
- **Aceite:** um imóvel compatível com 3 perfis gera 3 propostas explicadas em menos de 1 minuto.

### E5 — Agente de IA imobiliário · *fases 1 e 2*

- Tudo o que está na §4.
- **Prova em par:** tela e ferramenta com o mesmo texto.
- **Corpus de avaliação:** 50 conversas reais da **RE9 Imob**, anonimizadas.
- **Aceite:**
  - 1ª resposta em menos de 60 s;
  - 100% dos imóveis citados existem no estoque;
  - zero promessa de financiamento;
  - visita na agenda do corretor certo com o endereço.

### E6 — Visitas · *fase 2*

- Agendar a partir do imóvel ou do lead, com endereço preenchido, corretor sugerido e conflito
  verificado.
- **Roteiro do dia** com link para Google Maps e Waze.
- **Chaves:** controle de retirada e devolução, e alerta de chave não devolvida.
- **Confirmação** em D-1 e 2 h antes, com botões.
- **Check-in** com GPS e **ficha pós-visita**, que atualiza o perfil de busca e move o funil.
- **Página pública** de agendamento por imóvel.
- **Aceite:** a visita marcada pela IA aparece na agenda do corretor e no Google Calendar, a
  confirmação chega, e o check-in e a ficha movem o lead para "Visitou".

### E7 — Portais Grupo OLX e Imovelweb · *fase 2*

- **Saída (feed XML):**
  - `GET /api/v1/feeds/[token]/grupo-olx.xml` (formato **VRSync**) e `.../imovelweb.xml` (formato
    do Imovelweb), com token no caminho, cache e rate limit;
  - escolha por imóvel: publicar ou não, e com que nível de destaque, dentro do limite contratado
    com o portal;
  - **validador na tela** com o erro de cada imóvel (foto faltando, CEP, CRECI ausente).
- **Entrada de leads:**
  - normalizadores no webhook de entrada (`app/api/v1/webhooks/in/[token]`, no padrão de
    `lib/webhooks/respondi.ts`) para a integração de leads do **Grupo OLX** e do **Imovelweb**;
  - o código do anúncio vira automaticamente o vínculo lead↔imóvel, depois vêm a roleta e a IA;
  - onde o portal só entregar por e-mail, uma caixa de entrada com parser (fase 3).
- **Custo por portal** (informado por mês), para calcular CPL e custo por venda.
- **Aceite:**
  - um lead de teste de cada portal cria o lead já vinculado ao imóvel, com responsável, e a IA
    responde em menos de 60 s;
  - os feeds passam no validador de cada portal.

> Os formatos, os endpoints e as regras de cada portal mudam. **Antes de implementar,** baixar a
> documentação vigente do Grupo OLX (VRSync e integração de leads) e do Imovelweb, pela conta de
> anunciante da RE9 Imob, e registrar a versão usada em `docs/imobiliario/`.

### E8 — Distribuição de leads e equipes · *fase 3 (núcleo)*

- Equipes, com o gerente vendo só a sua (RLS).
- **Roleta de lead** por região, faixa de preço, portal e tipo, com pesos e escala de plantão.
- **Prazo de resposta com repasse**, auditado e visível na Central.
- **Captador × vendedor:** papel secundário no lead, usado na comissão.
- **Reaproveita** `lib/routing/decide.ts`, `eligibles.ts` e `eligibility.ts`.
- **Aceite:** 20 leads distribuídos entre 4 corretores sem duplicar, o ausente não recebe, e o
  prazo estourado repassa e registra.

### E9 — Propostas · *fase 3*

- Formas de pagamento estruturadas, PDF com a marca e envio pelo WhatsApp.
- Contraproposta encadeada e expiração automática.
- Registro do aceite do proprietário.
- Ao aceitar: o imóvel vai para `proposal`/`reserved`, é aberta a tarefa de documentação e, se a
  organização quiser, os outros interessados são avisados.
- **Aceite:** 3 contrapropostas visíveis na timeline, e o status do imóvel muda sozinho.

### E10 — Documentos e contratos com DocuSeal · *fase 3*

- **Checklist por papel:** comprador PF/PJ, vendedor, cônjuge, imóvel (matrícula, certidões,
  IPTU, condomínio).
- Documento recebido pelo WhatsApp é **classificado pela IA** e anexado com um clique.
- **Modelos:** autorização de venda, recibo de sinal, proposta e promessa de compra e venda, com
  variáveis, em PDF.
- **Assinatura:** o sistema envia ao DocuSeal, recebe o webhook "assinado" e arquiva o PDF com a
  trilha de auditoria.
- **Retenção legal:** contratos e documentos não são apagados antes do prazo, e o titular recebe a
  explicação.
- **Aceite:** uma promessa de compra e venda gerada, assinada por comprador, vendedor e cônjuges,
  arquivada e protegida (bucket privado, URL curta, auditoria de download).

### E11 — Comissões · *fase 3*

- Políticas por organização, com rateio automático ao ganhar o negócio e ajuste auditado.
- Estorno por contra-lançamento em caso de distrato.
- Extrato do corretor e relatório para NF/RPA.
- **Aceite:** uma venda de R$ 500 mil a 6% gera os splits certos, e o distrato estorna tudo.

### E12 — Lançamentos · *fase 1 (decisão C)*

- Empreendimento, torres e unidades geradas em lote.
- **Espelho de vendas** em tempo real, tabela de preços versionada e fluxo de pagamento com INCC.
- Reserva com expiração, fila por unidade e imobiliárias parceiras.
- **Aceite:** reservas simultâneas da mesma unidade resultam em uma só, e a reserva vencida se
  libera sozinha.

### E14 — Vitrine pública · *fase 2 (básica) e fase 4 (completa)*

- Site da imobiliária no subdomínio ou no domínio próprio (TLS on-demand do Caddy):
  - busca com mapa;
  - página do imóvel com galeria, mapa aproximado, simulador e visita;
  - botão de WhatsApp com **link rastreável** (origem "site" no lead).
- **SEO:** renderização no servidor, `schema.org/RealEstateListing`, sitemap e **Open Graph** (o
  link fica bonito no WhatsApp).
- **Landing page por imóvel ou campanha**, para os anúncios Meta/Google.
- **Aceite:** LCP menor que 2,5 s no 4G, Lighthouse ≥ 90, e o lead do formulário cai no funil com
  origem.

### E15 — Compliance · *fases 2 e 3*

Ver §6.

### E16 — Métricas · *fase 3*

Ver §7. O `/app/metrics` ganha as abas Vendas, Captação, Portais e Corretores.

### E17 — App do corretor (PWA) · *fase 3*

- **Abas:** Hoje, Leads, Imóveis e Agenda.
- **Recursos:** câmera para captação, check-in com GPS, push de lead novo (Web Push) e modo offline
  da ficha e do roteiro.
- **Instalação:** ícones de 192 e 512 px no `manifest.ts`.
- **Aceite:** do push à visita marcada em menos de 2 minutos, só pelo celular.

### E20 — Evolution API v2 como canal · *fase 2*

- **Adaptador** `lib/channels/adapters/evolution.ts`, no mesmo contrato de `waha.ts`: enviar texto, mídia, localização e cartão; presença; marcar como lido.
- **Provider** `evolution` no CHECK de `channel_sessions` (forward-fix num bloco único do apêndice) e em `PROVIDERS_DE_MENSAGEM` (`lib/channels/capabilities.ts`), declarando as capacidades reais medidas na documentação da Evolution.
- **Webhook de entrada** por token no caminho, com autenticação (apikey/assinatura da instância) e idempotência `unique (organization_id, external_id)`. Eventos: `MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `CONNECTION_UPDATE`, `QRCODE_UPDATED`. Grupos (`@g.us`) ignorados, `fromMe` sem duplicar, como no WAHA.
- **Conexão pela tela** com QR Code e código de pareamento, igual ao fluxo do WAHA (`lib/channels/connect-waha.ts`).
- **Serviço** `evolution` no `docker-compose.prod.yml` com imagem de **tag fixa**, atrás de um perfil (liga quem usa). Variáveis novas com default que não quebra `.env` antigo.
- **Aceite:** com um número de teste, conversa completa de ida e volta (texto, foto, áudio, localização) com o agente de IA respondendo; queda da conexão aparece na Central; `pnpm test:shell` verde.

### E19 — Camada comercial SaaS · *depois da validação na RE9 Imob*

- **Cadastro público:** site de vendas → cadastro → teste grátis de 14 dias → onboarding do kit.
- **Planos e limites** aplicados no servidor, com aviso ao se aproximar do limite.
- **Cobrança** Pix/boleto pela **API do Banco Inter**, com régua de cobrança, bloqueio suave (somente
  leitura) e depois suspensão.
- **Console da RE9** (estende `/admin/tenants`, que já existe): receita, clientes, uso, saúde,
  inadimplência e sessão de suporte auditada.
- **Termos:** termos de uso, DPA e política de privacidade versionados, com aceite registrado.
- **Aceite:** um cliente novo assina sozinho, paga por Pix, tem o plano ativado automaticamente e é
  suspenso e reativado conforme o pagamento.

> **Fora do escopo** (decisão 1): E13 Locação e administração, e E18 Portais de
> proprietário/inquilino. Se a decisão mudar, os dois estão descritos na versão anterior deste
> plano (histórico do git).

---

## 6. Compliance e regulação

> ⚠️ **Validar com assessoria jurídica e contábil** antes do lançamento comercial. Tudo que é
> regra (limiares, textos obrigatórios, faixas do MCMV) é **configuração versionada**, nunca texto
> fixo no código.

| Tema | Base | O que o ImobCRM faz |
|---|---|---|
| **CRECI** | Lei 6.530/78 e resoluções do COFECI sobre publicidade | CRECI-J da imobiliária e CRECI de cada corretor. Inserção automática em vitrine, feeds, PDFs, campanhas e disclosure do agente. **Publicação bloqueada sem CRECI** |
| **PLD/COAF** | Lei 9.613/98 e regulamentação do COFECI | Cadastro com PEP e beneficiário final, registro de operações acima do limiar ou em espécie, fila de operação atípica, registro da comunicação ao COAF (Siscoaf), **declaração anual de não ocorrência**, guarda por 5 anos, **papel `compliance`** isolado (sigilo) |
| **LGPD** | Lei 13.709/18 | A RE9 é operadora e a imobiliária é controladora (DPA). Documentos com sensibilidade e base legal. Retenção legal acima da eliminação, com explicação. Vários titulares por negócio. Renda em faixa. Consentimento para reengajamento. Relatório por titular (reusa `lgpd_requests`) |
| **CDC** | Lei 8.078/90 | Preço do anúncio = preço do cadastro (feed gerado do cadastro). Proposta com validade clara. Oferta vincula, por isso o gate `availability_truth` |
| **DIMOB** | Instrução normativa da Receita Federal | Exportação anual das intermediações de compra e venda |
| **WhatsApp** | Política da Meta + opt-out existente | Reengajamento só com consentimento ou legítimo interesse documentado. Pacing, janela e STOP já existem |

---

## 7. Métricas do negócio

| KPI | Definição |
|---|---|
| **Tempo da 1ª resposta** por portal | Minutos até a 1ª mensagem (IA ou humano) |
| **Lead → visita → proposta → venda** | Funil com semântica fixa (etapas mapeadas, não pelo nome) |
| **VGV** | Vendido no período, em negociação, em estoque |
| **Tempo médio de venda** | De `available` a `sold`, por tipo e bairro |
| **Captações por captador** e **% exclusivas** | — |
| **Preço/m²** anunciado × vendido, por bairro | Insumo do ACM |
| **CPL e custo por venda** por portal (Grupo OLX, Imovelweb, site, Meta) | — |
| **Comissão** gerada, a pagar, paga | — |
| **Produtividade do corretor** | Leads, visitas, propostas, vendas, prazo cumprido, nota das visitas |
| **Desempenho da IA** | % qualificados, visitas marcadas, passagens para humano e motivos, custo por lead |
| **SaaS (console RE9)** | MRR, clientes ativos, churn, conversão do teste, uso por plano |

---

## 8. Roadmap

As estimativas são para **1 pessoa sênior + Claude Code**, cumprindo a Definição de Pronto
inteira. São aproximadas e serão recalibradas ao fim da fase 1.

| Fase | Épicos | Resultado | Estimativa |
|---|---|---|---|
| **0 — Fundação** | E0 | Fork com a marca ImobCRM instalado na VPS em `crmimob.re9imob.com.br`, imagens publicadas pelo CI, backup testado | 1–2 semanas |
| **1 — RE9 Imob operando** | E1 (com o passo da chave de IA), E2, **E12**, E5 (busca + visita básica) | **A RE9 Imob opera no ImobCRM**: funis de Venda, Lançamento e Captação; estoque de usados **e** lançamentos com espelho de vendas; agente buscando o estoque real e marcando visita | 6–8 semanas |
| **2 — Portais, match e canais** | E7 (Grupo OLX + Imovelweb), E4, E6, E14 (básica), E5 (completo), E15 (CRECI), **E20** (Evolution v2) | Leads dos portais com resposta instantânea, publicação automática, match, visitas completas, vitrine, três opções de WhatsApp | 7–9 semanas |
| **3 — Operação completa** | E8, E3, E9, E10 (DocuSeal), E11, E16, E17, E15 (PLD) | Roleta com prazo, captação com ACM, propostas, contratos assinados, comissões, BI, app do corretor | 9–11 semanas |
| **4 — SaaS** | E19 (Inter), E14 (completa, domínio próprio), Meta Lead Ads | Venda para outras imobiliárias: cadastro, planos, cobrança, console da RE9 | 5–7 semanas |

A **RE9 Imob opera de verdade a partir da fase 1** e valida cada fase seguinte. A comercialização
para terceiros começa na fase 4.

---

## 9. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Conflito com o upstream | Pastas próprias, faixa de migrations, bloco único no baseline, ganchos genéricos devolvidos por PR |
| API interna do upstream muda | O vertical usa só helpers canônicos (`ok`/`fail`, `requireRole`, `audit`) e tem testes próprios no CI |
| Portal muda o formato ou para de mandar lead | Detecção estrita, todo payload guardado em `webhook_lead_captures`, **alerta na Central** quando um portal fica X horas sem lead |
| IA alucina imóvel ou promete financiamento | Busca estruturada obrigatória, gates `availability_truth` e `financing_promise`, corpus da RE9 Imob no CI |
| Custo de IA e de WhatsApp no SaaS | Orçamento por organização (existe) e limites por plano; API oficial da Meta com custo na conta do cliente |
| Um cliente derruba os outros (SaaS) | Rate limit por organização, filas por organização, limites de plano, monitoramento |
| Dados sensíveis | Bucket privado, URL curta, auditoria de download, classificação, retenção, DPA |
| Armazenamento de fotos cresce | WebP ≤ 300 KB, limite por plano, migração para MinIO/R2 prevista |
| DocuSeal: recurso necessário ser só da versão Pro | Adaptador trocável. Alternativa gratuita: PDF assinado com PAdES (já existe) + aceite registrado |
| Escopo grande | Fases com valor próprio, e a RE9 Imob usando desde a fase 1 |

---

## 10. Definição de pronto do vertical

Além dos 18 itens do `CLAUDE.md`, todo épico cumpre estes critérios:

1. **Prova pela tela como um corretor leigo**, em ambiente fresco, com evidência em
   `evidence/imob-<épico>/`.
2. **Isolamento entre 2 organizações** para toda tabela nova, inclusive feeds e vitrine (cliente de
   serviço com `organization_id` resolvido do token ou do domínio).
3. **Prova em par** em todo caminho que passa pela IA.
4. **Cascata de LGPD** alcançando as tabelas novas que guardam pessoa, respeitando a retenção
   legal.
5. **Laço de retorno:** portal parado, feed com erro, chave não devolvida, assinatura pendente e
   cobrança falhada aparecem na Central com o próximo passo.
6. **Porta na navegação** (`lib/navigation/catalogo.ts`).
7. **Fragmento em `.changes/`** e nota no changelog do ImobCRM.

---

## 11. Decisões ainda em aberto

As decisões A a E foram tomadas (§0, itens 9 a 13). Restam pontos operacionais, sem impacto na fase 0:

| # | Pergunta | Recomendação |
|---|---|---|
| F | **Supabase:** nuvem (supabase.com) ou dentro da própria VPS (`supabase-single-server`)? | **Nuvem, no começo.** Menos manutenção e backup incluso; o plano gratuito pausa por inatividade, então usar o Pro assim que a RE9 Imob operar de verdade |
| G | **Tamanho da VPS** | 4 vCPU e 8 GB de RAM para app + worker + scheduler + Redis + Evolution/WAHA + DocuSeal. Conferir o que já existe |
| H | **Conta Meta** da RE9 Imob verificada (Business Manager + número na API oficial)? | Iniciar a verificação já, porque ela leva dias e trava o canal oficial |
| I | **Planos do Grupo OLX e do Imovelweb** da RE9 Imob já incluem integração (feed XML e entrega de leads)? | Pedir ao atendimento de cada portal a documentação e as credenciais de integração |

---

## 12. Apêndice: telas — manter, adaptar e esconder

| Tela atual | Decisão | Nota |
|---|---|---|
| Inbox | **Adaptar** | Painel lateral ganha "Perfil de busca", "Imóveis enviados/de interesse" e "Agendar visita" |
| Radar | Manter | Crítico no ciclo longo |
| Agenda | **Adaptar** | Agenda de visitas (imóvel, chave, check-in, roteiro), sem os textos de clínica |
| Respostas rápidas | Manter | Semear scripts de venda |
| Funis (kanban) | **Adaptar** | Card com miniatura, bairro e preço do imóvel (troca de faixa, sem crescer). Filtros por bairro, tipo e faixa |
| Contatos / ficha 360 | **Adaptar** | Abas "Perfil de busca", "Imóveis (proprietário)" e "Documentos" |
| Tarefas, Campanhas, Chamadas | Manter | Campanha ganha filtro por perfil de busca |
| Produtos | **Esconder** | Substituído por Imóveis (o código de fotos é reaproveitado) |
| Comandas, Faturamento de comanda, Financeiro de comanda | **Esconder** | Conceitos reaproveitados na comissão |
| Prospecção (Google Maps B2B) | **Esconder** | — |
| Nuvemshop | **Esconder** | — |
| Dados externos (banco externo) | **Esconder** | Sem ERP (decisão 5) |
| IA (agentes, roteadores, follow-ups, conhecimento, skills, casos…) | Manter | Com conteúdo imobiliário semeado |
| Conexões, Webhooks, Anúncios Meta, Auditoria, LGPD, Equipe, Configurações, Extensões | Manter | Configurações ganham "Portais", "CRECI e compliance", "Comissões" e "Assinatura e plano" |
| Desempenho | **Adaptar** | Abas imobiliárias (§7) |
| **Novas** | — | Imóveis, Captação/ACM, Match, Propostas, Contratos, Comissões, Portais, Painel do corretor, App móvel, Vitrine pública, Console SaaS, Empreendimentos/Espelho de vendas |
