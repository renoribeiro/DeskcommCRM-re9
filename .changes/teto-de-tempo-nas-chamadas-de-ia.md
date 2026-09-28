---
impacto: capacidade_nova
secao: corrigido
titulo: Chamada de IA travada não prende mais o atendimento
---
Toda chamada ao modelo de IA agora tem teto de tempo, em dois níveis. Antes, um provedor que aceitava a conexão e não respondia deixava o turno do agente parado e a fila de mensagens esperando atrás dele, e o turno podia acabar repetido. Agora cada requisição ao provedor tem um teto próprio (padrão 90 segundos, variável opcional `LLM_CALL_TIMEOUT_MS`), que não conta o tempo das ferramentas que o agente usa entre um passo e outro, e o turno inteiro tem um teto maior (padrão 5 minutos, variável opcional `LLM_TURN_TIMEOUT_MS`), mantido abaixo da janela da fila para que outro processo nunca pegue o mesmo turno. As buscas na base de conhecimento (embeddings) também passaram a ter teto. Passado qualquer um dos tetos, a chamada é abortada e registrada como falha do provedor no painel de uso de IA, como qualquer outra falha. Os valores são em milissegundos no `.env`; não é preciso mexer em nada para ter o padrão.
