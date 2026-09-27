---
impacto: capacidade_nova
secao: adicionado
titulo: Instalação com o Supabase na mesma VPS funciona atrás do Traefik da hospedagem
---
O instalador que põe o CRM e o Supabase na mesma VPS (`install-single-server.sh`) agora detecta um Traefik que já ocupa as portas 80/443, como o do Dokploy, do Coolify ou da Hostinger, e publica o CRM e as APIs do Supabase por ele, sem subir um segundo proxy. Numa VPS sem proxy nada muda: o Caddy próprio continua subindo como antes.
