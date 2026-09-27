---
impacto: nada_mudou
secao: corrigido
titulo: Convites de equipe assinados com chave própria
---
O link de convite para a equipe era assinado com o mesmo segredo que autoriza as rotinas automáticas da instalação (`INTERNAL_SECRET`), e sem esse segredo caía numa chave fixa conhecida. Quem tivesse visto o segredo das rotinas, por exemplo num serviço externo de agendamento, conseguia forjar um convite de administrador. Agora o convite usa uma chave própria, derivada desse segredo, e sem segredo configurado o convite não é emitido nem aceito. Convites enviados antes desta atualização e ainda não aceitos deixam de valer (eles duravam 24 horas): quem não aceitou a tempo precisa receber um convite novo pela tela de Equipe.
