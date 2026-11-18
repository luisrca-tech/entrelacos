import {
  GIFT_PLATFORM_TARIFFS,
  giftMinimumNominalCents,
} from "@entrelacos/contracts";
import { showSandboxNotice } from "@entrelacos/ui";
import { Link } from "@tanstack/react-router";
import { adminStyles } from "../lib/adminStyles";
import { formatCents } from "./financialFlow";

const linkClassName =
  "font-semibold text-admin-accent-hover underline underline-offset-4";
const panelClassName =
  "grid gap-4 rounded-xl border border-admin-border bg-admin-surface p-6 sm:p-8";
const titleClassName = "m-0 font-admin-display text-2xl text-admin-text";
const stepTitleClassName = "m-0 mb-2 text-base font-bold text-admin-text";
const withdrawalFee = formatCents(GIFT_PLATFORM_TARIFFS.withdrawalFeeCents);

export function ReceivingGuide({
  siteId,
  mode,
}: {
  siteId: string;
  mode: string | null;
}) {
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
        O EntreLaços organiza os presentes e os pedidos de saque. A Pagar.me,
        uma empresa Stone, processa os pagamentos, guarda os valores no
        recebedor cadastrado no nome do titular e transfere os saques para a
        conta bancária dele.
      </p>
      {showSandboxNotice(mode) && (
        <aside className={adminStyles.notice} aria-label="Orientação de teste">
          <strong>Ambiente de teste da Pagar.me, sem dinheiro real.</strong> A
          verificação de identidade e os saques de teste não movimentam valores
          nem analisam documentos reais.
        </aside>
      )}
      <section
        className={panelClassName}
        aria-labelledby="receiving-guide-steps"
      >
        <h2 id="receiving-guide-steps" className={titleClassName}>
          Do cadastro ao saque
        </h2>
        <ol className="m-0 grid list-decimal gap-6 pl-6 marker:font-bold marker:text-admin-accent-hover">
          <li className="pl-1">
            <h3 className={stepTitleClassName}>Envie os dados do recebedor</h3>
            <p className="m-0">
              O titular informa nome, e-mail, CPF, celular, data de nascimento,
              renda mensal, profissão, endereço e uma conta bancária no mesmo
              CPF. É para essa conta que os saques vão.
            </p>
            <p className="mt-2 mb-0">
              <Link
                className={linkClassName}
                to="/sites/$siteId/receiving/$page"
                params={{ siteId, page: "details" }}
              >
                Abrir Seus dados
              </Link>
            </p>
          </li>
          <li className="pl-1">
            <h3 className={stepTitleClassName}>Verifique sua identidade</h3>
            <p className="m-0">
              Em Verificar identidade, o painel gera um link seguro da Pagar.me
              e um QR Code para continuar pelo celular. A Pagar.me pede a foto
              de um documento e uma selfie. Cada link vale por 20 minutos; se
              expirar, gere outro.
            </p>
            <p className="mt-2 mb-0">
              <Link
                className={linkClassName}
                to="/sites/$siteId/receiving/$page"
                params={{ siteId, page: "activation" }}
              >
                Abrir Verificar identidade
              </Link>
            </p>
          </li>
          <li className="pl-1">
            <h3 className={stepTitleClassName}>
              Aguarde a análise da Pagar.me
            </h3>
            <p className="m-0">
              A situação do recebedor é atualizada sozinha quando a Pagar.me
              conclui a análise. Para consultar na hora, use Verificar agora.
              Com o cadastro aprovado, os convidados já podem presentear.
            </p>
          </li>
          <li className="pl-1">
            <h3 className={stepTitleClassName}>Solicite o saque</h3>
            <p className="m-0">
              Escolha o valor e confira a prévia: cada saque tem tarifa de{" "}
              {withdrawalFee}, e a prévia mostra o valor líquido antes de você
              confirmar com a senha do EntreLaços. Depois, acompanhe a
              transferência no histórico.
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
          Presentes e saldo
        </h2>
        <p className="m-0">
          Os presentes são contribuições em dinheiro, sem envio de produtos.
          Vocês cadastram quanto querem receber, a partir de{" "}
          {formatCents(giftMinimumNominalCents)} por presente. O convidado paga
          no site do casamento, por Pix ou cartão em até{" "}
          {GIFT_PLATFORM_TARIFFS.maxInstallments}x, e arca com as taxas: vocês
          recebem 100% do valor do presente.
        </p>
        <h3
          id="receiving-guide-credit"
          className="m-0 text-base font-bold text-admin-text"
        >
          Quando o dinheiro fica disponível
        </h3>
        <p className="m-0">
          <strong>Pix:</strong> assim que o pagamento é confirmado.{" "}
          <strong>Cartão (à vista ou parcelado):</strong> o valor inteiro é
          antecipado e fica disponível em cerca de 2 dias.
        </p>
        <p className="m-0">
          Estornos e contestações de cartão aparecem no histórico de pagamentos
          e são descontados do saldo.
        </p>
      </section>
      <div className="grid gap-6 md:grid-cols-2">
        <section
          className={panelClassName}
          aria-labelledby="entrelacos-responsibilities"
        >
          <h2 id="entrelacos-responsibilities" className={titleClassName}>
            No EntreLaços
          </h2>
          <ul className="m-0 grid list-disc gap-2 pl-5">
            <li>Lista de presentes e histórico de pagamentos.</li>
            <li>Cadastro do recebedor e link de verificação de identidade.</li>
            <li>Prévia do saque com a tarifa e o valor líquido.</li>
          </ul>
        </section>
        <section
          className={panelClassName}
          aria-labelledby="provider-responsibilities"
        >
          <h2 id="provider-responsibilities" className={titleClassName}>
            Na Pagar.me
          </h2>
          <ul className="m-0 grid list-disc gap-2 pl-5">
            <li>Processamento do Pix e do cartão.</li>
            <li>Análise do documento, da selfie e do cadastro.</li>
            <li>Guarda do saldo e transferência para a sua conta bancária.</li>
          </ul>
        </section>
      </div>
    </article>
  );
}
