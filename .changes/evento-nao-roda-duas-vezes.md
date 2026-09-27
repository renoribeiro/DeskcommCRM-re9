---
impacto: nada_mudou
secao: corrigido
titulo: Evento interno não é mais processado duas vezes quando dois processos recuperam a fila ao mesmo tempo
---
A recuperação de eventos internos que ficaram presos (por exemplo, depois de um reinício no meio do processamento) podia, com o processo de fundo e o agendador do app agindo no mesmo instante, devolver à fila um evento que outro processo tinha acabado de pegar. O evento rodava de novo em paralelo, o que podia repetir o preparo de um material ou o aviso de um evento. Agora a recuperação só devolve à fila exatamente o evento preso que ela leu.
