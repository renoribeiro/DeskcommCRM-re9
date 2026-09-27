---
impacto: nada_mudou
secao: corrigido
titulo: Cadastrar contato com CPF volta a funcionar, com o CPF cifrado de verdade
---
Salvar ou importar um contato com CPF falhava sempre: o sistema dependia de uma função de cifra que não existia no banco, e o banco recusava o CPF sem a cifra. Agora o CPF é cifrado no próprio servidor com a `CPF_ENCRYPTION_KEY` que o instalador já gera, e a busca por CPF usa um hash com chave, que não se reverte olhando só o banco. Se a instalação estiver sem essa chave, o CRM avisa com clareza em vez de falhar: o contato pode ser salvo sem CPF. A cifragem ao decifrar também passou a conferir o tamanho exato da assinatura, fechando uma brecha de adulteração das chaves de IA guardadas.
