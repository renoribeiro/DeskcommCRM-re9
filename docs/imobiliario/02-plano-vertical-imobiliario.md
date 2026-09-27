---
type: plan
project: DeskcommCRM (fork re9 — vertical imobiliário)
status: proposta — aguarda as decisões da §11
last_updated: 2026-09-27
base: auditoria em 01-auditoria.md (HEAD 38dd469)
---

# Plano: DeskcommCRM Imobiliário

> **Objetivo:** transformar o DeskcommCRM num **sistema operacional de vendas e locação
> imobiliária com agentes de IA nativos no WhatsApp**. Ele deve servir imobiliárias, corretores
> autônomos, incorporadoras/lançamentos e administradoras de locação, cobrindo todas as
> particularidades do mercado brasileiro.
>
> Este plano deriva da auditoria em [`01-auditoria.md`](01-auditoria.md). Cada épico diz **o que
> reaproveitar** (arquivo real do repositório) e **o que construir**.

---

## Sumário

1. [Tese do produto](#1-tese-do-produto)
2. [Decisão de arquitetura](#2-decisão-de-arquitetura)
3. [Modelo de domínio](#3-modelo-de-domínio)
4. [O agente de IA imobiliário](#4-o-agente-de-ia-imobiliário)
5. [Épicos](#5-épicos)
6. [Compliance e regulação](#6-compliance-e-regulação)
7. [Métricas do negócio imobiliário](#7-métricas-do-negócio-imobiliário)
8. [Roadmap faseado](#8-roadmap-faseado)
9. [Riscos e mitigação](#9-riscos-e-mitigação)
10. [Definição de pronto do vertical](#10-definição-de-pronto-do-vertical)
11. [Decisões que dependem do dono do produto](#11-decisões-que-dependem-do-dono-do-produto)
12. [Apêndice: telas — manter, adaptar e esconder](#12-apêndice-telas--manter-adaptar-e-esconder)

---

## 1. Tese do produto

### 1.1 O problema do mercado

O mercado imobiliário brasileiro vende pelo WhatsApp. Mas a operação típica tem cinco problemas:

1. **Lead de portal esfria em minutos.** ZAP, VivaReal e OLX entregam o lead para várias
   imobiliárias ao mesmo tempo, e quem responde primeiro leva. O tempo médio de resposta do
   mercado se mede em horas.
2. **O estoque vive fora do CRM**, num ERP (Vista, Jetimob, Kenlo, Imobzi) ou numa planilha. O
   corretor não sabe na hora o que oferecer.
3. **O corretor é o dono do relacionamento.** Quando ele sai, a carteira sai com ele.
4. **O ciclo é longo** (30 a 180 dias na venda) e cheio de etapas documentais: visita, proposta,
   contraproposta, documentação, financiamento, contrato, escritura e chaves.
5. **A regulação é específica:** CRECI, COAF/PLD, Lei do Inquilinato, LGPD sobre documentos
   pessoais e DIMOB.

### 1.2 A proposta

| Pilar | Na prática |
|---|---|
| **Resposta em segundos, 24/7** | O agente de IA responde o lead do portal na hora, qualifica (finalidade, região, faixa, quartos, financiamento/FGTS), **busca no estoque real**, envia fotos, vídeo e localização, e **agenda a visita na agenda do corretor certo** |
| **Estoque dentro do CRM** | Cadastro de imóveis e empreendimentos com fotos, mapa e códigos. Publicação automática nos portais por feed XML. Importação do ERP atual |
| **Match contínuo** | Cada imóvel novo ou com redução de preço é cruzado com todos os perfis de busca ativos, e a IA propõe o contato (com aprovação humana) |
| **Carteira da empresa, não do corretor** | Todo histórico fica no CRM. A roleta distribui leads com SLA. A gestão vê tudo por equipe |
| **Do lead às chaves** | Visita → proposta → documentação → contrato → comissão, com checklists, prazos e PDFs |
| **Compliance embutido** | CRECI nas saídas, trilha COAF, LGPD por titular e retenção legal |

### 1.3 Público e personas

| Persona | O que precisa | Papel no sistema |
|---|---|---|
| **Dono/diretor da imobiliária** | VGV, conversão, custo por lead por portal, produtividade por corretor | `admin` |
| **Gerente de vendas/locação** | Distribuir leads, cobrar SLA, ver a equipe, aprovar propostas | `manager` com escopo de equipe (novo) |
| **Corretor** | Leads do dia, agenda de visitas, imóveis para enviar, app no celular | `agent` |
| **Captador** | Proprietários, avaliações, autorizações, fotos | `agent` com papel de captação |
| **Corretor parceiro / imobiliária parceira** | Ver só os leads e as unidades compartilhados | papel externo (fase 5) |
| **Proprietário / inquilino** | Status do imóvel, extrato, boletos | portal externo (fase 5) |
| **Agente de IA** | Estoque, agenda, funil e regras de promessa | `ai_operator` (já existe) |

**Segmentos atendidos**, na ordem recomendada:

1. Imobiliária de venda e locação de usados (maior volume).
2. Corretor autônomo.
3. Incorporadora ou imobiliária de lançamentos.
4. Administradora de locação.

---

## 2. Decisão de arquitetura

### 2.1 As três opções

| Opção | Como é | Prós | Contras |
|---|---|---|---|
| **A. Hard fork** | Reescrever o núcleo para imobiliário e parar de acompanhar o upstream | Liberdade total | Perde as correções de segurança, WAHA e IA do upstream (~2 versões/dia). Todo o harness (1.500 testes, CI e kit) vira custo exclusivo seu |
| **B. Extensão declarativa** | Pacote JSON no catálogo de extensões | Zero conflito | **Impossível.** Extensão não cria tabela, tela, menu nem ferramenta de IA (`docs/doctrine/extensoes.md`) |
| **C. Fork vivo + módulo oficial `imobiliario` + ganchos genéricos no núcleo** ⭐ | O domínio imobiliário mora em pastas e funções próprias, com tabelas criadas pela função provisionadora da ADR-0002. As melhorias genéricas (roleta de lead, gatilho recorrente, equipes) entram no núcleo e podem ser devolvidas ao upstream | Recebe tudo do upstream com `git merge`. O conflito fica confinado. Segue a doutrina | Exige disciplina de pastas e numeração de migrations |

### 2.2 Recomendação: opção C

Ela entrega um produto **100% imobiliário para o usuário final**: marca própria, menu, onboarding,
vocabulário e agente são todos imobiliários. Ao mesmo tempo, **preserva o motor** que o upstream
continua melhorando de graça.

**Regras de isolamento:**

| Camada | Onde mora o código imobiliário |
|---|---|
| Domínio (TS puro) | `lib/imobiliario/**` (imóveis, match, financiamento, comissão, portais, locação) |
| Telas | `app/app/imoveis/**`, `app/app/captacao/**`, `app/app/lancamentos/**`, `app/app/locacao/**`, `app/app/propostas/**`, `app/app/contratos/**` |
| Componentes | `components/imobiliario/**` |
| API | `app/api/v1/imoveis/**`, `app/api/v1/portais/**` etc. |
| Ferramentas de IA | `lib/mcp/tools/imoveis.ts` + `lib/mcp/tools/catalogo/imoveis.ts`, marcadas com `modulo: "imobiliario"` |
| Schema | uma função `public.fn_imobiliario_provisionar()` (ADR-0002, D2–D8), entregue pela tripla migration + apêndice + MANIFEST |
| Liga/desliga | `lib/instalacao/modulos.ts` ganha `imobiliario`. Na **distribuição re9**, o kit instala o módulo por padrão |
| Testes | `tests/unit/imobiliario/**`, `tests/invariants/imobiliario-*.test.ts`, `tests/e2e/imob-*.spec.ts` |

**Ganchos genéricos no núcleo** (úteis a qualquer nicho; candidatos a PR no upstream para reduzir
a divergência):

- Roleta de **lead** com pool, critérios e SLA com repasse.
- **Equipes** (`teams`) e escopo de gerente por equipe.
- **Gatilho de data recorrente** (mensal/anual) e **condições numéricas** nas automações.
- **Filtro de campanha por campo personalizado.**
- **Página pública de agendamento** (já prevista no vocabulário como `public_page`).
- **`vocabulary` aplicado em toda a interface.**
- **Repositório de documentos** com bucket privado, classificação e retenção legal.
- **Normalizadores de captação** para Meta Lead Ads e Google Lead Forms.
- **Envio de vídeo, arquivo e localização** pelo agente, dentro da cadeia de guardrails.
- **Validação de tipo dos campos personalizados** (hoje só a presença é cobrada).

### 2.3 Infraestrutura do fork (épico E0)

1. Adicionar o remoto `upstream` e merge semanal de `upstream/main` (nunca rebase), com a skill
   `deskcomm-contribuir` para medir antes.
2. **Numeração de migrations.** Reservar uma faixa própria para o fork, por exemplo slug com prefixo
   `imob_` e NNNN acima de 5000, e ajustar `scripts/migration-populacao.sh` e o guarda de colisão
   para medir contra o próprio fork **e** contra o upstream.
3. **Imagens e kit.** Trocar `IMG_NS` em `hostgator-setup-kit/_common.sh`, as referências
   `github.com/melgarafael/...` em `install.sh`, `comecar.sh` e `docker-compose.prod.yml`, e ajustar
   `tests/unit/namespace-das-imagens.test.ts`. Tornar públicos os pacotes GHCR do fork.
4. **Versão.** Adotar uma linha própria sem hífen (o kit descarta prerelease com `-`), por exemplo
   `2.x` própria que registre a base do upstream no changelog. O `release.yml` hoje só corta tag
   no repositório do upstream e precisa ser ajustado.
5. **Branch protection** com os mesmos cinco checks obrigatórios.
6. **Marca própria** por banco (`/admin/marca`): nome, logo e cor. **Nenhuma marca no código**
   (`tests/unit/branding.test.ts`).

### 2.4 Escolhas técnicas centrais

| Tema | Escolha | Por quê |
|---|---|---|
| Geolocalização | `latitude`/`longitude` `numeric(9,6)` + índice + função haversine em SQL. PostGIS fica como evolução opcional | PostGIS exige mudança de imagem e de kit. Busca por raio e por caixa resolve 95% dos casos |
| Busca de imóveis | Híbrida: filtros SQL tipados + `pg_trgm` (texto) + `vector(1536)` (semântica, no padrão de `fn_buscar_trechos_das_fontes`) | "2 quartos até 400 mil perto do metrô com varanda" mistura filtro duro e intenção |
| Mapa | MapLibre GL com tiles OpenStreetMap (sem chave) e geocodificação por CEP (ViaCEP/BrasilAPI) + Nominatim, com cache | Self-host sem custo por chamada. Google Maps fica opcional com chave do cliente |
| Fotos | Bucket novo `property-media`. **Público** para as fotos marcadas como publicáveis (vitrine, portais e SEO precisam de URL estável) e privado para documentos e fotos internas | Portal exige URL pública de foto. Hoje `catalog-photos` assina por 1 hora |
| Documentos | Bucket privado `documents` + tabela `documents` genérica (gancho de núcleo) | Contrato, RG, renda e matrícula precisam de LGPD e retenção |
| PDFs | Mesmo motor do PDF de LGPD (`workers/lgpd-export-worker.ts`) | Ficha do imóvel, proposta e extrato do proprietário |
| Índices econômicos | API SGS do Banco Central (IGP-M série 189, IPCA série 433, INCC série 192), buscada por cron e gravada em tabela | Reajuste de aluguel e correção de parcelas de lançamento |
| Cobrança | Adaptador de gateway (Asaas primeiro; Inter, Iugu e Efí depois) para boleto e Pix, com webhook de baixa | Locação e sinal de reserva |
| Assinatura eletrônica | Adaptador (ZapSign, Clicksign, D4Sign) | Contrato de locação, proposta, autorização de venda |

---

## 3. Modelo de domínio

Todas as tabelas levam `organization_id uuid not null references organizations(id) on delete
cascade`, RLS `tenant_isolation_<tabela>_all` (ou policies de visibilidade no molde de
`crm_leads` quando o corretor só deve ver as suas), dinheiro em `_cents` + `currency`, `type` e
`status` como `text` + CHECK, e `created_at`/`updated_at`. Todas nascem dentro de
`fn_imobiliario_provisionar()`.

### 3.1 Diagrama

```
                         ┌────────────────┐
                         │  developments  │ (empreendimento / lançamento)
                         └──────┬─────────┘
                                │ 1:N
                      ┌─────────▼────────┐
                      │ development_     │ (torre / bloco / quadra)
                      │ blocks           │
                      └─────────┬────────┘
                                │ 1:N (unidade = imóvel com development_id)
 contacts ◄──owner──┐  ┌───────▼────────┐  ┌──────────────────┐
 (proprietário)     └──┤   properties   ├──┤ property_media    │ fotos, vídeo, tour, planta
                       │  (imóvel)      │  └──────────────────┘
 auth.users ◄─captador─┤                ├──┤ property_price_history
                       └──┬──────┬──────┘  └──────────────────┘
                          │      │ 1:N
          ┌───────────────┘      └──────────────┐
  ┌───────▼─────────┐                  ┌────────▼────────┐
  │ property_       │ autorização      │ property_keys / │
  │ mandates        │ exclusividade    │ key_movements   │
  └─────────────────┘                  └─────────────────┘

 crm_leads ──1:1──► lead_search_profiles (perfil de busca)       ──► match (CALCULADO, sem tabela)
 crm_leads ──N:N──► properties via crm_lead_links (target_kind='property', link_kind= interesse|enviado|visitado|descartado)
 calendar_appointments ──► properties (visit_details: imóvel, chave, feedback)
 crm_leads ──1:N──► proposals ──1:N──► proposal_events (contraproposta, aceite, recusa)
 proposals ──► contracts (venda | locação) ──► documents / signatures
 contracts(locação) ──► rental_charges (boleto/pix) ──► owner_payouts (repasse)
 crm_leads(ganho) ──► commission_splits (captador, vendedor, gerente, parceiro, imobiliária)
 compliance_records (COAF/PLD) ──► contacts, contracts
```

### 3.2 Tabelas

#### `properties`: o imóvel (e também a unidade de lançamento)

| Grupo | Colunas |
|---|---|
| Identidade | `id`, `code text` (referência interna, único por organização, ex.: `AP1234`), `development_id uuid null`, `block_id uuid null`, `unit_label text null` (ex.: "Apto 1203") |
| Classificação | `purpose text` CHECK (`sale`,`rent`,`sale_rent`,`season`); `kind text` CHECK (`apartamento`,`casa`,`casa_condominio`,`cobertura`,`kitnet_studio`,`flat`,`terreno`,`lote_condominio`,`sala_comercial`,`loja`,`galpao`,`predio`,`chacara_sitio`,`fazenda`,`outro`); `segment text` (`residencial`,`comercial`,`rural`,`misto`); `stage text` (`pronto`,`na_planta`,`em_construcao`,`lancamento`) |
| Endereço | `cep`, `street`, `number`, `complement`, `neighborhood`, `city`, `state char(2)`, `latitude numeric(9,6)`, `longitude numeric(9,6)`, `address_visibility text` (`exato`,`aproximado`,`so_bairro`), porque o proprietário pode não querer o endereço exato publicado |
| Medidas | `area_private_m2`, `area_total_m2`, `area_land_m2` (numeric), `bedrooms`, `suites`, `bathrooms`, `parking_spaces`, `floor`, `total_floors`, `year_built` |
| Valores | `sale_price_cents`, `rent_price_cents`, `condo_fee_cents`, `iptu_cents` + `iptu_period` (`mensal`,`anual`), `currency`, `price_on_request bool` |
| Condições | `accepts_financing`, `accepts_fgts`, `mcmv_eligible`, `accepts_exchange` (permuta), `rent_guarantees text[]` (`fiador`,`seguro_fianca`,`caucao`,`titulo_capitalizacao`,`sem_garantia`) |
| Características | `features text[]` com vocabulário controlado no TS (`piscina`,`churrasqueira`,`varanda_gourmet`,`portaria_24h`,`elevador`,`academia`,`pet_friendly`,`mobiliado`,`ar_condicionado`, …), mais índice GIN |
| Documentação | `registry_number` (matrícula), `registry_office` (cartório), `iptu_registration` (inscrição), `habite_se bool`, `documentation_status text` (`regular`,`pendente`,`irregular`) |
| Estado | `status text` CHECK (`draft`,`available`,`reserved`,`proposal`,`sold`,`rented`,`suspended`,`archived`), `status_changed_at`, `published bool`, `featured bool` |
| Pessoas | `owner_contact_id → contacts` (principal; coproprietários em `property_owners`), `captured_by_user_id → auth.users`, `responsible_user_id` |
| Conteúdo | `title`, `description` (pode ser gerada pela IA), `internal_notes`, `video_url`, `tour_url` (Matterport/360), `embedding vector(1536)` |
| Rastreio | `source` (`manual`,`importacao`,`portal`,`ia_captacao`), `external_ids jsonb` (código no ERP e em cada portal, com esquema Zod central) |

**Índices:**

- `(organization_id, status, purpose, kind)`
- `(organization_id, city, neighborhood)`
- `(organization_id, sale_price_cents)` e `(organization_id, rent_price_cents)`
- GIN em `features`
- trigram em `title`/`neighborhood`
- `ivfflat` em `embedding`
- `(latitude, longitude)`

#### Tabelas satélites

| Tabela | Para quê | Pontos-chave |
|---|---|---|
| `property_owners` | Coproprietários | `property_id`, `contact_id`, `share_percent`, `is_primary`. Reusa `contacts` (DIRC: Referenciar) |
| `property_media` | Fotos, vídeos, plantas, tour | `kind` (`photo`,`video`,`floorplan`,`tour`,`document_public`), `storage_path`, `position numeric` (fractional indexing, igual ao kanban), `is_cover`, `publishable`, `caption`, `ai_description` (gerada pelo `media-derive`). Sem o limite de 5 fotos: portal pede 20 a 50 |
| `property_price_history` | Histórico de preço | Alimenta o gatilho "queda de preço" e a análise de tempo de mercado. Append-only |
| `property_mandates` | Autorização de venda/locação | `kind` (`exclusiva`,`aberta`), `starts_at`, `ends_at`, `commission_percent`, `document_id`, `signed_at`. Alerta de vencimento |
| `property_keys` / `key_movements` | Controle de chaves | Onde está a chave (imobiliária, portaria, proprietário, corretor), retirada, devolução, quem e quando. Vinculado à visita |
| `developments` | Empreendimento | Nome, incorporadora (`developer_contact_id`), endereço, `stage`, previsão de entrega, `registro_incorporacao` (RI), memorial, tabela de preços vigente, VGV previsto, links de book/decorado |
| `development_blocks` | Torre / bloco / quadra | Nome, número de andares, unidades por andar. Alimenta o **espelho de vendas** |
| `development_price_tables` | Tabela de preços e condições | Versionada por ponteiro, igual a `promise_table_versions`: entrada, mensais, intermediárias, chaves, índice de correção (INCC antes das chaves, IPCA/IGP-M depois) |
| `unit_reservations` | Reserva de unidade | `lead_id`, `property_id`, `expires_at` (reserva expira sozinha por cron), `broker_user_id`, `partner_org_label`. **Constraint:** uma reserva ativa por unidade |
| `lead_search_profiles` | Perfil de busca do lead | `lead_id` (1:1), `purpose`, `kinds[]`, `cities[]`, `neighborhoods[]`, `center_lat/lng` + `radius_km`, `price_min/max_cents`, `bedrooms_min`, `suites_min`, `parking_min`, `area_min`, `features_must[]`, `features_nice[]`, `financing` (`a_vista`,`financiamento`,`fgts`,`consorcio`,`permuta`), `income_monthly_cents`, `down_payment_cents`, `move_deadline`, `free_text`, `embedding`. Colunas tipadas, porque o match é SQL |
| `visit_details` | Complemento da visita | `appointment_id → calendar_appointments` (1:1), `property_id`, `key_movement_id`, `checkin_at`, `checkin_lat/lng`, `feedback_score` 1-5, `feedback_likes`, `feedback_dislikes`, `next_step`. **A agenda existente é reaproveitada inteira** |
| `proposals` | Proposta | `lead_id`, `property_id`, `buyer_contact_id`, `amount_cents`, `payment_terms jsonb` (esquema Zod: sinal, financiamento, FGTS, permuta, parcelas), `valid_until`, `status` (`rascunho`,`enviada`,`contraproposta`,`aceita`,`recusada`,`expirada`,`cancelada`), `document_id` (PDF) |
| `proposal_events` | Histórico de negociação | Cada contraproposta é uma linha nova. Nada é sobrescrito |
| `contracts` | Contrato | `kind` (`compra_venda`,`promessa_compra_venda`,`locacao_residencial`,`locacao_comercial`,`administracao`), partes em `contract_parties` (papel: `vendedor`,`comprador`,`locador`,`locatario`,`fiador`,`conjuge`,`procurador`), datas, valores, `guarantee_kind`, `adjustment_index` (`IGPM`,`IPCA`,`INCC`), `adjustment_month`, `status`, `retention_until` (retenção legal) |
| `rental_charges` | Cobrança mensal | Competência, aluguel + condomínio + IPTU + encargos, desconto de pontualidade, multa e juros, `gateway_charge_id`, `status` (`aberta`,`paga`,`atrasada`,`cancelada`) |
| `owner_payouts` | Repasse ao proprietário | Competência, valor bruto, taxa de administração, retenções (IR quando aplicável), líquido, integração com `financial_entries` |
| `commission_splits` | Rateio de comissão | `lead_id`/`contract_id`, `beneficiary_kind` (`user`,`parceiro`,`imobiliaria`), `beneficiary_user_id`, `role` (`captador`,`vendedor`,`gerente`,`parceiro`,`plantao`), `percent`, `amount_cents`, `status`, `reverses_split_id` (estorno por contra-lançamento, herdando o invariante do financeiro) |
| `commission_policies` | Regras padrão | Ex.: venda de usado = 6% total, sendo 40% captação e 60% venda; lançamento = 4%. Por organização, versionado |
| `portal_integrations` | Portal configurado | `portal` (`grupo_olx`,`imovelweb`,`chaves_na_mao`,`casa_mineira`,`wimoveis`,`meta_catalog`,…), `feed_token` (hash), credenciais em `ai_provider_credentials`-like/`private.app_secrets`, `plan_limits` (destaques contratados), `last_feed_at`, `last_error` |
| `portal_listings` | Publicação por portal | `property_id`, `portal`, `highlight_level` (`simples`,`destaque`,`super_destaque`), `status`, `external_listing_id`, `leads_count`, `views` (quando o portal devolver) |
| `economic_indices` | Índices | Série, competência, valor. Sem `organization_id` (dado público; RLS só leitura) |
| `compliance_records` | PLD/COAF | `contact_id`, `contract_id`, `kind` (`cadastro_pld`,`operacao_registrada`,`comunicacao_coaf`,`declaracao_nao_ocorrencia`), `pep bool`, `beneficial_owner`, `amount_cents`, `cash_amount_cents`, `reported_at`, `coaf_protocol`. **Acesso restrito ao papel `compliance`**, porque a lei proíbe dar ciência ao cliente e o gerente comum não deve ver |

**Mudanças no núcleo (ganchos genéricos):**

- `crm_lead_links.target_kind` passa a aceitar `property`, `proposal` e `contract`. É forward-fix
  da constraint, num bloco único no apêndice.
- `teams` + `team_members` + `teams.manager_user_id`, com o escopo `visibility_mode = 'team'`
  aplicado por RLS a leads e conversas.
- `user_organizations.creci text` + `creci_uf` (corretor) e `organizations.creci_pj` (imobiliária).
- `documents` (genérica): `owner_kind`/`owner_id` padronizado (anti-pattern 8), `category`,
  `sensitivity` (`publico`,`interno`,`pessoal`,`sensivel`), `retention_basis`
  (`consentimento`,`contrato`,`obrigacao_legal`), `retention_until`, `storage_path`.
- A cascata de LGPD (`fn_lgpd_cascade_redact_contact`) passa a respeitar `retention_until`: o
  contato vinculado a contrato vigente ou em prazo legal é **pseudonimizado no que é possível e
  mantido no que a lei exige**, com registro do motivo. A ADR-0002 D8 cobre o alcance dinâmico
  das tabelas do módulo.

### 3.3 Match: calculado, nunca sincronizado

`fn_imobiliario_match(org, lead_id | property_id, limite)` é SQL puro, sem coluna sincronizada
(DIRC: Calcular). Ele funciona em três etapas:

1. **Filtro duro:** finalidade, tipo, cidade/bairro ou raio, preço com tolerância configurável
   (±10%), quartos ≥ mínimo, e `status = available`.
2. **Pontuação** de 0 a 100:
   - preço dentro da faixa: 30
   - localização (bairro exato 25, bairro vizinho ou raio 15)
   - quartos/suítes/vagas: 15
   - características obrigatórias: 15
   - características desejáveis: 5
   - similaridade semântica do `free_text` com a descrição (embedding): 10
3. **Explicação:** cada ponto vem com o motivo em texto ("dentro do orçamento", "falta 1 vaga"),
   para o corretor e para a IA. É o mesmo princípio do `ScoreSlot` do kanban: número com evidência.

Os consumidores são a tela de Match, a ferramenta de IA `crm_match_properties`, o gatilho
"imóvel compatível" e a campanha segmentada.

---

## 4. O agente de IA imobiliário

### 4.1 Ferramentas novas (catálogo MCP, `modulo: "imobiliario"`)

| Ferramenta | Pacote | Risco | O que faz |
|---|---|---|---|
| `crm_search_properties` | vender | baixo | Busca híbrida com filtros + texto livre. Devolve até 5 imóveis com código, resumo, preço e link. Tem `motivoDoVazio` ("nenhum imóvel até 400 mil na zona sul; o mais próximo custa 430 mil") |
| `crm_get_property` | vender | baixo | Ficha completa de um imóvel (sem o endereço exato se `address_visibility` proibir) |
| `crm_match_properties` | vender | baixo | Imóveis compatíveis com o perfil do lead, com a explicação |
| `crm_save_search_profile` | vender | baixo | Grava ou atualiza o perfil de busca estruturado, com validação Zod |
| `crm_simulate_financing` | vender | baixo | Cálculo **determinístico** SAC e PRICE: entrada, prazo, taxa de referência, renda mínima (comprometimento ≤ 30%), faixa MCMV. Tabela de taxas e faixas **versionada e editável pela imobiliária**. Sempre devolve o aviso "simulação, sujeita à análise de crédito" |
| `crm_book_visit` | atender | médio | Encapsula `crm_find_and_book_appointment` com `category='visita'`, o imóvel, o endereço preenchido, o corretor responsável pelo imóvel/região e o registro da chave |
| `crm_register_visit_feedback` | reter | baixo | Ficha pós-visita coletada na conversa |
| `crm_create_proposal_draft` | vender | **crítico** | Rascunho de proposta que **sempre** precisa de aprovação humana (padrão de `crm_propose_reactivation`) |
| `crm_create_property_draft` | atender | médio | Agente de captação: proprietário descreve o imóvel e as fotos chegam pelo WhatsApp. Cria um rascunho (`status='draft'`) para o captador revisar |
| `crm_list_developments` / `crm_get_unit_availability` | vender | baixo | Lançamentos: tipologias, unidades disponíveis e tabela vigente |

**Envio de mídia imobiliária.** Generalizar `send_message.produto_codigo` para
`send_message.imovel_codigo`. Isso envia foto de capa + 4 fotos, card com resumo, link da vitrine
e, se houver, vídeo (`sendVideo`), book em PDF (`sendFile`) e pino de localização aproximada.
**Tudo passa pela cadeia `runBeforeSend`** (pacing, janela, disclosure). Nenhuma rota de envio
fica fora dos guardrails.

### 4.2 Qualificação imobiliária

- Estender o `update_lead_state` para aceitar, além de BANT, um bloco `imobiliario`:
  - `finalidade`
  - `forma_pagamento`
  - `renda_faixa`
  - `entrada_faixa`
  - `usa_fgts`
  - `prazo_mudanca`
  - `ja_visitou_outros`
  - `tem_imovel_para_vender` (gatilho de permuta e de captação)
- Guardar tudo em `lead_search_profiles` com validação estrita.
- **LGPD.** Renda é pedida em **faixa**, nunca número exato no primeiro contato. Documentos só são
  pedidos no estágio de proposta, com aviso de finalidade. Isso ajusta a regra de
  `lib/agent-engine/playbooks/platform.md:29` com uma exceção declarada por base legal
  (`guardrails/lgpd/legal-basis.ts`).

### 4.3 Guardrails novos

| Gate | Veta |
|---|---|
| `financing_promise` | "Seu financiamento está aprovado", "taxa garantida", "com certeza você consegue". Estende `guardrails/promise/engine.ts` |
| `price_negotiation` | A IA oferecer desconto sobre imóvel de terceiro sem regra da tabela de promessas (piso de negociação por imóvel, definido pelo proprietário e opcional) |
| `address_privacy` | Enviar endereço exato quando `address_visibility` não permite (segurança do proprietário) |
| `creci_disclosure` | Primeira mensagem de uma conversa nova e todo material de divulgação levam a identificação e o CRECI da imobiliária (template de disclosure já existente, `disclosure_template_*`) |
| `availability_truth` | Oferecer imóvel com `status` diferente de `available` (a busca já filtra, e o gate é a segunda linha) |

### 4.4 Agentes e roteador prontos (kit do onboarding)

| Agente | Função | Ferramentas |
|---|---|---|
| **Atendimento de Vendas** | Lead de compra: qualifica, busca, envia, agenda visita | search, match, get_property, simulate_financing, book_visit, save_search_profile |
| **Atendimento de Locação** | Lead de aluguel: garantias, documentos, visita, pré-análise | search, book_visit, save_search_profile + FAQ de garantias |
| **Captação** | Proprietário que quer anunciar: coleta dados, fotos e agenda avaliação | create_property_draft, book_visit (`vistoria`) |
| **Lançamentos** | Interessado em empreendimento: tipologias, tabela, decorado | list_developments, unit_availability, book_visit |
| **Pós-visita / reengajamento** | Ficha pós-visita, reativação por match | register_visit_feedback, match |

O **roteador** (`ai_routers`) tem as intenções:

- *comprar*
- *alugar*
- *anunciar/vender meu imóvel*
- *lançamento/planta*
- *sou inquilino/proprietário* (humano ou administração)

**Skills** (texto de nicho que entra quando o matcher casa):

- `qualificacao-imobiliaria`
- `objecao-preco-imovel`
- `financiamento-e-fgts`
- `documentos-locacao`
- `garantias-locaticias`
- `visita-e-chaves`
- `permuta`
- `mcmv`

**Base de conhecimento semente:** FAQ de taxas (ITBI, escritura, registro, avaliação bancária),
documentos por tipo de negócio, garantias e bairros atendidos.

### 4.5 Follow-ups imobiliários

Criar `lib/followup/modelos/imobiliaria.ts` e incluir o nicho em `NICHOS_DE_MODELO`.

| Cadência | Gatilho | Passos |
|---|---|---|
| Lead de portal sem resposta | `lead_created` + `silence` | 5 min (IA), 2 h, 24 h com imóveis similares, 72 h última tentativa |
| Perfil definido, sem visita | `stage_change` → "Sei o que oferecer" + `silence` 48 h | Nova seleção via match |
| Pós-visita | `appointment.completed` | 2 h: "o que achou?" (ficha); 48 h: alternativas se não gostou |
| No-show de visita | `appointment.no_show` | Reagendamento (usa `fn_appointment_recover`) |
| Proposta parada | `stage_change` → "Proposta" + `silence` 72 h | Corretor recebe tarefa, não a IA |
| Locação: vencimento de contrato | recorrente, anual −90 d | Renovar ou desocupar |
| Reengajamento | evento `imovel.compativel` | Proposta de contato com aprovação humana |

---

## 5. Épicos

Cada épico traz entregas, reaproveitamento, critérios de aceite e o destino (DoD 18).

### E0 — Fundação do fork · *infraestrutura*

- **Entregas:** remoto upstream com rotina de merge, faixa de migrations, namespace de imagens,
  versão própria, CI com os 5 checks, marca própria.
- **Aceite:** instalação fresca numa VPS com `install.sh` do fork puxando as imagens do fork; um
  merge de `upstream/main` sem conflito em migration.

### E1 — Kit imobiliário e vocabulário · *núcleo (ganchos) + módulo (conteúdo)* ⚡ entrega rápida

- **Onboarding.** O passo "Seu negócio" ganha a escolha explícita de segmento: *Imobiliária
  (venda e locação)*, *Corretor autônomo*, *Lançamentos/incorporadora*, *Administradora de
  locação*. Um kit aplica de uma vez (`app/actions/onboarding/montarQuadro.ts` passa a gravar tudo):
  - **Funis:**
    - **Venda:** Novo lead → Em atendimento → Qualificado → Visita agendada → Visitou → Proposta → Documentação/Financiamento → Vendido | Perdido
    - **Locação:** Novo lead → Em atendimento → Visita agendada → Visitou → Análise cadastral → Contrato → Alugado | Perdido
    - **Captação:** Proprietário novo → Avaliação agendada → Avaliado → Autorização assinada → Fotos/anúncio → Publicado | Não captado
    - **Lançamento:** Interessado → Atendido → Visitou decorado → Simulação → Reserva → Contrato → Vendido | Perdido
  - **Vocabulário:** lead = Cliente/Interessado, deal = Negócio, won = Vendido/Alugado/Captado, lost = Perdido.
  - **Motivos de perda** com categoria: crédito negado, comprou com outro corretor, desistiu da
    compra, preço acima, localização, imóvel vendido/alugado, sem retorno, cadastro reprovado.
  - **Motivos de ganho** e **campos obrigatórios por etapa** (ex.: valor e imóvel ao entrar em "Proposta").
  - **Tipos de agenda:** Visita, Vistoria de entrada/saída, Avaliação, Assinatura, Plantão.
  - **Agentes, roteador, skills, follow-ups e FAQ** da §4.
  - **Preset de menu** (`interface_settings`) que esconde Comandas, Faturamento de comanda,
    Produtos, Prospecção B2B e Nuvemshop.
- **Vocabulário aplicado em toda a interface:** hook `useVocabulario(pipelineId)` em
  `NewLeadDialog`, `pipelines/[id]/_client.tsx`, `CRMSidePanel`, `LeadDossier`, `LoseLeadDialog`.
  Também troca os textos de outro nicho ("paciente", "combo presente").
- **Reaproveita:** `lib/onboarding/pacotes-de-funil.ts`, `sugerir-funil.ts`,
  `lib/navigation/interface.ts`, `lib/agenda/tipos.ts`, `createDefaultAgent.ts`,
  `.agents/skills/deskcomm-cliente-novo/references/nichos.md`.
- **Aceite:** um leigo instala, escolhe "Imobiliária" e, sem configurar nada, tem os 3 funis, o
  agente respondendo "procuro 2 quartos até 400 mil" e a agenda com "Visita". Provado por
  Playwright em ambiente fresco (P0 da doutrina de QA).

### E2 — Cadastro de imóveis · *módulo*

- **Telas:**
  - `/app/imoveis` em lista, grade (card com foto, preço e bairro) e **mapa**, com filtros laterais.
  - Ficha do imóvel com abas: Dados, Fotos e mídia, Proprietários, Interessados (via
    `crm_lead_links`), Visitas, Propostas, Documentos, Histórico.
  - Formulário por etapas com **CEP → endereço automático** e pin no mapa ajustável.
- **Fotos:**
  - Upload em lote com arrastar e reordenar.
  - Compressão no cliente e marca d'água opcional com o logo.
  - **Descrição automática da foto pela IA** (`media-derive`).
  - **Texto do anúncio gerado pela IA** a partir dos dados, em tom configurável, sempre como
    rascunho editável.
- **Importação:**
  - CSV/planilha (reusa `lib/catalogo/planilha.ts`).
  - **XML VRSync** (o mesmo formato que o ERP atual já exporta para os portais). É o caminho de
    migração de quem usa Vista, Jetimob ou Kenlo.
  - A importação é idempotente por `external_ids`.
- **Ponte provisória:** para quem não quer migrar, a IA consulta o ERP pelo módulo `banco_externo`.
- **Aceite:** cadastrar um imóvel com 20 fotos pelo celular em menos de 5 minutos; importar um XML
  de 500 imóveis sem duplicar ao reimportar; RLS com 2 organizações.

### E3 — Captação e proprietários · *módulo*

- Funil de captação no kanban, com o proprietário como contato e o imóvel como rascunho.
- **Avaliação (ACM, análise comparativa de mercado):** comparáveis do próprio estoque e das vendas
  registradas (mesmo bairro, tipo e faixa de área), com preço/m² médio, mediana e sugestão de
  faixa. Gera um PDF de avaliação com a marca da imobiliária.
- **Autorização de venda/locação** (`property_mandates`): modelo de documento, assinatura
  eletrônica, alerta de vencimento em 30/15/5 dias, renovação.
- **Agente de captação** (§4.4) e captação pela IA com fotos recebidas no WhatsApp.
- **Aceite:** um proprietário manda "quero anunciar meu apartamento" e, ao fim, existe um imóvel em
  rascunho com as fotos da conversa e uma avaliação agendada para o captador da região.

### E4 — Perfil de busca e match · *módulo*

- Aba **Perfil de busca** no dossiê do lead e no painel lateral do inbox (`CRMSidePanel`).
- Tela **Match**, com duas visões: imóvel → leads compatíveis ("quem avisar") e lead → imóveis.
  Mostra a pontuação com os motivos.
- **Gatilho `imovel.compativel`:** um trigger em `properties` (novo imóvel, redução de preço,
  retorno para `available`) grava no `event_log`, porque trigger nunca faz HTTP. Um worker roda o
  match e gera uma **proposta de reengajamento** na Central (aprovação humana, com pacing) ou uma
  audiência de campanha.
- **Aceite:** cadastrar um imóvel compatível com 3 perfis gera 3 propostas de contato em menos de
  1 minuto, cada uma com a explicação.

### E5 — Agente de IA imobiliário · *módulo + núcleo (envio de mídia)*

- Ferramentas, qualificação, guardrails, agentes, skills e follow-ups da §4.
- **Prova em par** (`docs/doctrine/prova-em-par.md`): cada caso de aceite mede a tela pelo agente
  **e** a ferramenta chamada direto com o mesmo texto.
- **Corpus de avaliação** com 50 conversas reais anonimizadas: "procuro 2 quartos até 400 mil na
  zona sul", "quero alugar com pet", "aceita FGTS?", "tem como baixar o preço?", "posso visitar
  sábado?", "tenho um terreno para vender"…
- **Aceite:**
  - Tempo da primeira resposta menor que 60 s.
  - 100% das respostas com imóvel real do estoque (zero alucinação de imóvel).
  - Zero promessa de financiamento aprovado.
  - Visita agendada na agenda do corretor certo com o endereço do imóvel.

### E6 — Visitas · *módulo sobre a agenda do núcleo*

- **Agendar a partir do imóvel ou do lead:** endereço preenchido, corretor sugerido (responsável
  pelo imóvel, pela região ou pela roleta) e verificação de conflito.
- **Roteiro do dia:** várias visitas em sequência com link de rota (Google Maps/Waze).
- **Chaves:** retirar, devolver, "chave com o porteiro", alerta de chave não devolvida em 24 h.
- **Confirmação D-1 e 2 h antes** (lembretes da agenda) com os botões "confirmo" / "remarcar".
- **Check-in pelo celular** com geolocalização e **ficha pós-visita** (nota, gostou, não gostou,
  próximo passo), que alimenta o perfil de busca.
- **Página pública de agendamento de visita** por imóvel (gancho de núcleo `public_page`).
- **Aceite:** visita marcada pela IA aparece na agenda do corretor e no Google Calendar dele,
  confirmação chega em D-1, e o check-in e a ficha pós-visita atualizam o funil para "Visitou".

### E7 — Portais e captação de leads · *módulo + núcleo (Meta/Google)*

- **Entrada de leads:**
  - Normalizadores no webhook de entrada (`app/api/v1/webhooks/in/[token]`, padrão
    `lib/webhooks/respondi.ts`): **Grupo OLX (ZAP, VivaReal, OLX)**, Imovelweb, Chaves na Mão,
    Casa Mineira e 123i.
  - O código do anúncio vira vínculo lead↔imóvel automático.
  - Portais que só mandam e-mail: caixa de entrada de e-mail com parser por portal (fase 2).
- **Meta Lead Ads e Google Lead Forms nativos** (gancho de núcleo): assinatura `leadgen` e busca
  do lead pela Graph API, reusando `lib/plataformas-de-anuncio/credenciais.ts`.
- **Saída (feed XML):**
  - `GET /api/v1/feeds/[token]/{vrsync,imovelweb,chavesnamao}.xml`, com token no caminho, cache e
    rate limit.
  - Seleção de quais imóveis vão para cada portal e com que nível de destaque, respeitando o
    limite do plano contratado.
  - Validador do feed na tela, com erros por imóvel (foto faltando, CEP inválido).
- **Atribuição:** custo por portal (manual, mensal) → CPL, taxa de visita e venda por portal.
- **Aceite:** um lead de teste do Grupo OLX cria o lead já vinculado ao imóvel, com responsável
  pela roleta, e a IA responde em menos de 60 s. O feed passa no validador do portal.

> Os formatos e os endpoints de cada portal mudam. Antes de implementar, **validar a
> documentação atual** de cada um (ex.: VRSync e integração de leads do Grupo OLX) e registrar a
> versão usada.

### E8 — Distribuição de leads e equipes · *núcleo (genérico)*

- **Equipes e filiais** (`teams`): o gerente vê só a sua equipe (`visibility_mode='team'` por RLS).
- **Roleta de lead** (não só de conversa), com critérios de elegibilidade:
  - finalidade (venda/locação)
  - região/bairro
  - faixa de preço
  - empreendimento
  - portal de origem
  - idioma
- **Pesos** (corretor sênior recebe mais leads) e **escala de plantão** por data e local (estande,
  loja, sábado).
- **SLA com repasse:** o corretor não respondeu em N minutos, o lead passa ao próximo. O evento é
  auditado e aparece na Central.
- **Captador × vendedor:** um papel secundário no lead (`crm_lead_roles`), usado na comissão.
- **Reaproveita:** `lib/routing/decide.ts`, `eligibles.ts`, `eligibility.ts`,
  `attendant_availability`.
- **Aceite:** 20 leads de portal distribuídos entre 4 corretores segundo as regras, sem duplicar
  (idempotência). Um corretor ausente não recebe, e o SLA estourado repassa e registra.

### E9 — Propostas e negociação · *módulo*

- Criar a proposta no dossiê com formas de pagamento estruturadas: sinal, financiamento, FGTS,
  permuta, parcelas.
- PDF com a marca e envio pelo WhatsApp.
- Contraproposta encadeada (`proposal_events`), validade com expiração automática.
- **Aprovação do proprietário** por link (fase 2) ou registro do corretor.
- Ao aceitar: o imóvel vai para `proposal`/`reserved`, os outros interessados são avisados
  (opcional) e é aberta uma tarefa de documentação.
- **Aceite:** o histórico completo de uma negociação com 3 contrapropostas fica visível na
  timeline, e o status do imóvel muda sozinho.

### E10 — Contratos e documentação · *núcleo (documentos) + módulo (contratos)*

- **Checklist de documentos** por tipo de negócio e papel (comprador PF/PJ, vendedor, locatário,
  fiador). Cada item tem status: pendente, recebido, aprovado, recusado. Documentos que chegam pelo
  WhatsApp são classificados pela IA (**"isto parece um RG"**) e anexados com um clique.
- **Certidões do vendedor/imóvel** (due diligence) como itens de checklist com validade.
- **Modelos de contrato** com variáveis (partes, imóvel, valores, garantias), gerando PDF.
- **Assinatura eletrônica** por adaptador (ZapSign, Clicksign, D4Sign), com webhook de assinado.
- **Retenção legal:** documentos de contrato recebem `retention_until` e não são apagados por
  redact antes do prazo. O titular recebe essa explicação no atendimento LGPD.
- **Aceite:** um contrato de locação gerado, assinado pelas 3 partes e arquivado, com os documentos
  protegidos (bucket privado, URL assinada, auditoria de cada download).

### E11 — Comissões · *módulo, com livro-caixa do núcleo*

- Políticas de comissão por organização (venda, locação, lançamento, parceria).
- **Rateio automático** ao ganhar um negócio: imobiliária, captador, vendedor, gerente, parceiro,
  plantão.
- Ajuste manual auditado. Estorno por contra-lançamento. Integração com `financial_entries`
  (a pagar/a receber).
- **Extrato do corretor** (o que tem a receber, recebido e previsto) e relatório para nota fiscal
  ou RPA.
- **Aceite:** uma venda de R$ 500 mil a 6% gera os splits corretos segundo a política, e um
  distrato estorna todos.

### E12 — Lançamentos e incorporação · *módulo*

- Cadastro de empreendimento, torres e unidades, com geração em lote ("torre A, 20 andares, 4 por
  andar, finais 1 a 4 com tipologias X e Y").
- **Espelho de vendas** interativo (grade torre × andar × unidade, cor por status). Atualiza em
  tempo real via Supabase Realtime quando alguém reserva.
- **Tabela de preços versionada** e fluxo de pagamento (entrada, mensais, intermediárias,
  chaves), com correção INCC → IPCA.
- **Reserva com expiração** e fila de espera por unidade.
- **Imobiliárias parceiras e corretores externos** (fase 5: papel externo com escopo).
- **Aceite:** duas pessoas tentando reservar a mesma unidade ao mesmo tempo: só uma consegue
  (constraint + lock). A reserva vencida volta a "disponível" sozinha e avisa o corretor.

### E13 — Locação e administração · *módulo*

- Contrato de locação com garantias (fiador, seguro-fiança, caução, título), índice e mês de
  reajuste.
- **Cobrança mensal** (boleto/Pix via gateway), régua de cobrança pelo WhatsApp (D−3, D0, D+1,
  D+5, D+15) e baixa automática por webhook.
- **Reajuste anual** automático pelo índice do Banco Central, com carta de reajuste enviada ao
  inquilino.
- **Repasse ao proprietário** com taxa de administração e extrato mensal em PDF.
- **Vistorias** de entrada e saída: checklist por cômodo com fotos pelo celular e laudo em PDF.
- **Renovação e desocupação.** **Informe de rendimentos** para o proprietário e dados para a
  **DIMOB**.
- **Chamados de manutenção** do inquilino pelo WhatsApp → caso humano (reusa `agent_cases`).
- **Aceite:** o ciclo de 3 meses simulado (cobrança, pagamento, atraso com multa, repasse,
  reajuste no 12º mês) bate centavo a centavo com uma planilha de referência.

### E14 — Vitrine pública e landing pages · *módulo*

- Site da imobiliária em `/<slug>` (ou domínio próprio resolvido pelo banco):
  - busca com filtros e mapa;
  - página do imóvel com galeria, características, mapa aproximado, simulador de financiamento e
    botão de WhatsApp com **link rastreável** (atribui a origem ao lead,
    `lib/leads/origem-do-site.ts`);
  - formulário de interesse e agendamento de visita.
- **Landing de lançamento** com tipologias, espelho resumido e formulário.
- **SEO:** HTML renderizado no servidor, `schema.org/RealEstateListing`, sitemap, Open Graph por
  imóvel (compartilhamento bonito no WhatsApp), URL amigável.
- **Rate limit** e cliente de serviço filtrando `organization_id` resolvido pelo slug (anti-pattern
  10). A marca vem do banco, e o resolvedor nunca lança erro.
- **Aceite:** a página de imóvel carrega com LCP menor que 2,5 s no 4G, com nota Lighthouse ≥ 90,
  e o lead do formulário cai no funil com origem "site".

### E15 — Compliance · *núcleo (documentos, retenção) + módulo (CRECI, PLD)*

Ver §6.

### E16 — Métricas e BI imobiliário · *módulo*

Ver §7. A tela `/app/metrics` ganha as abas Vendas, Locação, Captação, Portais e Corretores.

### E17 — App do corretor (PWA) · *núcleo (shell móvel) + módulo (conteúdo)*

- Shell móvel com quatro abas:
  - **Hoje:** visitas, tarefas e leads novos.
  - **Leads.**
  - **Imóveis:** busca e envio rápido para o cliente.
  - **Agenda.**
- **Câmera** para as fotos da captação e da vistoria. Check-in com GPS. Notificação push de lead
  novo (reusa `public/notify-sw.js`).
- Instalável: `manifest.ts` com ícones de 192 e 512 px, e modo offline para ficha de imóvel e
  roteiro do dia.
- **Aceite:** um corretor recebe o push, abre o lead, envia 3 imóveis e marca a visita em menos de
  2 minutos, só pelo celular.

### E18 — Portais externos · *fase 5*

- Portal do proprietário (status do imóvel, visitas, propostas, extrato de repasse) e do inquilino
  (boletos, chamados, contrato).
- Exige uma identidade externa fora de `user_organizations`, que é o maior salto de arquitetura:
  magic link por e-mail/WhatsApp e escopo por contrato. Vai para uma ADR própria antes de
  implementar.

---

## 6. Compliance e regulação

> ⚠️ **Validar com assessoria jurídica e contábil** antes de lançar. Normas do COFECI, regras do
> MCMV e layouts de declarações mudam. O sistema deve tratar tudo isso como **configuração
> versionada**, nunca como texto fixo no código.

| Tema | Base | O que o sistema faz |
|---|---|---|
| **CRECI** | Lei 6.530/78 e resoluções do COFECI sobre publicidade | CRECI da imobiliária (PJ) e de cada corretor (PF) no cadastro. Inserido automaticamente no rodapé da vitrine, no feed, no PDF, nas campanhas e no disclosure do agente. Bloqueio de publicação sem CRECI configurado |
| **PLD/COAF** | Lei 9.613/98 e regulamentação do COFECI para o setor | Cadastro do cliente com PEP e beneficiário final. Registro das operações acima do limiar ou com pagamento em espécie. Fila de "operação atípica" para análise. Registro da comunicação ao COAF (Siscoaf) com protocolo. **Declaração anual de não ocorrência.** Guarda por 5 anos. **Papel `compliance`** separado: o registro não aparece para o corretor nem para o cliente |
| **LGPD** | Lei 13.709/18 | Documentos com sensibilidade e base legal. **Retenção legal prevalece sobre eliminação**, com explicação ao titular. Múltiplos titulares por negócio (redact de um fiador não destrói o contrato). Renda em faixa. Consentimento de marketing para reengajamento por match. Relatório de dados por titular (reusa `lgpd_requests` e o export em PDF) |
| **Lei do Inquilinato** | Lei 8.245/91 | Garantias (uma por contrato, como a lei exige), reajuste anual, prazos de notificação, multa proporcional na rescisão (calculadora), vistoria |
| **CDC** | Lei 8.078/90 | Publicidade fiel: o preço do anúncio é igual ao do estoque (feed sempre gerado do cadastro). Proposta com validade clara |
| **DIMOB** | Instrução normativa da Receita Federal | Exportação anual das operações de intermediação e administração |
| **Anti-spam WhatsApp** | Política do WhatsApp + opt-out já existente | Reengajamento por match só com consentimento ou legítimo interesse documentado, respeitando pacing, janela 7h–22h e STOP (já existentes) |

---

## 7. Métricas do negócio imobiliário

| KPI | Definição | Fonte |
|---|---|---|
| **Tempo da 1ª resposta** por origem | Minutos entre a chegada do lead e a 1ª mensagem (IA ou humano) | já existe; segmentar por portal |
| **Taxa lead → visita → proposta → venda** | Funil com semântica fixa (etapas mapeadas por `stage_hint` imobiliário, não pelo nome) | `crm_leads` + `visit_details` + `proposals` |
| **VGV** | Soma do valor de venda: lançado, vendido, em estoque | `properties` + `contracts` |
| **VSO** (vendas sobre oferta) | Unidades vendidas no período ÷ (estoque inicial + lançadas) | lançamentos |
| **Tempo médio de venda/locação** | Do `available` até o `sold`/`rented`, por tipo e bairro | `property_price_history` + status |
| **Captações por captador** e **% exclusivas** | — | `property_mandates` |
| **Preço/m²** anunciado × fechado, por bairro | Insumo do ACM | `properties` + `contracts` |
| **CPL e custo por venda por portal** | Custo do plano ÷ leads e ÷ vendas | `portal_integrations` + origem |
| **Comissão** gerada, a pagar, paga | — | `commission_splits` |
| **Vacância** e **inadimplência** | Imóveis administrados vagos; cobranças em atraso ÷ emitidas | locação |
| **Produtividade do corretor** | Leads, visitas, propostas, vendas, SLA cumprido, nota média das fichas pós-visita | todas |
| **Performance da IA** | % de leads qualificados pela IA, visitas agendadas pela IA, handoffs e motivos | `ai_agent_runs` + casos |

---

## 8. Roadmap faseado

As estimativas são para **1 pessoa sênior + Claude Code**, cumprindo a Definição de Pronto
inteira (testes, invariantes, prova visual, tripla de migration). A ordem prioriza **valor
percebido cedo** e **dependências**.

| Fase | Épicos | Resultado para o cliente | Estimativa |
|---|---|---|---|
| **0 — Fundação** | E0 | Fork instalável com marca própria e atualização a partir do upstream | 1–2 semanas |
| **1 — "Já é imobiliário"** | E1 + ganchos de vocabulário | Onboarding imobiliário, funis, agente de vendas/locação com o estoque via planilha ou ERP (`banco_externo`), follow-ups. **Já vendável** | 2–3 semanas |
| **2 — Estoque e IA de verdade** | E2, E4, E5, E6 (básico), E7 (entrada Grupo OLX + feed VRSync) | Cadastro de imóveis com mapa, match, IA buscando o estoque real e agendando visita, leads do ZAP/VivaReal/OLX e publicação neles | 6–8 semanas |
| **3 — Operação comercial completa** | E8, E3, E9, E10, E11, E17 (básico) | Roleta com SLA, equipes, captação com ACM, propostas, documentos e contratos com assinatura, comissões, app do corretor | 8–10 semanas |
| **4 — Lançamentos e vitrine** | E12, E14, E16, E7 (demais portais, Meta Lead Ads) | Espelho de vendas, site/landing, BI completo | 6–8 semanas |
| **5 — Locação e portais externos** | E13, E15 (PLD completo), E18 | Administração de locação ponta a ponta, portal do proprietário e do inquilino | 8–12 semanas |

**Total:** cerca de 8 a 10 meses para 100% do escopo. As fases 1 e 2 (cerca de 3 meses) já
entregam um produto competitivo contra os CRMs imobiliários do mercado, com o diferencial de IA
nativa e self-host.

---

## 9. Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| Conflito com o upstream (migrations, `baseline.sql`) | Merge semanal vira retrabalho | Código em pastas próprias. Schema na função provisionadora do módulo, com **um** bloco no apêndice. Faixa de numeração própria. Ganchos genéricos devolvidos ao upstream via PR |
| O upstream muda uma API interna usada pelo módulo | Quebra silenciosa | O módulo só usa helpers canônicos (`ok`/`fail`, `requireRole`, `audit`, `createAdminClient`) e tem testes próprios no CI do fork |
| Formato de portal muda | Leads param de entrar | Normalizador com detecção estrita, registro de todo payload em `webhook_lead_captures`, alerta na Central quando um portal para de mandar lead há X horas (laço de retorno do Sistema Vivo) |
| IA alucina imóvel ou promete financiamento | Dano jurídico e de marca | Busca estruturada obrigatória (a IA não "inventa"), gates `availability_truth` e `financing_promise`, corpus de avaliação no CI |
| Custo de IA por organização | Margem | Orçamento por organização já existe (`ai_budgets`), modelo menor para classificação, cache de embeddings |
| Dados sensíveis (documentos) | Incidente LGPD | Bucket privado, URL assinada curta, auditoria de download, classificação de sensibilidade, retenção |
| Cota de armazenamento (Supabase gratuito = 1 GB) | Fotos lotam o banco | Compressão no cliente (WebP, ≤ 300 KB), limite por imóvel configurável e aviso de cota. Recomendar storage S3 compatível na VPS para operações grandes |
| Escopo grande demais | Nunca termina | Fases vendáveis: a fase 1 já é produto. Cada épico tem aceite próprio |

---

## 10. Definição de pronto do vertical

Além dos 18 itens do `CLAUDE.md`, todo épico imobiliário cumpre estes critérios:

1. **Prova pela tela como um corretor leigo**, em ambiente fresco estilo VPS, com o módulo
   instalado **e** sem o módulo (o núcleo continua íntegro). Evidência em `evidence/imob-<épico>/`.
2. **Invariante de isolamento** entre 2 organizações para toda tabela nova, incluindo o feed XML e
   a vitrine pública, que usam cliente de serviço.
3. **Prova em par** para todo caminho que passa pela IA.
4. **Cascata de LGPD** alcançando as tabelas novas que guardam pessoa (ADR-0002 D8).
5. **Laço de retorno declarado:** o que acontece quando dá errado (portal parou, feed com erro,
   reserva expirou, cobrança falhou, chave não devolvida) aparece na Central com próximo passo.
6. **Porta na navegação** (`lib/navigation/catalogo.ts`) com `modulo: "imobiliario"`.
7. **Fragmento em `.changes/`** descrevendo o efeito para quem opera a VPS.

---

## 11. Decisões que dependem do dono do produto

Estas perguntas mudam a ordem ou o escopo. Cada uma traz a recomendação técnica, que vale como
padrão se não houver outra resposta.

| # | Pergunta | Recomendação |
|---|---|---|
| 1 | **Qual segmento vem primeiro?** Imobiliária de usados (venda + locação), lançamentos/incorporadora, ou administradora de locação? | **Imobiliária de usados**: maior volume de clientes e o que mais se beneficia de IA + portais. Lançamentos na fase 4, administração na fase 5 |
| 2 | **Estratégia de fork**: fork vivo acompanhando o upstream (opção C) ou hard fork? | **Fork vivo (C)**: você continua recebendo segurança e melhorias de IA de graça |
| 3 | **O produto continua instalável por qualquer um** (open source, self-host) ou vira SaaS operado por você? | Manter self-host (é o que o código já faz bem) e, se quiser, operar instâncias gerenciadas para clientes. Isso muda a prioridade de billing e multi-organização |
| 4 | **Qual o nome e a marca** do produto imobiliário? | Configurável pelo banco. Basta decidir o nome, a cor e o logo |
| 5 | **Seus clientes já usam um ERP imobiliário** (Vista, Jetimob, Kenlo, Imobzi…)? O Deskcomm substitui ou convive com ele? | Convive na fase 1 (a IA lê o ERP via `banco_externo` ou importação XML) e substitui a partir da fase 2 |
| 6 | **Quais portais seus clientes pagam hoje?** | Grupo OLX (ZAP + VivaReal + OLX) primeiro, porque cobre a maior parte do mercado |
| 7 | **Gateway de cobrança e assinatura eletrônica preferidos?** | Asaas (boleto/Pix) e ZapSign (custo baixo, API simples). Ambos atrás de adaptador trocável |
| 8 | **Há clientes-piloto** para validar a fase 1? | Ter 2 ou 3 imobiliárias piloto desde a fase 1: o corpus de conversas reais define a qualidade do agente |

---

## 12. Apêndice: telas — manter, adaptar e esconder

| Tela atual | Decisão | Nota |
|---|---|---|
| Inbox | **Adaptar** | Painel lateral ganha "Perfil de busca", "Imóveis enviados/de interesse" e "Agendar visita" |
| Radar | Manter | Crítico no ciclo longo |
| Agenda | **Adaptar** | Vira agenda de visitas (imóvel, chave, check-in, roteiro) e perde os textos de clínica |
| Respostas rápidas | Manter | Semear scripts imobiliários |
| Funis (kanban) | **Adaptar** | Card com miniatura, bairro e preço do imóvel principal (troca de faixa, sem crescer). Filtros por finalidade, bairro e faixa |
| Contatos / ficha 360 | **Adaptar** | Abas "Perfil de busca", "Imóveis (proprietário)", "Documentos" |
| Tarefas, Campanhas, Chamadas | Manter | Campanha ganha filtro por perfil de busca |
| Produtos | **Esconder** | Substituído por Imóveis (o código de fotos é reaproveitado) |
| Comandas, Faturamento de comanda, Financeiro de comanda | **Esconder** | Conceitos reaproveitados na comissão |
| Prospecção (Google Maps B2B) | **Esconder** | Opcional para parcerias com construtoras |
| Nuvemshop | **Esconder** | — |
| IA (agentes, roteadores, follow-ups, conhecimento, skills, casos…) | Manter | Com conteúdo imobiliário semeado |
| Conexões, Webhooks, Anúncios Meta, Auditoria, LGPD, Equipe, Configurações, Extensões | Manter | Configurações ganham "Portais", "CRECI e compliance", "Comissões" |
| Desempenho | **Adaptar** | Abas imobiliárias (§7) |
| **Novas** | — | Imóveis, Empreendimentos/Espelho, Captação/ACM, Match, Propostas, Contratos, Comissões, Locação, Portais, Painel do corretor, App móvel, Vitrine pública |
