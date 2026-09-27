---
impacto: capacidade_nova
secao: corrigido
titulo: Chamada de IA travada não prende mais o atendimento
---
Toda chamada ao modelo de IA agora tem um teto de tempo. Antes, um provedor que aceitava a conexão e não respondia deixava o turno do agente parado e a fila de mensagens esperando atrás dele, e o turno podia acabar repetido. Passado o teto, a chamada é abortada e registrada como falha do provedor no painel de uso de IA, como qualquer outra falha. O padrão é 90 segundos e pode ser ajustado com a nova variável opcional `LLM_CALL_TIMEOUT_MS` (em milissegundos) no `.env`; não é preciso mexer em nada para ter o padrão.
