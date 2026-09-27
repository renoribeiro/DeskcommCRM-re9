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
> **Como funciona:** o kit de instalação do projeto sobe tudo com um comando: Supabase, CRM,
> worker da IA, agendador, WhatsApp não oficial e Redis. Ele percebe sozinho que o Dokploy já
> tem um **Traefik** nas portas 80/443 e publica o CRM **através dele**, sem derrubar nada do
> Dokploy. Esse caminho foi implementado na fase 0; os testes estão em
> `tests/shell/single-server-operacao.test.sh`, bloco (e).

## O que vai rodar na VPS

| Peça | Para quê | Memória aproximada |
|---|---|---|
| Dokploy + Traefik (já existem) | Painel e proxy com HTTPS | ~0,5 GB |
| Supabase (Postgres, Auth, REST, Realtime, Storage, gateway…) | Banco, login, arquivos | ~2–2,5 GB |
| `app` (o ImobCRM) | Telas e API | até 0,75 GB |
| `worker` | Agente de IA | até 0,5 GB |
| `scheduler` | Tarefas agendadas (lembretes, follow-ups, limpeza) | pequeno |
| `waha` | WhatsApp não oficial (opcional; a oficial da Meta não usa) | até 1,25 GB |
| `redis` + `srh` | Limites de uso e filas leves | pequeno |

Total estimado: **5 a 6 GB** de 8 GB. Cabe, e o passo 3 cria uma memória de reserva (swap) por
segurança.

---

## Antes de começar (uma vez só)

### A. DNS

No painel onde está o domínio `re9imob.com.br`, crie o registro:

| Tipo | Nome | Valor | TTL |
|---|---|---|---|
| `A` | `crmimob` | **IP da VPS** | 300 |

Confira (do seu computador): `nslookup crmimob.re9imob.com.br`. Tem de responder o IP da VPS.

### B. Imagens públicas do ImobCRM

Quem constrói e publica as imagens do sistema é o GitHub, a cada mudança na `main` do fork. **O
GitHub cria os pacotes como privados**, e a VPS não consegue baixar pacote privado. Depois da
primeira publicação:

1. Abra `https://github.com/renoribeiro?tab=packages`.
2. Para cada um dos pacotes `deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler` e
   `deskcomm-voice-agent`, entre em **Package settings → Change visibility → Public**.

> Se preferir manter as imagens privadas, é possível (exige `docker login ghcr.io` na VPS com um
> token de leitura). Recomendamos públicas: o código já é open source (MIT) e não há segredo
> dentro das imagens.

### C. Versão publicada

O instalador instala sempre **um número de versão**, nunca "a última coisa que entrou". A
primeira versão do ImobCRM é marcada no GitHub (tag) depois que a fase 0 entra na `main`.

---

## Instalação

Todos os comandos são digitados na VPS, pelo terminal (SSH) da Hostinger ou pelo seu computador:
`ssh root@IP-DA-VPS`.

### 1. Confirme que o Traefik do Dokploy está de pé

```bash
docker ps --format '{{.Names}}  {{.Ports}}' | grep -i traefik
```

Deve aparecer algo como `dokploy-traefik  0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp`.
**Não desligue esse contêiner:** é ele que dá HTTPS ao Dokploy e agora também ao ImobCRM.

### 2. Ferramentas que o instalador usa

```bash
apt-get update && apt-get install -y git curl jq openssl
```

O Docker já vem com o Dokploy.

### 3. Memória de reserva (swap de 4 GB)

```bash
swapon --show | grep -q . || { fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; }
free -h
```

### 4. Baixe o ImobCRM

```bash
git clone --depth 1 https://github.com/renoribeiro/DeskcommCRM-re9.git /opt/imobcrm
cd /opt/imobcrm
```

> O nome da pasta (`imobcrm`) vira o nome do projeto no Docker. Não troque depois.
> Se o repositório for privado, o `git clone` pede usuário e um **token** do GitHub com
> permissão só de leitura.

### 5. Instale

```bash
APP_NAME=ImobCRM bash hostgator-setup-kit/install-single-server.sh --domain crmimob.re9imob.com.br
```

O que você vai ver:

- **"Preparando o Supabase self-hosted"**: baixa e confere a assinatura do instalador oficial.
- **"Detectei um Traefik já rodando neste VPS"**: é o do Dokploy, e o CRM vai sair por ele.
- **"Publicando as APIs do Supabase pelo Traefik da VPS"**: o login do navegador passa pelo
  mesmo domínio.
- No fim, **usuário e senha do administrador**. Guarde num gerenciador de senhas. Eles também
  ficam em `/opt/imobcrm/.runtime/admin-credentials`, arquivo que só o root lê.

A instalação leva de 10 a 20 minutos na primeira vez.

### 6. Confira

```bash
curl -sI https://crmimob.re9imob.com.br | head -1
```

O esperado é **`HTTP/2 307`** (redireciona para o login). **`404` quer dizer que o Traefik não
achou o CRM**; nesse caso, rode `bash hostgator-setup-kit/diagnostico.sh` e me envie a saída.

Depois abra `https://crmimob.re9imob.com.br` no navegador e entre com o usuário e a senha do
passo 5.

---

## Primeiros ajustes pela tela

| Onde | O quê |
|---|---|
| **Administração › Marca** | Nome **ImobCRM**, logo e cor. A marca fica no banco e sobrevive às atualizações |
| **Administração › E-mail** | SMTP para "esqueci a senha", convites e alertas. Depois de salvar, rode `bash hostgator-setup-kit/update.sh` para o login também usar esse e-mail |
| **IA › Credenciais** | A chave de IA **da RE9 Imob** (decisão A) |
| **Conexões** | WhatsApp pela **API oficial da Meta** (decisão B), com a conta já verificada |
| **Equipe** | Convite dos corretores |

---

## No dia a dia

| Tarefa | Comando (na pasta `/opt/imobcrm`) |
|---|---|
| **Atualizar** para a versão mais nova | `bash hostgator-setup-kit/update.sh` |
| **Backup** (banco + arquivos + sessões do WhatsApp) | `bash hostgator-setup-kit/backup.sh` |
| **Restaurar** um backup | `bash hostgator-setup-kit/restore.sh <arquivo>` |
| **Diagnóstico** quando algo parece errado | `bash hostgator-setup-kit/diagnostico.sh` |

**Backup automático diário, às 3h:**

```bash
( crontab -l 2>/dev/null; echo '0 3 * * * cd /opt/imobcrm && bash hostgator-setup-kit/backup.sh >> /var/log/imobcrm-backup.log 2>&1' ) | crontab -
```

Copie os backups para fora da VPS (Google Drive, S3, outro servidor). Backup que mora só na
máquina que pode quebrar não é backup.

## O que NÃO fazer

- **Não crie o ImobCRM como aplicação dentro do Dokploy.** Ele é gerenciado pelo kit (instalar,
  atualizar, backup). O Dokploy continua útil para os seus outros sistemas, e os contêineres do
  ImobCRM aparecem na lista, mas não os edite por lá.
- **Não pare o `dokploy-traefik`.** O domínio inteiro sai do ar.
- **Não rode `docker compose up` à mão** sem os arquivos certos. Use sempre os scripts do kit;
  eles sabem quais arquivos combinar, e um `up` sem o arquivo do Traefik deixa o domínio em 404.
