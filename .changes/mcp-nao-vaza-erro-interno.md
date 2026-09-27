---
impacto: nada_mudou
secao: corrigido
titulo: O MCP não mostra mais detalhes internos do banco quando algo falha
---
Quando uma ferramenta do CRM exposta por MCP falhava por um motivo inesperado (banco, rede), a resposta trazia a mensagem crua do banco, com nomes de tabelas e colunas, e ela chegava até o texto que o agente de IA lê. Agora a resposta diz que houve um erro interno e traz um código de requisição (`request_id`) para quem for investigar; o detalhe fica só no log do servidor e na auditoria. Recusas que já eram escritas para quem lê (sem permissão, contato não encontrado, entrada inválida) continuam iguais. As rotinas agendadas do servidor também deixaram de expor a senha interna na lista de processos da VPS: ela passou a ser lida de um arquivo que só o sistema acessa.
