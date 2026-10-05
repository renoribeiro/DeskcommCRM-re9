/**
 * A instalação foi feita por um PAINEL de contêineres que guarda as variáveis
 * do serviço? Qual?
 *
 * Nos dois painéis suportados (Dokploy e Docker Manager da Hostinger), o login
 * (GoTrue) lê o SMTP e o modo de cadastro das variáveis do serviço, e só uma
 * nova implantação as aplica — o `update.sh` do kit não existe ali. As telas de
 * /admin dizem isso, e dizem ONDE: ensinar a "aba Environment do Dokploy" a quem
 * está no Docker Manager da Hostinger é instrução errada.
 *
 * Quem marca é o próprio compose (`DEPLOY_MODE` em docker-compose.dokploy.yml e
 * docker-compose.hostinger.yml). Valor desconhecido ou vazio = não é painel.
 *
 * As frases são CHAVES do dicionário (lib/i18n/dicionario.ts): ficam escritas
 * por extenso para o guarda de tradução as enxergar.
 */
export type Painel = "dokploy" | "hostinger";

export interface TextosDoPainel {
  /** Cadastro: por que o modo novo ainda não chegou ao login. */
  cadastroExplica: string;
  /** Cadastro: o que fazer (seguido da chave DISABLE_SIGNUP). */
  cadastroInstrui: string;
  /** E-mail: título do aviso. */
  emailTitulo: string;
  /** E-mail: de onde saem os e-mails do login, e o que fazer. */
  emailExplica: string;
}

export const TEXTOS_DO_PAINEL: Record<Painel, TextosDoPainel> = {
  dokploy: {
    cadastroExplica:
      "Nesta instalação pelo Dokploy, o cadastro direto só acompanha a troca depois de um novo Deploy: o CRM já segue o modo novo, mas o login continua com o modo anterior. Esta tela só avisa — nada é corrigido aqui.",
    cadastroInstrui:
      "No Dokploy, abra o serviço do CRM, ajuste esta chave na aba Environment e clique em Deploy:",
    emailTitulo: "O e-mail do login é configurado no Dokploy.",
    emailExplica:
      'O servidor salvo aqui envia os e-mails do CRM (convites, avisos, LGPD). Os e-mails de "esqueci a senha" e de confirmação de cadastro saem pelas variáveis SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD e SMTP_FROM_EMAIL da aba Environment do serviço no Dokploy. Preencha lá os mesmos dados e clique em Deploy.',
  },
  hostinger: {
    cadastroExplica:
      "Nesta instalação pelo Docker Manager da Hostinger, o cadastro direto só acompanha a troca depois de uma nova implantação: o CRM já segue o modo novo, mas o login continua com o modo anterior. Esta tela só avisa — nada é corrigido aqui.",
    cadastroInstrui:
      "No Docker Manager da Hostinger, abra o projeto do CRM, ajuste esta chave nas variáveis de ambiente e implante de novo:",
    emailTitulo: "O e-mail do login é configurado no Docker Manager da Hostinger.",
    emailExplica:
      'O servidor salvo aqui envia os e-mails do CRM (convites, avisos, LGPD). Os e-mails de "esqueci a senha" e de confirmação de cadastro saem pelas variáveis SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD e SMTP_FROM_EMAIL do projeto no Docker Manager da Hostinger. Preencha lá os mesmos dados e implante de novo.',
  },
};

export function painelDaInstalacao(deployMode: string | undefined): Painel | null {
  return deployMode === "dokploy" || deployMode === "hostinger" ? deployMode : null;
}
