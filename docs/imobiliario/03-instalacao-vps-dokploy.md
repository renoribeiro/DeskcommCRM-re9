---
type: runbook
project: ImobCRM (fork re9)
status: fase 0
last_updated: 2026-09-27
---

# Instalar o ImobCRM na VPS da Hostinger com Dokploy

> **Para quem é:** para a RE9 Imob, que vai rodar o ImobCRM em
> `crmimob.re9imob.com.br`, numa VPS da Hostinger (4 vCPU, 8 GB de RAM) que já tem o **Dokploy**.
> O banco (Supabase) fica **dentro da própria VPS** (decisão F do plano).
>
> Há dois caminhos, e os dois resultam no mesmo sistema:
>
> | | **A. Pelo Dokploy** (recomendado para você) | **B. Pelo kit, via SSH** |
> |---|---|---|
> | Como | Um serviço Compose no painel do Dokploy lendo `docker-compose.dokploy.yml` do GitHub | Um comando no terminal da VPS (`install-single-server.sh`) |
> | Atualizar | Botão **Deploy** do Dokploy | `bash hostgator-setup-kit/update.sh` |
> | Backup | Volumes do Dokploy (ou `pg_dump`, abaixo) | `bash hostgator-setup-kit/backup.sh` |
> | Gerenciado por | Dokploy | Kit (os contêineres aparecem no Dokploy, mas não se editam lá) |

## O que vai rodar na VPS

| Peça | Para quê | Memória aproximada |
|---|---|---|
| Dokploy + Traefik (já existem) | Painel e proxy com HTTPS | ~0,5 GB |
| Supabase (Postgres, Auth, REST, Realtime, Storage, imgproxy, gateway) | Banco, login, arquivos | ~1,5–2 GB |
| `app` (o ImobCRM) | Telas e API | até 0,75 GB |
| `worker` | Agente de IA | até 0,5 GB |
| `scheduler` | Tarefas agendadas (lembretes, follow-ups, limpeza) | pequeno |
| `waha` | WhatsApp não oficial (a oficial da Meta não usa) | até 1,25 GB |
| `redis` + `srh` | Limites de uso e filas leves | pequeno |
| `setup` | Roda a cada deploy e **sai**: prepara o banco e cria o administrador | — |

Total estimado: **5 a 6 GB** de 8 GB.

---

## Antes de começar (uma vez só)

### 1. DNS

No painel do domínio `re9imob.com.br`, crie o registro:

| Tipo | Nome | Valor | TTL |
|---|---|---|---|
| `A` | `crmimob` | **IP da VPS** | 300 |

Confira (do seu computador): `nslookup crmimob.re9imob.com.br`. Tem de responder o IP da VPS.

### 2. Imagens públicas

As imagens do sistema são construídas pelo GitHub a cada mudança na `main` do fork. Para isso:

1. **Ligue o GitHub Actions no fork**: `https://github.com/renoribeiro/DeskcommCRM-re9/actions`
   → botão **"I understand my workflows, go ahead and enable them"**. Em fork, o GitHub vem com
   o Actions desligado; sem ele, nenhuma imagem é publicada.
2. Depois da primeira publicação, abra `https://github.com/renoribeiro?tab=packages` e, em
   **cada** pacote (`deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler` e
   `deskcomm-voice-agent`), use **Package settings → Change visibility → Public**. O GitHub cria
   os pacotes como privados, e a VPS não consegue baixar pacote privado.

### 3. Memória de reserva (swap de 4 GB)

No terminal da VPS (Dokploy › Servidor › Terminal, ou `ssh root@IP`):

```bash
swapon --show | grep -q . || { fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; }
free -h
```

---

## Caminho A: pelo Dokploy

### A1. Gere as variáveis (senhas e chaves)

Em qualquer máquina com `bash` e `openssl`: o terminal da VPS, um Mac ou um Linux.

```bash
git clone --depth 1 https://github.com/renoribeiro/DeskcommCRM-re9.git /tmp/imobcrm
bash /tmp/imobcrm/infra/dokploy/gerar-env.sh \
  --dominio crmimob.re9imob.com.br \
  --email SEU-EMAIL@re9imob.com.br \
  --versao VERSAO
```

- Troque `VERSAO` pelo número da versão publicada (ex.: `1.57.0`).
- O comando imprime um bloco de texto. **Guarde-o num gerenciador de senhas.** Ele traz a senha do
  administrador (`OWNER_PASSWORD`) e as chaves do banco.
- **Não gere de novo depois de instalar:** trocar `POSTGRES_PASSWORD` ou `JWT_SECRET` depois que o
  banco nasceu deixa o CRM sem acesso a ele.

### A2. Crie o serviço no Dokploy

1. Dokploy › seu projeto › **Create Service → Compose**, com o nome `imobcrm`.
2. Aba **General › Provider: Git**:
   - Repository URL: `https://github.com/renoribeiro/DeskcommCRM-re9.git`
   - Branch: `main`
   - Compose Path: `./docker-compose.dokploy.yml`
3. Aba **Environment**: cole **todo** o bloco gerado no passo A1 e salve.
4. **Não configure nada na aba Domains.** As rotas já estão no arquivo: o CRM e o login dividem o
   mesmo domínio, separados por caminho.
5. Clique em **Deploy**.

### A3. Acompanhe

Na aba **Logs** do serviço, o contêiner `setup` mostra:

```
[setup] banco novo — aplicando o baseline (qualquer erro interrompe)
[setup] tabelas em public: 180
[setup] primeiro administrador: SEU-EMAIL@re9imob.com.br
[setup] pronto
```

Depois disso sobem `app`, `worker` e `scheduler`. O primeiro deploy leva de 5 a 15 minutos, por
causa do download das imagens.

### A4. Confira

```bash
curl -sI https://crmimob.re9imob.com.br | head -1
```

O esperado é **`HTTP/2 307`** (redireciona para o login). Abra
`https://crmimob.re9imob.com.br`, entre com `OWNER_EMAIL` e `OWNER_PASSWORD` do passo A1 e **troque
a senha** em Configurações › Perfil.

| Sintoma | Causa provável |
|---|---|
| `404 page not found` | O Traefik não achou o CRM: o `app` não subiu (veja os Logs) ou o DNS ainda não propagou |
| Página abre, mas o login dá erro | O `api-gw` (gateway do Supabase) não subiu: veja os Logs dele |
| `setup` termina com erro | A mensagem diz o passo. O mais comum é a chave do Supabase: gere tudo de novo **só** se o banco ainda não tiver sido criado |
| `pull access denied` | Os pacotes do GitHub ainda estão privados (item 2 de "Antes de começar") |

### A5. Atualizar

1. Na aba **Environment**, troque `IMAGE_TAG` para o número novo.
2. Clique em **Deploy**.

O `setup` reaplica o banco em modo atualização (é seguro e idempotente) antes do app novo subir.

### A6. Backup

O que precisa de backup são os volumes `db-data` (banco) e `storage-data` (fotos e arquivos).
Backup do banco pelo terminal da VPS:

```bash
docker exec $(docker ps -qf 'name=imobcrm.*-db-1' | head -1) pg_dump -U postgres -Fc postgres > /root/imobcrm-$(date +%F).dump
```

Automatize com o agendamento do Dokploy ou com o `cron` da VPS, e copie os arquivos para fora da
VPS (Google Drive, S3, outro servidor).

---

## Caminho B: pelo kit, via SSH

Use este caminho se preferir que o kit do projeto cuide de instalar, atualizar e fazer backup.

```bash
apt-get update && apt-get install -y git curl jq openssl
git clone --depth 1 https://github.com/renoribeiro/DeskcommCRM-re9.git /opt/imobcrm
cd /opt/imobcrm
APP_NAME=ImobCRM bash hostgator-setup-kit/install-single-server.sh --domain crmimob.re9imob.com.br
```

O instalador:

- detecta o Traefik do Dokploy e publica o CRM e as APIs do Supabase por ele, sem derrubar nada;
- no fim, mostra o usuário e a senha do administrador, também gravados em
  `/opt/imobcrm/.runtime/admin-credentials`.

No dia a dia, rode dentro de `/opt/imobcrm`:

- atualizar: `bash hostgator-setup-kit/update.sh`
- backup: `bash hostgator-setup-kit/backup.sh`
- diagnóstico: `bash hostgator-setup-kit/diagnostico.sh`

**Não crie o CRM também como serviço do Dokploy** se usar este caminho: são dois caminhos, escolha
um.

---

## Primeiros ajustes pela tela (os dois caminhos)

| Onde | O quê |
|---|---|
| **Administração › Marca** | Nome **ImobCRM**, logo e cor |
| **Administração › E-mail** | SMTP para "esqueci a senha", convites e alertas. No caminho A, preencha também as variáveis `SMTP_*` no Environment e faça Deploy, para o login usar o mesmo e-mail |
| **IA › Credenciais** | A chave de IA **da RE9 Imob** (decisão A) |
| **Conexões** | WhatsApp pela **API oficial da Meta** (decisão B) |
| **Equipe** | Convite dos corretores. O cadastro é **só por convite**: ninguém de fora cria conta sozinho |

## O que NÃO fazer

- **Não pare o `dokploy-traefik`:** o domínio inteiro sai do ar.
- **Não apague os volumes** `db-data` e `storage-data`: é onde moram o banco e os arquivos.
- **Não gere as variáveis de novo** depois da instalação (passo A1).
