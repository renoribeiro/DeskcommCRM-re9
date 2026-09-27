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
> | Backup | `bash infra/dokploy/backup.sh` (A6) | `bash hostgator-setup-kit/backup.sh` |
> | Gerenciado por | Dokploy | Kit (os contêineres aparecem no Dokploy, mas não se editam lá) |

## O que vai rodar na VPS

| Peça | Para quê | Teto de memória (`mem_limit`) |
|---|---|---|
| Dokploy + Traefik (já existem) | Painel e proxy com HTTPS | ~0,5 GB (fora do compose) |
| `db` (Postgres) | Banco | 1,5 GB (`shared_buffers=512MB`) |
| `auth`, `rest`, `api-gw` | Login, API do banco, gateway | 256 MB cada |
| `realtime` | Atualização ao vivo das telas | 512 MB |
| `storage` + `imgproxy` | Arquivos e miniaturas | 384 MB + 512 MB (2 imagens por vez) |
| `app` (o ImobCRM) | Telas e API | 768 MB |
| `worker` | Agente de IA | 512 MB |
| `scheduler` | Tarefas agendadas (lembretes, follow-ups, limpeza) | 128 MB |
| `waha` | WhatsApp não oficial (a oficial da Meta não usa) | 1,25 GB |
| `redis` + `srh` | Limites de uso e filas leves | 192 MB (Redis com teto de 128 MB) + 128 MB |
| `setup` | Roda a cada deploy e **sai**: prepara o banco e cria o administrador | 256 MB |

Soma dos tetos do que fica no ar: **~6,6 GB**, mais ~0,5 GB do Dokploy, numa VPS de 8 GB. Teto não
é consumo: o uso real fica bem abaixo. Ele existe para que um serviço que dispare seja reiniciado
sozinho, em vez de o sistema matar o Postgres por falta de memória.

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

- Troque `VERSAO` pelo número de uma versão **publicada** (ex.: `1.57.0`). O `--versao` é
  obrigatório: `stable` e `latest` são recusados, porque mudam sozinhos (e `stable` pode nem
  existir no registro do fork, o que faria o primeiro deploy falhar no download da imagem). Para
  ver as versões publicadas:

  ```bash
  git ls-remote --tags https://github.com/renoribeiro/DeskcommCRM-re9 'v*'
  ```

  A tag `v1.57.0` vira a imagem `1.57.0`. Confira também que ela aparece em
  `https://github.com/renoribeiro/DeskcommCRM-re9/pkgs/container/deskcommcrm`: tag sem imagem
  publicada falha no Deploy.
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
| `setup` diz que o baseline não se aplicou e cita `storage.` | O serviço `storage` não criou o schema dele a tempo: veja os Logs do `storage` e faça **Deploy** de novo. O `setup` reprova de propósito: seguir deixaria o CRM sem os buckets de arquivos |
| Compose recusa com `defina IMAGE_TAG` ou `defina REALTIME_DB_ENC_KEY` | Falta a variável no Environment. Gere com o passo A1 (instalação nova). Numa instalação que já subiu **antes** desta versão do arquivo, use `REALTIME_DB_ENC_KEY=supabaserealtime` (o valor que o Realtime já usa para cifrar o que guardou); trocar a chave depois quebra o Realtime |
| `pull access denied` | Os pacotes do GitHub ainda estão privados (item 2 de "Antes de começar") |

### A5. Atualizar

1. Na aba **Environment**, troque `IMAGE_TAG` para o número novo (veja as versões publicadas no
   passo A1).
2. Clique em **Deploy**.

O `setup` reaplica o banco em modo atualização (é seguro e idempotente) antes do app novo subir. Se
alguma parte do banco não se aplicar (um objeto que não existe, ou o schema `storage`), o `setup`
**para** e o app antigo continua no ar: leia o log do `setup` antes de tentar de novo.

Depois da instalação, `OWNER_PASSWORD` pode sair do Environment: ela só é usada enquanto o
administrador ainda não existe, e trocar o valor não troca a senha de quem já entrou.

### E-mail (SMTP) e cadastro: sempre pelo Environment

As telas **Administração › E-mail** e **Administração › Cadastro** mudam o que o **CRM** faz, mas o
**login** (o Auth do Supabase) lê o SMTP e o modo de cadastro das variáveis de ambiente, e só na
partida. No caminho A, então:

1. Na aba **Environment**, preencha `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`,
   `SMTP_FROM_EMAIL` e `SMTP_FROM_NAME` (para "esqueci a senha" e convites), e ajuste
   `SIGNUP_MODE` / `DISABLE_SIGNUP` se mudar o cadastro (os dois andam juntos: `so_convite` com
   `true`).
2. Clique em **Deploy**. Sem o Deploy, o Auth continua com os valores antigos.
3. Só então repita o mesmo na tela, para o CRM usar o mesmo e-mail.

Qualquer outra variável que o CRM conhece (VAPID do Web Push, Resend, Google Agenda,
`SUPPORT_EMAIL`, `LGPD_DPO_EMAIL`, retenções…) também se liga assim: nome e valor no Environment,
depois Deploy. O arquivo já repassa todas.

### Nomes únicos na rede do Dokploy

O `app` e o `api-gw` também ficam na rede compartilhada do Traefik (`dokploy-network`), onde outro
sistema pode ter um serviço chamado `db`, `auth` ou `rest`. Por isso todo endereço interno usa um
nome único (`imobcrm-db`, `imobcrm-auth`…), e o gateway reescreve o `cds.yaml` oficial do Supabase
para esses nomes na partida (`infra/dokploy/gateway-entrypoint.sh`); se o formato do arquivo mudar
numa troca de versão do Supabase, o gateway **não sobe** e diz o motivo no log.

Limite conhecido: um contêiner de **outro** sistema na `dokploy-network` consegue chamar o webhook
do WhatsApp no `app` direto, sem passar pelo Traefik. O WAHA desta instalação (Core) **não assina**
os webhooks, então exigir assinatura (`WAHA_WEBHOOK_REQUIRE_SIGNATURE=true`) derrubaria a entrada
de toda mensagem; ela fica em `false`. Ligue-a só com WAHA Plus. Enquanto isso, não ponha na mesma
VPS sistemas de terceiros em que você não confia.

O app e o worker falam com o Supabase pelo **domínio público** (`https://DOMINIO/auth/v1`…), como no
kit: é o mesmo endereço que o navegador usa, e é assim que os cookies de login valem nos dois lados.

### A6. Backup

Três coisas precisam de backup: o banco, os arquivos (volume `storage-data`) e as sessões do
WhatsApp (volume `waha-data`; sem elas, é parear o celular de novo). No terminal da VPS:

```bash
git clone --depth 1 https://github.com/renoribeiro/DeskcommCRM-re9.git /root/imobcrm-kit   # uma vez
bash /root/imobcrm-kit/infra/dokploy/backup.sh
```

O script acha sozinho a instalação (pelo arquivo `docker-compose.dokploy.yml`; se houver mais de
uma, use `--projeto NOME`) e grava em `/root/backups-imobcrm/AAAA-MM-DD_HHMMSS/`:

| Arquivo | O quê |
|---|---|
| `db.dump` | O banco inteiro (`pg_dump -Fc`), conferido com `pg_restore --list` |
| `storage-data.tgz` | Os arquivos, conferidos com `gzip -t` |
| `waha-data.tgz` | As sessões do WhatsApp, conferidas com `gzip -t` |
| `SHA256SUMS` | Soma de cada arquivo (`sha256sum -c SHA256SUMS` confere depois de copiar) |

Backup que não passa na conferência é apagado e o script sai com erro. Guarda 7 dias por padrão
(`--reter-dias N`); `--destino DIR` muda a pasta. Agende no `cron` da VPS:

```bash
10 3 * * * bash /root/imobcrm-kit/infra/dokploy/backup.sh >> /var/log/imobcrm-backup.log 2>&1
```

E **copie a pasta para fora da VPS** (Google Drive, S3, outro servidor): backup no mesmo disco
morre junto com ele. A pasta tem todas as senhas do banco: guarde com o mesmo cuidado do bloco do
passo A1.

### A7. Restaurar

Na mesma VPS (dados apagados ou corrompidos) ou numa VPS nova. Numa VPS nova, faça antes o passo A2
com o **mesmo** bloco de variáveis do passo A1 (as mesmas senhas: o banco restaurado as espera) e
espere o primeiro Deploy terminar.

1. Confira o backup: `cd /root/backups-imobcrm/AAAA-MM-DD_HHMMSS && sha256sum -c SHA256SUMS`.
2. No Dokploy, **pare** o serviço (botão **Stop**). Os volumes ficam.
3. Descubra o nome do projeto e dos volumes:

   ```bash
   docker volume ls --filter label=com.docker.compose.volume=storage-data   # ex.: imobcrm-abc123_storage-data
   P=imobcrm-abc123            # a parte antes de _storage-data
   B=/root/backups-imobcrm/AAAA-MM-DD_HHMMSS
   ```

4. Arquivos e sessões do WhatsApp (apaga o conteúdo atual do volume e põe o do backup):

   ```bash
   for v in storage-data waha-data; do
     docker run --rm -v "${P}_${v}:/data" -v "$B:/b:ro" alpine:3.20 \
       sh -c "find /data -mindepth 1 -delete && tar xzf /b/${v}.tgz -C /data"
   done
   ```

5. Banco: suba **só** o banco e restaure por cima.

   ```bash
   docker start "$(docker ps -aq --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=db)"
   DB=$(docker ps -q --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=db)
   docker exec -i "$DB" pg_restore -h 127.0.0.1 -U supabase_admin -d postgres --clean --if-exists --no-owner < "$B/db.dump"
   ```

   Avisos sobre objetos do próprio Supabase (extensões, schemas do sistema) são esperados; o que
   importa é o fim sem `FATAL`. Confira que os dados voltaram:

   ```bash
   docker exec "$DB" psql -h 127.0.0.1 -U supabase_admin -d postgres -Atc "select count(*) from public.organizations; select count(*) from auth.users"
   ```

6. No Dokploy, **Deploy**. O `setup` reaplica o baseline em modo atualização por cima do banco
   restaurado (é idempotente) e o resto sobe.
7. Confira pelo navegador: entre com um usuário que existia no backup e abra um lead com anexo.

> A restauração não foi exercitada contra a pilha completa do Supabase ao escrever este passo:
> o `backup.sh` foi provado com um Docker dublê (`tests/shell/dokploy-backup.test.sh`). Faça um
> ensaio de restauração numa VPS de teste antes de precisar dele de verdade.

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
| **Administração › E-mail** | SMTP para "esqueci a senha", convites e alertas. No caminho A, preencha **antes** as variáveis `SMTP_*` no Environment e faça Deploy (ver "E-mail (SMTP) e cadastro"), para o login usar o mesmo e-mail |
| **IA › Credenciais** | A chave de IA **da RE9 Imob** (decisão A) |
| **Conexões** | WhatsApp pela **API oficial da Meta** (decisão B) |
| **Equipe** | Convite dos corretores. O cadastro é **só por convite**: ninguém de fora cria conta sozinho. Mudar isso no caminho A é pelo Environment + Deploy, não só pela tela |

## O que NÃO fazer

- **Não pare o `dokploy-traefik`:** o domínio inteiro sai do ar.
- **Não apague os volumes** `db-data`, `storage-data` e `waha-data`: é onde moram o banco, os
  arquivos e as sessões do WhatsApp.
- **Não troque `REALTIME_DB_ENC_KEY`** depois de instalar: o Realtime guarda a senha do banco
  cifrada com ela.
- **Não gere as variáveis de novo** depois da instalação (passo A1).
