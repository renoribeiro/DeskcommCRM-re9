---
impacto: nada_mudou
secao: corrigido
titulo: O YAML da Hostinger passa a ser aceito pelo editor do Docker Manager
---
O editor YAML do Docker Manager da Hostinger recusava o `docker-compose.hostinger.yml` da 1.58.0 já na primeira linha ("O arquivo YAML não pôde ser processado"), por causa dos acentos nos comentários. O arquivo agora é 100% ASCII: os comentários perderam o acento, e os arquivos embutidos que têm acento (as mensagens do script de preparo) entram com escapes, de modo que o contêiner recebe exatamente o mesmo conteúdo. O bloco de variáveis que o `gerar-env.sh` imprime também passou a ser só ASCII. Quem instala pela Hostinger usa o YAML da 1.58.1 ou mais nova; as imagens da 1.58.0 servem do mesmo jeito.
