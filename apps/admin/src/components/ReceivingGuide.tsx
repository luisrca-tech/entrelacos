import {
  giftInstallmentExpiryMinutes,
  giftMinimumNominalCents,
} from "@entrelacos/contracts";
import { showSandboxNotice } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { adminStyles } from "../lib/adminStyles";
import { formatCents } from "./financialFlow";

const linkClassName =
  "font-semibold text-admin-accent-hover underline underline-offset-4";
const panelClassName =
  "grid gap-4 rounded-xl border border-admin-border bg-admin-surface p-6 sm:p-8";
const titleClassName = "m-0 font-admin-display text-2xl text-admin-text";

function OfficialLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      className={linkClassName}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <span className="sr-only"> (abre em outra aba)</span>
    </a>
  );
}

export function ReceivingGuide({
  siteId,
  mode,
}: {
  siteId: string;
  mode: string | null;
}) {
  const sandbox = mode === "sandbox";
  const loginUrl = sandbox
    ? "https://sandbox.asaas.com/login/auth?customerSignUpOriginChannel=HOME"
    : mode === "live"
      ? "https://www.asaas.com/login/auth?customerSignUpOriginChannel=HOME"
      : null;

  return (
    <article className="grid max-w-5xl gap-6 leading-relaxed text-admin-text-secondary">
      <Link
        className={`${linkClassName} w-fit`}
        to="/sites/$siteId/receiving"
        params={{ siteId }}
      >
        ← Voltar para Recebimentos
      </Link>
      <p className="m-0 max-w-3xl text-base">
        O Entrelacos organiza os presentes e os pedidos de saque. O Asaas mantém
        a conta do recebedor e faz as verificações e transferências. Siga estas
        etapas com o titular da conta.
      </p>
      {showSandboxNotice(mode) && (
        <aside className={adminStyles.notice} aria-label="Orientação de teste">
          <strong>Ambiente de teste, sem dinheiro real.</strong> No Sandbox, o
          link de definição de senha e as comunicações de teste vão para o
          e-mail da conta principal do Asaas. Depois de definir a senha, entre
          com o e-mail cadastrado para o recebedor. O acesso de teste é separado
          da conta de produção.
        </aside>
      )}
      <section className={panelClassName} aria-labelledby="asaas-access-links">
        <h2 id="asaas-access-links" className={titleClassName}>
          Acesse o Asaas com segurança
        </h2>
        {loginUrl ? (
          <p className="m-0">
            <OfficialLink href={loginUrl}>
              {sandbox
                ? "Entrar no Asaas Sandbox pelo navegador"
                : "Entrar no Asaas pelo navegador"}
            </OfficialLink>
          </p>
        ) : (
          <p className="m-0">
            Não foi possível identificar o ambiente da conta. Volte para
            Recebimentos e verifique a situação antes de acessar o Asaas.
          </p>
        )}
        <p className="m-0">
          <OfficialLink href="https://central.ajuda.asaas.com/hc/pt-br">
            Central de ajuda do Asaas
          </OfficialLink>
        </p>
        {sandbox && (
          <p className="m-0">
            <OfficialLink href="https://central.ajuda.asaas.com/hc/pt-br/articles/32107684279579-Como-acessar-o-ambiente-de-testes-Sandbox-do-Asaas">
              Como acessar o ambiente de testes
            </OfficialLink>
          </p>
        )}
        <details>
          <summary className="cursor-pointer font-semibold text-admin-text">
            Aplicativos e segurança do acesso
          </summary>
          <div className="mt-3 grid gap-3">
            <p className="m-0">
              O aplicativo é opcional para acessar sua conta e, quando
              habilitado pelo Asaas, usar o Token App. Para contas de produção:{" "}
              <OfficialLink href="https://play.google.com/store/apps/details?id=asaas.asaas">
                Asaas para Android
              </OfficialLink>{" "}
              ou{" "}
              <OfficialLink href="https://apps.apple.com/br/app/asaas-plataforma-para-empresa/id1421133076">
                Asaas para iPhone
              </OfficialLink>
              .
              {showSandboxNotice(mode) &&
                " Para testes no Sandbox, siga o acesso pelo navegador."}
            </p>
            <p className="m-0">
              Um dispositivo novo pode exigir validações ou ter limites
              definidos pelo Asaas. Siga as instruções da sua conta e mantenha
              os controles de segurança. A ativação do Token App também depende
              das verificações do Asaas.
            </p>
            <p className="m-0">
              <OfficialLink href="https://central.ajuda.asaas.com/hc/pt-br/articles/32094322891291-O-que-%C3%A9-o-Token-App">
                Entenda o Token App e o dispositivo seguro
              </OfficialLink>
            </p>
          </div>
        </details>
      </section>
      <section
        className={panelClassName}
        aria-labelledby="receiving-guide-steps"
      >
        <h2 id="receiving-guide-steps" className={titleClassName}>
          Do cadastro ao saque
        </h2>
        <ol className="m-0 grid list-decimal gap-6 pl-6 marker:font-bold marker:text-admin-accent-hover">
          <li className="pl-1">
            <h3 className="m-0 mb-2 text-base font-bold text-admin-text">
              Confirme o recebedor no Entrelacos
            </h3>
            <p className="m-0">
              Em Recebimentos, confirme o titular designado, os dados e o
              e-mail. O próprio titular deve consentir com a abertura da conta e
              a preparação automática do Pix. Use a conta criada por este fluxo;
              não abra outra conta Asaas para tentar vinculá-la ao casamento.
            </p>
            <p className="mt-2 mb-0">
              <Link
                className={linkClassName}
                to="/sites/$siteId/receiving/$page"
                params={{ siteId, page: "activation" }}
              >
                Abrir Ativação
              </Link>
            </p>
          </li>
          <li className="pl-1">
            <h3 className="m-0 mb-2 text-base font-bold text-admin-text">
              Ative o acesso ao Asaas
            </h3>
            <p className="m-0">
              No fluxo padrão com acesso direto, o e-mail de ativação é enviado
              automaticamente pelo Asaas na criação da conta. Abra o link e
              defina sua senha no próprio Asaas. Se houver uma jornada integrada
              de cadastro, conclua as etapas apresentadas por ela.
            </p>
            <p className="mt-2 mb-0">
              Confira o e-mail e o spam. Se o acesso ainda não funcionar, use a
              recuperação de senha ou o suporte do Asaas. O Entrelacos não
              define sua senha do Asaas nem recebe seus códigos de segurança.
            </p>
            <p className="mt-2 mb-0">
              <OfficialLink href="https://docs.asaas.com/docs/criacao-de-subcontas">
                Como funciona a criação da conta
              </OfficialLink>
            </p>
          </li>
          <li className="pl-1">
            <h3 className="m-0 mb-2 text-base font-bold text-admin-text">
              Conclua as verificações da conta
            </h3>
            <p className="m-0">
              No Asaas, em Minha conta, confirme seu celular com o código
              recebido por SMS. Envie os documentos solicitados e faça a selfie,
              quando solicitado, no próprio Asaas. Depois, aguarde a análise e a
              aprovação da conta.
            </p>
            <p className="mt-2 mb-0">
              Após a aprovação, o EntreLaços prepara automaticamente o
              recebimento por Pix. Volte a Recebimentos e use Verificar situação
              para acompanhar a liberação. A aprovação cadastral não confirma a
              ativação do seu acesso: a senha e as etapas de segurança são
              tratadas no Asaas.
            </p>
            <p className="mt-2 mb-0">
              <OfficialLink href="https://docs.asaas.com/docs/aprova%C3%A7%C3%A3o-de-contas">
                Entenda a aprovação de contas
              </OfficialLink>
            </p>
          </li>
          <li className="pl-1">
            <h3 className="m-0 mb-2 text-base font-bold text-admin-text">
              Configure o destino do saque no Entrelacos
            </h3>
            <p className="m-0">
              O EntreLaços prepara os recebimentos com uma chave aleatória na
              sua conta Asaas, sem alterar as chaves do seu banco. Você
              configura apenas o destino do saque: cadastre e confirme a chave
              Pix da sua própria conta bancária na área de Recebimentos. Essa
              chave não precisa ser criada no Asaas e não é transferida para
              ele.
            </p>
            <p className="mt-2 mb-0">
              <OfficialLink href="https://central.ajuda.asaas.com/hc/pt-br/articles/32012176043931-Como-cadastrar-chaves-Pix-no-Asaas">
                Para que servem as chaves Pix no Asaas
              </OfficialLink>
            </p>
            <p className="mt-2 mb-0">
              <Link
                className={linkClassName}
                to="/sites/$siteId/receiving/$page"
                params={{ siteId, page: "account" }}
              >
                Configurar conta para saque
              </Link>
            </p>
          </li>
          <li className="pl-1">
            <h3 className="m-0 mb-2 text-base font-bold text-admin-text">
              Revise o valor e solicite o saque
            </h3>
            <p className="m-0">
              No Entrelacos, confira o saldo disponível, o destino e as taxas na
              prévia. Revise o consentimento e confirme sua senha do Entrelacos
              para solicitar o saque. Depois, acompanhe o histórico.
            </p>
            <p className="mt-2 mb-0">
              Quando a autorização integrada de segurança estiver habilitada e a
              configuração do Asaas permitir, o pedido pode ser autorizado pelo
              próprio Entrelacos. Se a integração não estiver habilitada ou
              houver autorização manual exigida pelo Asaas, o titular deve
              concluir as confirmações no Asaas, como SMS ou Token App.
            </p>
            <p className="mt-2 mb-0">
              A autorização não confirma a conclusão do saque. A liberação e a
              transferência final dependem do Asaas e da instituição de destino.
            </p>
            <p className="mt-2 mb-0">
              <OfficialLink href="https://central.ajuda.asaas.com/hc/pt-br/articles/32059472076059-Como-solicitar-uma-transfer%C3%AAncia">
                Como o Asaas autoriza transferências
              </OfficialLink>
            </p>
            <p className="mt-2 mb-0">
              <Link
                className={linkClassName}
                to="/sites/$siteId/receiving/$page"
                params={{ siteId, page: "withdrawals" }}
              >
                Consultar e acompanhar saques
              </Link>
            </p>
          </li>
        </ol>
      </section>
      <section
        className={panelClassName}
        aria-labelledby="receiving-guide-gifts"
      >
        <h2 id="receiving-guide-gifts" className={titleClassName}>
          Presentes, taxas e saldo
        </h2>
        <p className="m-0">
          Os presentes são contribuições em dinheiro, sem envio de produtos.
          Vocês cadastram quanto querem receber, a partir de{" "}
          {formatCents(giftMinimumNominalCents)} por presente. O convidado paga
          as taxas, então vocês recebem 100% do valor do presente. Se escolher
          parcelar no cartão, vê o valor das parcelas e o total antes de pagar.
        </p>
        <p className="m-0">
          Ao abrir uma cobrança, o convidado ainda precisa concluir o pagamento
          no Asaas. O presente aparece no histórico após a confirmação do
          pagamento ou o registro de crédito. A cobrança parcelada tem prazo de{" "}
          {giftInstallmentExpiryMinutes} minutos a partir da emissão. Após esse
          prazo, o convidado pode tentar novamente quando o Asaas confirmar o
          encerramento da cobrança anterior.
        </p>
        <h3
          id="receiving-guide-credit"
          className="m-0 text-base font-bold text-admin-text"
        >
          Quando o dinheiro fica disponível
        </h3>
        <p className="m-0">
          A confirmação indica que o convidado pagou. O valor fica aguardando
          liberação até o Asaas creditá-lo. Depois do crédito, ele pode compor o
          saldo disponível para saque.
        </p>
        <p className="m-0">
          Vocês recebem o valor de cada parcela conforme o cartão libera,
          normalmente em até 32 dias por parcela; no Pix, assim que o pagamento
          é confirmado. Confiram a atualização do saldo no painel.
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <OfficialLink href="https://central.ajuda.asaas.com/hc/pt-br/articles/53178101435163-Qual-%C3%A9-o-prazo-de-compensa%C3%A7%C3%A3o-de-cart%C3%A3o-de-cr%C3%A9dito-no-Asaas">
            Prazos de liberação no cartão
          </OfficialLink>
        </div>
        <h3 className="m-0 text-base font-bold text-admin-text">
          Saques e estornos
        </h3>
        <p className="m-0">
          <strong>Saques via Pix são gratuitos e ilimitados</strong> para contas
          recebedoras cadastradas como pessoa física (PF) ou MEI. O EntreLaços
          não cobra taxa adicional pelo saque. Para outros tipos de empresa,
          confira as condições da conta e as taxas na prévia antes de confirmar.
        </p>
        <p className="m-0">
          <OfficialLink href="https://central.ajuda.asaas.com/hc/pt-br/articles/32059618254875-Como-funcionam-as-taxas-e-a-gratuidade-para-transfer%C3%AAncias-Pix-no-Asaas">
            Consulte as condições das transferências Pix
          </OfficialLink>
        </p>
        <p className="m-0">
          Após a efetivação do saque via Pix, o dinheiro costuma chegar ao banco
          em alguns instantes. Antes do envio, o pedido pode aguardar
          autorização ou análise de segurança. Acompanhem a conclusão no
          histórico.
        </p>
        <p className="m-0">
          Para tratar um estorno, confira o pagamento no Asaas. O andamento
          depende da forma de pagamento, da situação da cobrança e do saldo
          necessário para a devolução. No cartão, o prazo para aparecer na
          fatura depende do processamento do estorno.
        </p>
        <p className="m-0">
          <OfficialLink href="https://docs.asaas.com/docs/estornos">
            Entenda os estornos no Asaas
          </OfficialLink>
        </p>
      </section>
      <div className="grid gap-6 md:grid-cols-2">
        <section
          className={panelClassName}
          aria-labelledby="entrelacos-responsibilities"
        >
          <h2 id="entrelacos-responsibilities" className={titleClassName}>
            No Entrelacos
          </h2>
          <ul className="m-0 grid list-disc gap-2 pl-5">
            <li>Presentes registrados e situação dos recebimentos.</li>
            <li>Cadastro e confirmação do destino externo para saque.</li>
            <li>Prévia do destinatário, dos valores e das taxas.</li>
            <li>
              Consentimento, pedido de saque e acompanhamento do histórico.
            </li>
          </ul>
        </section>
        <section
          className={panelClassName}
          aria-labelledby="asaas-responsibilities"
        >
          <h2 id="asaas-responsibilities" className={titleClassName}>
            No Asaas
          </h2>
          <ul className="m-0 grid list-disc gap-2 pl-5">
            <li>Ativação, senha e recuperação do acesso.</li>
            <li>Documentos e aprovação cadastral da conta.</li>
            <li>Dispositivo seguro, SMS, Token App e confirmações exigidas.</li>
            <li>Processamento e liberação da transferência ao banco.</li>
          </ul>
        </section>
      </div>
    </article>
  );
}
