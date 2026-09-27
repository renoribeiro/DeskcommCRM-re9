---
impacto: nada_mudou
secao: corrigido
titulo: Os tokens temporários do agente de IA voltam a ser apagados pela limpeza diária
---
Cada atendimento do agente de IA cria uma chave temporária de 5 minutos. A limpeza diária deveria apagar as vencidas, mas não apagava nenhuma: a auditoria de cada ferramenta usada pelo agente citava a chave de um jeito que a limpeza, para não alterar o histórico de auditoria, era obrigada a preservar. Agora a auditoria das ferramentas do agente guarda a identificação da chave temporária só nos detalhes do registro, e a limpeza volta a removê-las. A auditoria continua mostrando qual atendimento fez cada ação. Chaves criadas por pessoas e integrações seguem registradas como antes.
