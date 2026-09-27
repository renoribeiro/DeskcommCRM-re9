# Arquivos do Supabase self-hosted (cópia fixa)

Cópia **sem alteração** de `docker/volumes/api/envoy/*` e `docker/volumes/db/*.sql` do
repositório oficial do Supabase, na tag **`self-hosted/v0.8.1`** (commit
`8c7a4d9dbbaf8b552893822e89d7bf06f33f9220`). Essa é a mesma versão que o kit instala
(`SUPABASE_REF` em `hostgator-setup-kit/_common.sh`).

Licença: Apache-2.0 (arquivo `LICENSE` nesta pasta), © Supabase.

Quem usa estes arquivos é o `docker-compose.dokploy.yml`, da raiz do repositório.
**Não edite estes arquivos à mão.** Para trocar a versão do Supabase:

1. copie os mesmos arquivos da nova tag;
2. atualize as imagens do Supabase no `docker-compose.dokploy.yml`;
3. rode `bash tests/shell/dokploy-compose.test.sh`.
