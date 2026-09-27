---
impacto: capacidade_nova
secao: adicionado
titulo: Convites e conexões com Google e Nuvemshop podem ter chave de assinatura própria
---
Duas variáveis opcionais, `INVITE_TOKEN_SECRET` e `OAUTH_STATE_SECRET`, dão aos convites de equipe e ao retorno das conexões com Google e Nuvemshop uma chave de assinatura própria. Sem elas, nada muda: as duas chaves continuam derivadas do `INTERNAL_SECRET`, que também é a senha dos agendamentos — e quem tivesse esse segredo conseguiria forjar um convite ou o retorno de uma conexão. A instalação pelo Dokploy já gera as duas. Numa instalação existente, defini-las invalida só os convites ainda não aceitos (quem não aceitou recebe outro) e as conexões que estiverem no meio da tela de autorização naquele momento.
