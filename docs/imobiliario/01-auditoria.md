---
type: audit
project: DeskcommCRM (fork re9 — vertical imobiliário)
status: draft
last_updated: 2026-09-27
audited_against: HEAD 38dd469 (merge da release 1.56.0 do upstream)
confidence: alta para inventário (medido em código); média para estimativas
---

# Auditoria do DeskcommCRM para o mercado imobiliário

> **Este documento é um retrato do código em `38dd469` (27/09/2026), não o estado de hoje.**
> Os números foram medidos nesse commit. Antes de agir sobre qualquer linha, meça de novo com
> os comandos indicados.
> O plano de transformação está em [`02-plano-vertical-imobiliario.md`](02-plano-vertical-imobiliario.md).

## 0. Método

A leitura foi dividida em cinco frentes independentes, cobrindo os 6.278 arquivos versionados:

| Frente | O que foi lido |
|---|---|
| **Banco de dados** | `supabase/baseline.sql` (40.318 linhas), `MANIFEST.md`, migrations e `lib/database.types.ts` |
| **Agentes de IA** | `lib/agent-engine`, `lib/ai`, `lib/mcp`, `workers`, `lib/followup`, onboarding e skills de nicho |
| **Telas e UX** | `app/app/**`, `components/**`, navegação, i18n, onboarding e branding |
| **Integrações e automação** | WAHA/Meta/social, webhooks, automações, campanhas, roteamento, agenda, anúncios, financeiro e extensões |
| **Doutrina, segurança e operação** | docs, RBAC, LGPD, métricas, CI, kit de instalação e empacotamento |

**Números de referência** (medidos em `38dd469`):

| O que | Quantidade |
|---|---|
| `app/` | 1.017 arquivos (139 páginas; 375 rotas de API) |
| `lib/` | 1.260 arquivos |
| `components/` | 266 arquivos |
| Tabelas | cerca de 155 |
| Migrations | 364 (a maior é a `0438`) |
| Ferramentas de IA no catálogo MCP | 70 |
| Arquivos de teste unitário | 1.036 em `tests/unit`, mais 449 co-localizados |
| Invariantes de banco | 295 |
| Specs e2e | 157 |
| Versão | 1.56.0 |

## 1. Veredito em uma frase

O DeskcommCRM é uma **plataforma de atendimento e vendas por WhatsApp com agentes de IA muito
madura**. Tem RLS, auditoria, LGPD, governança da IA, roteamento, agenda, campanhas e follow-ups.
Mas **não tem nenhuma entidade do domínio imobiliário**. Imóvel, proprietário, captação, proposta,
contrato, empreendimento, unidade, comissão rateada, chave e locação não existem. Hoje "imobiliária"
é só um funil-semente, duas categorias de agenda e um texto de prompt num guia externo.

A boa notícia é que **cerca de 70% do que um CRM imobiliário precisa já existe como
infraestrutura** (canal, IA, agenda, automação, governança, LGPD). O trabalho é **construir o
domínio imobiliário por cima**, não reescrever.

## 2. Forças reaproveitáveis (o que NÃO precisa ser construído)

| Capacidade | Onde está | Uso no imobiliário |
|---|---|---|
| WhatsApp (QR via WAHA, API oficial Meta, Instagram/Facebook) com anti-banimento, mídia e STOP | `lib/waha`, `lib/channels` | Canal principal do corretor e do agente |
| Agente de IA com três papéis (Conversador, Operador, Segurança), RAG por organização, memória, skills, guardrails antes do envio e handoff auditado | `lib/agent-engine` | Base do "corretor digital" |
| 70 ferramentas MCP com RBAC, escopo, pacotes e teto de 25 por agente | `lib/mcp/tools` | Onde entram `buscar_imoveis`, `agendar_visita` etc. |
| Agenda completa: tipos com categoria **`visita`** e **`vistoria`**, folgas, lembretes em degraus, confirmação, no-show, Google Calendar nos dois sentidos | `lib/agenda`, `calendar_*` | Agenda de visitas |
| Funil kanban com `vocabulary`, campos personalizados, motivos de perda e ganho, radar de esfriamento e previsão | `crm_*`, `components/kanban` | Funis de venda, locação, captação e lançamento |
| Automações QUANDO/SE/ENTÃO, follow-ups em grafo e campanhas com rodízio de números | `lib/automation`, `lib/followup`, `lib/campanhas` | Cadências imobiliárias |
| Roteamento round-robin com disponibilidade, horário e capacidade | `lib/routing` | Base da roleta de corretores |
| Webhook de entrada com normalizadores (Respondi, RD) e atribuição Meta/Google | `app/api/v1/webhooks/in`, `lib/plataformas-de-anuncio` | Entrada de leads de portais e anúncios |
| Catálogo com fotos, busca difusa e envio de fotos pela IA | `catalog_products`, `lib/catalogo`, `fotos-do-produto.ts` | Molde para o cadastro de imóveis |
| Banco externo somente leitura para a IA | `lib/external-db` | Ponte provisória com ERP imobiliário existente (Vista, Jetimob, Kenlo) |
| LGPD (export, redact em cascata, CPF criptografado, consentimento, SLA em dias úteis, PDF assinado) e auditoria append-only | `lib/lgpd`, `api_audit_log` | Base de compliance |
| Marca própria vinda do banco, com 1 imagem para N marcas | `lib/branding` | Rebatizar sem código |
| Menu por organização (`interface_settings`) e módulos opcionais da instalação | `lib/navigation/interface.ts`, `lib/instalacao/modulos.ts` | Preset "imobiliária" |
| Mecanismo de módulo instalável com tabelas próprias (ADR-0002) | `modulos_instalados`, `fn_modulo_instalar` | Onde as tabelas imobiliárias devem nascer |

## 3. O que já existe de imobiliário

| Item | Onde |
|---|---|
| Pacote de funil "Interessados": Novo interessado → Já respondi → Entendendo o que procura → Sei o que oferecer → Visitando imóveis → Fechou negócio / Desistiu | `lib/onboarding/pacotes-de-funil.ts:52` |
| Detecção do ramo pelo texto do onboarding | `lib/onboarding/sugerir-funil.ts:47` |
| Categorias de agenda `visita` e `vistoria` | `lib/agenda/tipos.ts`, `baseline.sql:15304` |
| Skill de agendamento que reconhece "marcar uma visita" | `baseline.sql:16401` |
| Guia de nicho com prompt, roteador Vendas/Locação, follow-ups, FAQ e frases de teste | `.agents/skills/deskcomm-cliente-novo/references/nichos.md:81-102` |
| Normalizador Respondi para o formulário "Imobiliárias e Incorporadoras" (B2B da agência, não portal) | `lib/webhooks/respondi.ts` |
| Pino de localização recebido no WhatsApp (única geolocalização do sistema) | `lib/messaging/localizacao.ts` |

**O que não está em nenhum lugar do código ou da documentação:** imóvel, proprietário, CRECI,
COFECI, COAF, IPTU, condomínio, matrícula, CEP estruturado, latitude/longitude, Lei do Inquilinato,
portal imobiliário, VRSync.

## 4. Lacunas por domínio

### 4.1 Dados

| Entidade | Situação | Observação medida |
|---|---|---|
| Imóvel | ❌ | `catalog_products` é de varejo (estoque, custo, limite de 5 fotos). Usá-lo seria *jsonb lock-in* (anti-pattern 6) |
| Proprietário | 🟡 | Dá para reusar `contacts`, que já tem CPF criptografado e cascata de LGPD. Falta o vínculo com o imóvel |
| Interesse lead↔imóvel | ❌ | O CHECK de `crm_lead_links.target_kind` (`baseline.sql:1456`) não aceita `property` |
| Perfil de busca | 🟡 | Pode morar em campos personalizados, mas não há validação de tipo por campo nem índice, e as condições não comparam números |
| Visita | 🟡 | `calendar_appointments` não tem `lead_id` nem `property_id`. Não há ficha pós-visita nem chave |
| Proposta | ❌ | — |
| Contrato | ❌ | Também não há bucket de documentos. O único bucket de mensagens é `whatsapp-media` |
| Comissão rateada | 🟡 | `commissions` tem **um** atendente por item de venda (índice único `commissions_item_key`) e é ancorado em tipo de serviço de clínica |
| Empreendimento / torre / unidade | ❌ | — |
| Locação (contrato, cobrança, reajuste, repasse, garantias, vistoria) | ❌ | `recurring_entries` só tem valor fixo, sem índice e sem boleto |
| Equipes / filiais | ❌ | Não há `teams`. O gerente vê a organização inteira |
| CRECI (pessoa física e jurídica) | ❌ | — |
| Geolocalização | ❌ | Sem PostGIS, sem coordenadas |

### 4.2 IA

- O agente não tem busca estruturada de imóveis. O estoque hoje depende de "materiais" no RAG,
  que é só vetorial.
- A qualificação aceita apenas BANT (`lead-state.ts:23-65`). Renda, FGTS, entrada e finalidade não
  são campos da qualificação.
- O agente só envia fotos de **produto**. Vídeo, tour, PDF do book e pino de localização não estão
  expostos como ferramenta, embora o WAHA os suporte (`lib/waha/media-send.ts`).
- Não há simulador de financiamento, geração de proposta nem agente de captação.
- A regra de plataforma *"Nunca peça dados sensíveis (documentos…)"* (`platform.md:29`) conflita com
  a coleta de documentos de locação e financiamento. Precisa de exceção com base legal.
- Os modelos de follow-up só existem para `clinica` (`lib/followup/modelos/tipos.ts:28`).
- O agente padrão do onboarding não tem prompt por nicho (`createDefaultAgent.ts:42-49`).

### 4.3 Telas

- **Não existem as telas:** Imóveis, Captação, Match, Propostas, Contratos, Comissões,
  Lançamentos, Locação, Portais, Painel do corretor e app móvel.
- **Nenhum campo personalizado aparece no card do kanban.**
- **O `vocabulary` do funil é aplicado só em parte da interface.** "Novo Lead" continua fixo em
  `NewLeadDialog`, `pipelines/[id]/_client.tsx:121` e `CRMSidePanel.tsx:701`.
- **Há textos com viés de outros nichos:** "O paciente pediu para remarcar…" na agenda, e o
  placeholder "Pedido Maria — combo presente".
- **Não existe página pública por organização**, portanto não há vitrine de imóveis.
- **As fotos ficam em bucket privado** com URL assinada de 1 hora, o que é ruim para SEO.
- **O menu está no limite do espaço** (teste de 900px). Telas novas vão para o hub, a menos que
  outras saiam.

### 4.4 Integrações e automação

- **Nenhum portal imobiliário está integrado**, nem na entrada de leads nem na saída de feed XML:
  Grupo OLX (ZAP, VivaReal, OLX), Imovelweb, Chaves na Mão e outros.
- **Não há Meta Lead Ads nativo nem formulários de lead do Google Ads.**
- **A roleta distribui conversa, não lead.** Um lead que chega por formulário ou portal fica sem
  responsável. Também não há SLA com repasse, captador × vendedor, roteamento por região ou por
  empreendimento, nem escala de plantão.
- **As automações não têm gatilho recorrente.** `lead.date_field_due` dispara uma vez por lead,
  então não serve para cobrança mensal nem reajuste anual. Também não há condição numérica nem
  filtro de campanha por campo personalizado.
- **A página pública de agendamento não existe,** embora `public_page` já esteja previsto no
  vocabulário.
- **Não há boleto, Pix de cobrança, assinatura eletrônica nem índice econômico** (IGP-M/IPCA).

### 4.5 Compliance

- **CRECI no anúncio** (Lei 6.530/78 e resoluções do COFECI): nada existe.
- **PLD/COAF para imobiliárias** (Lei 9.613/98 e regulamentação do COFECI): nada existe. Faltam
  cadastro com PEP, registro de operações, comunicação ao COAF com sigilo em relação ao cliente e
  guarda por 5 anos.
- **LGPD com múltiplos titulares por negócio** (proprietário, comprador, locatário, fiador,
  cônjuge) e **retenção legal de contrato prevalecendo sobre o redact**: não existe.
- **DIMOB, Lei do Inquilinato e CDC aplicados a contrato:** nada existe.

## 5. Restrições que moldam o plano

1. **Doutrina de extensões.** O critério é: *"se nenhuma organização ativar isto, a operação
   comum continua inteira?"*. Extensão declarativa **não** cria tabela, tela, menu nem ferramenta
   de IA. O domínio imobiliário, portanto, **não cabe em extensão declarativa**. Cabe num **módulo
   oficial** (ADR-0002) ou em núcleo do fork.
2. **ADR-0002.** As tabelas do módulo nascem numa função `fn_<modulo>_provisionar()` quando o
   módulo é instalado na instância. O mecanismo existe (`fn_modulo_instalar`), mas **nenhum módulo
   concreto o usa ainda**. O imobiliário seria o primeiro.
3. **Tripla de migration.** Toda mudança de schema exige migration, apêndice idempotente no
   `baseline.sql` e linha no MANIFEST, além de RLS, `revoke` das funções e teste de isolamento.
4. **Relação com o upstream.** Este repositório é fork de `melgarafael/DeskcommCRM`, que lança
   cerca de 2 versões por dia. Conflitos de migration e de `baseline.sql` são certos se o fork
   editar o núcleo sem disciplina.
5. **Empacotamento.** O kit de instalação (`_common.sh:1271`), o compose e o `release.yml` apontam
   para `melgarafael`. Para distribuir uma versão própria, é preciso trocar o namespace das
   imagens, a origem das tags e o esquema de versão. O kit descarta versões com `-`.
6. **QA visual e Sistema Vivo.** Toda tela nova precisa de prova por Playwright em ambiente fresco,
   de uma porta na navegação e de um laço de retorno declarado.
