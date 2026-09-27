---
impacto: nada_mudou
secao: alterado
titulo: O envio de mensagem pela API ignora media_url
---
`POST /api/v1/messages` passa a descartar o campo `media_url`: ele não é mais gravado na mensagem. O campo nunca enviou a mídia ao contato — só o `media_storage_path` envia —, e a URL gravada podia ser usada para ler dados de outras conexões. Quem manda `body` junto com `media_url` continua recebendo 2xx e o texto continua saindo, como antes; só `media_url`, sem texto nem `media_storage_path`, é recusado por falta de conteúdo (antes era aceito e nada chegava ao contato). Para mandar um arquivo, suba-o em `POST /api/v1/conversations/{id}/media` e envie o `media_storage_path` devolvido. A ferramenta MCP `crm_send_whatsapp_message` passa a aceitar `media_storage_path` e ignora `media_url`; a `crm_start_conversation_and_send` deixa de aceitar mídia (mande o arquivo numa segunda chamada). No `/win`, `won_reason` passa a ser validado (texto de até 500 caracteres), e um corpo que não é objeto JSON, ou um `won_reason` que não é texto, agora recebe 422 em vez de ser ignorado. O corpo do `PATCH /api/v1/channels/templates` também passa a ser validado.
