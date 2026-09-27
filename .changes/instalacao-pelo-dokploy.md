---
impacto: capacidade_nova
secao: adicionado
titulo: Instalação pelo painel do Dokploy, com o Supabase na mesma VPS
---
Quem usa o Dokploy agora instala o CRM inteiro pelo painel: um serviço Compose apontando para `docker-compose.dokploy.yml` sobe o Supabase e o CRM juntos, atrás do Traefik do próprio Dokploy, e prepara o banco e o primeiro administrador sozinho a cada deploy. As senhas e chaves saem prontas do `infra/dokploy/gerar-env.sh`, para colar na aba Environment. O passo a passo está em `docs/imobiliario/03-instalacao-vps-dokploy.md`.
