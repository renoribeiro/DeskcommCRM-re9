---
impacto: capacidade_nova
secao: adicionado
titulo: Instalação pelo Docker Manager da Hostinger, com um YAML só
---
Quem usa o Docker Manager do painel da Hostinger agora instala o CRM inteiro, com o Supabase na mesma VPS, colando um único arquivo: `docker-compose.hostinger.yml`. Ele é autocontido — os arquivos do Supabase e o script de preparo vêm dentro dele, porque o painel recebe só o YAML —, usa o Traefik que a Hostinger instala (rotas com o nome do projeto, certificado `letsencrypt`) e não publica porta nenhuma na VPS. As senhas e chaves saem do mesmo `gerar-env.sh` da instalação pelo Dokploy. As telas Administração › E-mail e Administração › Cadastro passam a reconhecer esta instalação e a dizer que o e-mail do login e o modo de cadastro se ajustam nas variáveis do projeto, com uma nova implantação. O passo a passo está em `docs/imobiliario/05-instalacao-hostinger-docker-manager.md`.
