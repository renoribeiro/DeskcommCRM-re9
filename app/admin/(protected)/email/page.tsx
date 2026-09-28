import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { getSmtpConfig } from "@/lib/email/config";
import { transporteEmVigor } from "@/lib/email/roteador";
import { CATALOGO_DA_INSTALACAO } from "@/lib/instalacao/catalogo";
import { estadoParaTela } from "@/lib/instalacao/config";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";

import { FormularioDeSmtp } from "./_form";

export const metadata = { title: "Servidor de e-mail da instalação" };
export const dynamic = "force-dynamic";

/**
 * A tela onde o dono da instalação cadastra o servidor SMTP que manda os
 * e-mails do produto — convite de equipe, entrega de export de LGPD e alarme
 * de SLA.
 *
 * ── Por que `/admin`, e não `/app/settings` ──────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO: um servidor SMTP manda o e-mail de todas as empresas
 * desta VPS. Deixar o admin de um tenant trocá-lo derrubaria (ou redirecionaria)
 * o e-mail de TODOS. Irmã de `/admin/meta` e `/admin/google`, que são o molde.
 *
 * A versão original desta tela (PR #714) vivia em `/app/settings/resend`, e o
 * sintoma disso estava no próprio PR: o autor precisou inventar um
 * `platformOnly: true` no catálogo de navegação do TENANT para esconder da
 * empresa uma tela que estava no menu da empresa. Movida para cá, a exceção
 * deixa de existir.
 *
 * ── Por que `notFound()` ────────────────────────────────────────────────────
 *
 * Mesma decisão e mesma frase de `/admin/meta`: o layout de `(protected)` já
 * roda `requirePlatformAdmin()`, e o gate local fica porque um layout pode ser
 * movido.
 *
 * ⚠️ A SENHA NÃO ATRAVESSA A FRONTEIRA. `getSmtpConfig()` a decifra porque o
 * transporte precisa dela no servidor; a TELA não precisa — para desenhar o
 * campo basta saber que existe uma senha gravada, e é só isso que chega ao
 * componente de cliente. Mesma disciplina de `temSegredoSalvo` em
 * `/admin/google` e `/admin/meta`, e vigiado em
 * `tests/unit/tela-de-smtp-nao-devolve-a-senha.test.tsx`.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const config = await getSmtpConfig();
  const transporte = await transporteEmVigor();

  /**
   * O SERVIÇO EXTERNO MORA AQUI DESDE O DEC-009 (opção A).
   *
   * A chave e o remetente do serviço externo ficavam em `/admin/configuracao`,
   * e o servidor próprio aqui. É um assunto só — "como o meu servidor manda
   * e-mail" — e quem instalava abria esta tela, não achava o serviço externo e
   * concluía que ele não era suportado.
   *
   * Quem decide o que aparece é o CATÁLOGO (`telaDona`), não uma lista escrita
   * aqui: enquanto a fonte for uma só, não há como as duas telas oferecerem a
   * mesma chave — e, se um dia oferecerem, o defeito é de catálogo e aparece
   * num lugar só.
   */
  const doServicoExterno = await Promise.all(
    CATALOGO_DA_INSTALACAO.filter((d) => d.telaDona === "email").map(async (definicao) => ({
      definicao,
      estado: await estadoParaTela(definicao.chave, definicao.natureza === "segredo"),
    })),
  );

  // Instalação pelo Dokploy: o SMTP salvo aqui vale para os e-mails do CRM, mas
  // o login (GoTrue) lê as SMTP_* do Environment do serviço — o kit copia de um
  // para o outro no update.sh; no Dokploy, quem copia é a pessoa, e esta tela diz.
  const viaDokploy = env.DEPLOY_MODE === "dokploy";
  const idioma = normalizarIdioma(usuario.locale);

  const formulario = (
    <FormularioDeSmtp
      host={config.host}
      porta={config.port}
      seguranca={config.security}
      usuario={config.username}
      remetente={config.fromEmail}
      nomeDoRemetente={config.fromName}
      temSenhaSalva={Boolean(config.password)}
      // Onde está o que vale. Sem isto, quem preencheu as `SMTP_*` no `.env`
      // abre a tela com os campos JÁ cheios e não tem como saber que o que
      // salvar aqui passa a valer no lugar do arquivo.
      origem={config.source}
      // QUEM ESTÁ ENTREGANDO. Sem isto, a instalação que manda e-mail pela
      // Resend abre a única tela de e-mail do produto e lê "não está em uso" —
      // verdade sobre o SMTP, e leitura errada sobre o sistema.
      transporte={transporte}
      servicoExterno={doServicoExterno}
      // O mesmo idioma que a tela de Credenciais usa nos campos iguais a estes:
      // eles são o MESMO componente, e traduzir por caminhos diferentes seria
      // como as duas telas voltariam a divergir.
      idioma={idioma}
    />
  );
  if (!viaDokploy) return formulario;

  return (
    <div className="space-y-6">
      <div
        role="status"
        className="rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-950/20"
      >
        <p className="font-medium">
          {traduzir("O e-mail do login é configurado no Dokploy.", idioma)}
        </p>
        <p className="mt-1">
          {traduzir(
            "O servidor salvo aqui envia os e-mails do CRM (convites, avisos, LGPD). Os e-mails de \"esqueci a senha\" e de confirmação de cadastro saem pelas variáveis SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD e SMTP_FROM_EMAIL da aba Environment do serviço no Dokploy. Preencha lá os mesmos dados e clique em Deploy.",
            idioma,
          )}
        </p>
      </div>
      {formulario}
    </div>
  );
}
