---
impacto: nada_mudou
secao: alterado
titulo: O envio de mensagem pela API não aceita mais media_url
---
`POST /api/v1/messages` e a ferramenta MCP `crm_send_whatsapp_message` recusam o campo `media_url` com erro de validação. O campo nunca enviou a mídia ao contato — só o `media_storage_path` envia —, e a URL gravada podia ser usada para ler dados de outras conexões. Para mandar um arquivo, suba-o em `POST /api/v1/conversations/{id}/media` e envie o `media_storage_path` devolvido. A ferramenta MCP `crm_send_whatsapp_message` passa a aceitar `media_storage_path`; a `crm_start_conversation_and_send` deixa de aceitar mídia (mande o arquivo numa segunda chamada). Os limites de `won_reason` no `/win` (500 caracteres) e do corpo do `PATCH /api/v1/channels/templates` agora são validados.
