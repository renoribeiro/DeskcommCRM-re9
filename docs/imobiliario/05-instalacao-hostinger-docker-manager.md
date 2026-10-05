---
type: runbook
project: ImobCRM (fork re9)
status: fase 0
last_updated: 2026-10-05
---

# Instalar o ImobCRM pelo Docker Manager da Hostinger

> **Para quem é:** para a RE9 Imob, que vai rodar o ImobCRM em `crmimob.re9imob.com.br` numa VPS
> da Hostinger (4 vCPU, 8 GB de RAM) gerenciada pelo **Docker Manager** do painel da Hostinger,
> com o **Traefik da Hostinger** na frente. O banco (Supabase) fica dentro da própria VPS.
>
> É o mesmo sistema da instalação pelo Dokploy (`03-instalacao-vps-dokploy.md`), com uma
> diferença: o Docker Manager recebe **só o YAML**, sem o repositório ao lado. Por isso o arquivo
> desta instalação, `docker-compose.hostinger.yml`, é **autocontido**: os arquivos do Supabase e o
> script de preparo vêm dentro dele.

## O que vai rodar

Os mesmos 14 serviços do Dokploy (Supabase: `db`, `auth`, `rest`, `realtime`, `storage`,
`imgproxy`, `api-gw`; CRM: `setup`, `app`, `worker`, `scheduler`, `waha`, `redis`, `srh`). Todos
com teto de memória; a soma dos que ficam no ar é ~6,6 GB. O `setup` roda a cada implantação e
**sai**: prepara o banco e cria o primeiro administrador.

Nenhuma porta é publicada na VPS. O Traefik da Hostinger roda em `network_mode: host` e chega
aos contêineres pela rede do projeto. Publicar uma porta (como o YAML do Typebot faz com
`ports: - "3000"`) abriria um caminho que **contorna o Traefik**, e com ele o bloqueio do
webhook do WhatsApp, que mora nas regras do Traefik.

---

## Antes de começar (uma vez só)

### 1. DNS

No painel do domínio `re9imob.com.br`:

| Tipo | Nome | Valor | TTL |
|---|---|---|---|
| `A` | `crmimob` | **IP da VPS** | 300 |

Confira do seu computador: `nslookup crmimob.re9imob.com.br` tem de responder o IP da VPS.

### 2. Traefik da Hostinger

O projeto **Traefik** do catálogo do Docker Manager tem de estar instalado e rodando (é ele que
emite o certificado HTTPS). Se você já usa o Typebot com `Host(...)` e `letsencrypt`, ele já está.

### 3. Memória de reserva (swap de 4 GB)

No terminal da VPS (painel da Hostinger › VPS › **Terminal do navegador**, ou `ssh root@IP`):

```bash
swapon --show | grep -q . || { fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; }
free -h
```

---

## Instalação

### Passo 1. Gere as variáveis (senhas e chaves)

No terminal da VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/renoribeiro/DeskcommCRM-re9/v1.58.1/infra/dokploy/gerar-env.sh -o /root/gerar-env.sh
bash /root/gerar-env.sh --dominio crmimob.re9imob.com.br --email SEU-EMAIL --versao 1.58.1
```

- Troque `SEU-EMAIL` pelo e-mail do primeiro administrador.
- `--versao` é o número de uma versão **publicada**, a partir da **1.58.1**. A 1.58.0 trouxe o
  `docker-compose.hostinger.yml`, mas com acentos nos comentários, e o editor da Hostinger recusa
  o arquivo. Para ver as versões que existem:
  `git ls-remote --tags https://github.com/renoribeiro/DeskcommCRM-re9 'v*'`
- O comando imprime um bloco de texto. **Guarde-o num gerenciador de senhas**: ele traz a senha do
  administrador (`OWNER_PASSWORD`) e as chaves do banco.
- **Não gere de novo depois de instalar.** Trocar `POSTGRES_PASSWORD` ou `JWT_SECRET` depois que o
  banco nasceu deixa o CRM sem acesso a ele.

### Passo 2. Crie o projeto no Docker Manager

1. Painel da Hostinger › sua VPS › **Docker Manager** › criar projeto com Compose (editor YAML).
2. **Nome do projeto:** `crmimob`. O nome entra nas regras do Traefik e na rede do projeto
   (`crmimob_default`); qualquer nome em minúsculas serve, mas não troque depois.
3. **YAML:** cole o conteúdo inteiro de
   `https://raw.githubusercontent.com/renoribeiro/DeskcommCRM-re9/vVERSAO/docker-compose.hostinger.yml`
   — o arquivo **da mesma versão** do passo 1. Não edite nada nele.
4. **Variáveis de ambiente:** cole **todo** o bloco do passo 1.
5. Implante.

### Passo 3. Acompanhe

Nos logs do contêiner `setup`:

```
[setup] baixando o schema da versão 1.58.1: https://raw.githubusercontent.com/renoribeiro/DeskcommCRM-re9/v1.58.1/supabase/baseline.sql
[setup] banco novo — aplicando o baseline (qualquer erro interrompe)
[setup] primeiro administrador: SEU-EMAIL
[setup] pronto
```

Depois sobem `app`, `worker` e `scheduler`. A primeira implantação leva de 5 a 15 minutos, por
causa do download das imagens.

### Passo 4. Confira

```bash
curl -sI https://crmimob.re9imob.com.br | head -1
```

O esperado é **`HTTP/2 307`** (redireciona para o login). Abra o endereço, entre com `OWNER_EMAIL`
e `OWNER_PASSWORD` do passo 1 e **troque a senha** em Configurações › Perfil.

| Sintoma | Causa provável |
|---|---|
| "O arquivo YAML não pôde ser processado", com a linha 1 marcada | YAML de uma versão anterior à 1.58.1, que tinha acentos. O editor da Hostinger só aceita ASCII: use o `docker-compose.hostinger.yml` da 1.58.1 ou mais nova, sem editar |
| O painel recusa com `configs` ou `content` desconhecido | Docker Compose antigo na VPS. O arquivo exige o Compose **2.23.1 ou mais novo** (`docker compose version`); atualize o Docker da VPS |
| O painel recusa com `defina DOMAIN`, `defina IMAGE_TAG`… | Falta a variável. Cole de novo o bloco **inteiro** do passo 1 |
| `404 page not found` | O Traefik não achou o CRM: o `app` não subiu (veja os logs), o DNS ainda não propagou, ou o projeto Traefik da Hostinger está parado |
| Certificado inválido | O DNS ainda não aponta para a VPS quando o Traefik pediu o certificado. Espere a propagação e implante de novo |
| Página abre, mas o login dá erro | O `api-gw` (gateway do Supabase) não subiu: veja os logs dele |
| `setup` diz `NÃO consegui baixar o schema da versão X` | A versão não existe como tag, ou a VPS não alcança `raw.githubusercontent.com` |
| `pull access denied` | Os pacotes do GitHub estão privados: em `https://github.com/renoribeiro?tab=packages`, cada pacote › Package settings › **Public** |

---

## Atualizar

1. Troque `IMAGE_TAG` nas variáveis de ambiente para o número novo.
2. Troque o YAML pelo `docker-compose.hostinger.yml` **da mesma versão** (o endereço do passo 2
   com o número novo). O YAML e as imagens andam juntos.
3. Implante. O `setup` reaplica o schema da versão nova (é seguro e idempotente) antes de o app
   novo subir.

Depois da instalação, `OWNER_PASSWORD` pode sair das variáveis: ela só é usada enquanto o
administrador ainda não existe.

## E-mail (SMTP) e cadastro

As telas **Administração › E-mail** e **Administração › Cadastro** mudam o que o **CRM** faz, mas o
**login** lê o SMTP e o modo de cadastro das variáveis do projeto, e só numa nova implantação. As
duas telas avisam isso nesta instalação. Para mudar:

1. Nas variáveis do projeto, preencha `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`,
   `SMTP_FROM_EMAIL` e `SMTP_FROM_NAME`, ou ajuste `SIGNUP_MODE` / `DISABLE_SIGNUP` (os dois andam
   juntos: `so_convite` com `true`).
2. Implante de novo.
3. Repita o mesmo na tela, para o CRM usar o mesmo e-mail.

Qualquer outra variável que o CRM conhece (Web Push, Resend, Google Agenda, `SUPPORT_EMAIL`,
`LGPD_DPO_EMAIL`, retenções…) também se liga assim: nome e valor nas variáveis, e nova implantação.

## Backup

O mesmo script do Dokploy serve, informando o nome do projeto:

```bash
curl -fsSL https://raw.githubusercontent.com/renoribeiro/DeskcommCRM-re9/v1.58.1/infra/dokploy/backup.sh -o /root/backup-imobcrm.sh
bash /root/backup-imobcrm.sh --projeto crmimob
```

Ele salva o banco, os arquivos e as sessões do WhatsApp em `/root/backups-imobcrm/`, cada peça
conferida. Agende pelo cron da VPS e copie a pasta para **fora** da VPS. A restauração está em
`03-instalacao-vps-dokploy.md`, seção "Restaurar".

## Limite conhecido

O WAHA desta instalação (Core) **não assina** os webhooks. A rota do webhook é negada pelo
Traefik, e o `app` não é alcançável por contêineres de outros projetos (cada projeto tem a sua
rede). Quem usar WAHA Plus pode exigir a assinatura com `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true`.
