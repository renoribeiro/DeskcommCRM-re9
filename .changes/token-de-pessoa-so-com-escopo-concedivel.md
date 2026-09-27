---
impacto: nada_mudou
secao: corrigido
titulo: As regras de criação de chave de API valem também no banco
---
As regras da tela de Chaves de API — só os escopos oferecidos ali, nenhum nome reservado ao agente de IA e nenhum papel acima do de quem cria — passaram a ser conferidas também pelo próprio banco. Antes, um administrador que gravasse a chave direto pela interface REST do banco, sem passar pela tela, conseguia criar uma chave que se passava pelo agente de IA. As chaves internas do agente e as de integração continuam sendo criadas normalmente pelo servidor, e revogar qualquer chave pela tela continua funcionando. A atualização aplica tudo sozinha.
