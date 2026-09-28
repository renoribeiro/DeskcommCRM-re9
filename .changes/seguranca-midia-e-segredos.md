---
impacto: nada_mudou
secao: corrigido
titulo: Mídia, provedores de IA e retornos de login externo mais protegidos
---
Uma rodada de correções de segurança, sem nada a configurar:

- A mídia recebida pelo WhatsApp que não é imagem, áudio, vídeo ou PDF agora é baixada em vez de aberta no navegador, e toda mídia servida pelo CRM sai isolada (sem poder executar nada na página).
- O CRM só busca no WhatsApp arquivos de mídia da própria conexão da conversa (o endereço do arquivo tem de trazer a sessão dela), e o endereço de um arquivo enviado pela tela passa por uma conferência estrita antes de ir para o canal.
- O endereço próprio (base URL) de um provedor de IA não pode mais apontar para a rede interna do servidor: a tela recusa ao salvar, e cada chamada confere de novo.
- O retorno das conexões com Google e Nuvemshop passa a ser assinado com uma chave própria, separada da senha dos crons.
- A captação de formulários com segredo configurado recusa o envio (e pede para a ferramenta reenviar) quando o segredo não pode ser lido, em vez de aceitar sem conferir. O motivo aparece no histórico de captações.
- O guia do relógio externo (`docs/runbooks/relogio-http.md`) passa a pedir a `INTERNAL_CRON_SECRET`. Quem já cadastrou a `INTERNAL_SECRET` no GitHub ou no cron-job.org continua funcionando, mas é recomendado trocar pela `INTERNAL_CRON_SECRET` e girar a `INTERNAL_SECRET`.
