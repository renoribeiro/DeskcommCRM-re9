---
impacto: nada_mudou
secao: corrigido
titulo: O YAML da Hostinger passa a ser aceito pelo editor do Docker Manager
---
O editor YAML do Docker Manager da Hostinger recusava o `docker-compose.hostinger.yml` da 1.58.0 ("O arquivo YAML não pôde ser processado"). Ele é mais estrito que o Docker Compose: recusou os acentos e, depois, os blocos `x-` no topo, o `<<:` e os arquivos do Supabase embutidos no próprio YAML. O arquivo agora é pequeno, 100% ASCII e usa só o que um YAML comum do painel usa. Os arquivos do Supabase (inicialização do banco e configuração do gateway) passam a ser baixados da tag da versão por um serviço próprio, `arquivos`, a cada implantação, como o preparo já baixa o schema do banco. O bloco de variáveis que o `gerar-env.sh` imprime também passou a ser só ASCII. Quem instala pela Hostinger usa o YAML da 1.58.1 ou mais nova; as imagens da 1.58.0 servem do mesmo jeito.
