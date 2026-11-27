import { GIFT_PLATFORM_TARIFFS } from "../../../packages/contracts/src/giftTariffs";
import { faqPricingExampleNominalCents, formatBrl } from "./faqPricingExample";
import {
  exclusiveDeliveryLabel,
  formatPlanPrice,
  SITE_PLANS,
  siteDeliveryLabel,
  siteOnlineLabel,
} from "./landingOffer";

const { maxInstallments } = GIFT_PLATFORM_TARIFFS;
const minimumInstallment = formatBrl(
  GIFT_PLATFORM_TARIFFS.minimumInstallmentCents,
);
const withdrawalFee = formatBrl(GIFT_PLATFORM_TARIFFS.withdrawalFeeCents);
const exampleGift = formatBrl(faqPricingExampleNominalCents);
const commission = `${GIFT_PLATFORM_TARIFFS.commissionBasisPoints / 100}%`;
const modelPrice = formatPlanPrice(SITE_PLANS.model.priceCents);
const exclusivePrice = formatPlanPrice(SITE_PLANS.exclusive.fromCents);

export type FaqQuestion = {
  question: string;
  answer: string;
  reference?: { label: string; href: string };
};

export type FaqTopic = {
  id: string;
  title: string;
  questions: FaqQuestion[];
};

export const faqTopics: FaqTopic[] = [
  {
    id: "como-funciona",
    title: "Como funciona o Entrelaços",
    questions: [
      {
        question: "O que podemos reunir no nosso site?",
        answer:
          "A história de vocês, fotos, informações da cerimônia e da recepção, confirmação de presença, mural de mensagens e lista de presentes em dinheiro. O Entrelaços prepara o site com vocês. Pelo painel, vocês acompanham os convidados e gerenciam os recursos disponíveis para o casamento.",
      },
      {
        question: "Quanto custa e em quanto tempo o site fica pronto?",
        answer: `O Site Modelo custa ${modelPrice} e segue um dos nossos estilos, com as fotos, as cores e os textos de vocês. Ele inclui o site completo e o painel do casal, com convidados, confirmações, lista de presentes, recebimentos e mural. Fica pronto em ${siteDeliveryLabel}, contados a partir do dia em que recebemos todo o material. O Site Exclusivo, com seções e estrutura feitas sob medida, começa em ${exclusivePrice}, com valor combinado antes de fechar e prazo de ${exclusiveDeliveryLabel}. O pagamento do site pode ser feito no Pix, boleto ou cartão em até ${SITE_PLANS.model.maxInstallments}x.`,
      },
      {
        question: "Como é feito o site, do primeiro contato à publicação?",
        answer:
          "Vocês nos chamam no WhatsApp e fechamos o plano. Depois, enviam fotos, vídeos, textos e informações do evento; se ainda não tiverem tudo pronto, pensamos juntos. O prazo começa a contar quando recebemos todo o material. Dentro dele, montamos o site, ajustamos os detalhes com vocês e entregamos a versão aprovada. A nossa equipe acompanha vocês do fechamento ao lançamento e segue disponível para suporte enquanto o site estiver no ar.",
      },
      {
        question: "Por quanto tempo o site fica no ar?",
        answer: `O site fica no ar ${siteOnlineLabel}. Depois, ele é retirado do ar e apagamos os dados do casamento, como a lista de convidados, as confirmações e os recados. Antes disso, vocês podem baixar a lista de convidados e as confirmações em CSV ou PDF pelo painel.`,
      },
      {
        question: "Os convidados precisam criar uma conta?",
        answer:
          "Não. As informações do casamento ficam no site. Para confirmar presença, a família usa o telefone de contato cadastrado e o PIN recebido com o convite. Ao pagar um presente, o convidado informa os dados solicitados no fluxo de pagamento.",
      },
      {
        question: "Como vocês usam os nossos dados e os dos convidados?",
        answer:
          "Só para fazer o site e o painel funcionarem. O CPF, o endereço e os dados bancários do titular servem para criar a conta de recebimentos na Pagar.me e enviar os saques para a conta que vocês escolherem. Os dados dos convidados servem para confirmar presença, publicar recados e processar presentes. Não vendemos dados. Os detalhes estão na política de privacidade, no rodapé do site.",
      },
      {
        question: "Podemos usar o painel pelo celular e compartilhar o acesso?",
        answer:
          "Sim. O site e o painel se adaptam ao celular. Vocês também podem convidar pessoas para a equipe do casamento, com permissões próprias. Assim, cada pessoa usa seu acesso, sem precisar compartilhar a senha do casal.",
      },
    ],
  },
  {
    id: "personalizacao",
    title: "Personalização do site",
    questions: [
      {
        question: "O site pode seguir a nossa identidade visual?",
        answer:
          "Sim. Alinhamos cores, tipografia, fotos e textos às preferências e à identidade visual de vocês. Podem compartilhar referências, o convite e outros materiais do casamento para orientar essa personalização.",
      },
      {
        question: "Podemos mudar a estrutura de algumas seções?",
        answer:
          "Podemos alinhar adaptações na estrutura de algumas seções de acordo com o gosto do casal. Contem o que gostariam de mudar: avaliamos a proposta, a experiência no celular e o escopo antes de combinar a implementação, os valores e os prazos envolvidos.",
      },
      {
        question: "Precisamos saber programar ou montar o site?",
        answer:
          "Não. O Entrelaços cuida da montagem e da publicação. Vocês enviam o conteúdo e as referências e revisam o resultado com a equipe. O painel fica disponível para as tarefas do dia a dia, como convidados, mensagens e presentes.",
      },
      {
        question: "Podemos atualizar o site depois de publicado?",
        answer:
          "Vocês podem gerenciar pelo painel os recursos disponíveis para o casamento. Para ajustes de identidade visual, textos das seções ou estrutura do site, falem com a equipe para alinharmos a atualização conforme o escopo contratado.",
      },
    ],
  },
  {
    id: "presentes",
    title: "Presentes e pagamentos",
    questions: [
      {
        question: "Os presentes são produtos físicos?",
        answer:
          "Não. São contribuições em dinheiro representadas por itens simbólicos, como um jantar ou uma experiência na lua de mel. Não há envio de produtos. O casal cadastra o valor que deseja receber por cada presente, a partir de R$ 5,00.",
      },
      {
        question: "Mais de uma pessoa pode escolher o mesmo presente?",
        answer:
          "Sim. Um presente pode receber várias contribuições. O pagamento de um convidado não retira o item da lista nem impede outras pessoas de escolhê-lo. Vocês controlam quais presentes ficam publicados.",
      },
      {
        question: "Quais formas de pagamento estão disponíveis?",
        answer: `Pix e cartão de crédito, à vista ou em até ${maxInstallments}x. Cada parcela precisa ter pelo menos ${minimumInstallment}, então presentes de valor baixo oferecem menos opções de parcelamento. O convidado vê o total e o valor de cada parcela antes de confirmar.`,
      },
      {
        question: "Os dados de pagamento ficam seguros?",
        answer:
          "O número do cartão vai direto do navegador do convidado para a Pagar.me, que devolve um código no lugar dele. O Entrelaços recebe só esse código, nunca o número nem o CVV. No Pix, o convidado paga pelo aplicativo do banco, com o QR Code ou o código copia e cola.",
      },
      {
        question: "Abrir o pagamento já conta como um presente recebido?",
        answer:
          "Não. Escolher um presente ou abrir o checkout não confirma a compra. Tentativas sem pagamento não aparecem como recebimentos do casal. O histórico passa a exibir o pagamento após a confirmação ou o registro de crédito; a disponibilidade para saque depende da liberação do valor.",
      },
    ],
  },
  {
    id: "taxas",
    title: "Taxas e parcelamento",
    questions: [
      {
        question: "Como as taxas entram no preço do presente?",
        answer: `Vocês cadastram quanto desejam receber. O preço mostrado ao convidado soma a esse valor a taxa do meio de pagamento, as tarifas fixas da compra (cobradas uma vez, não por parcela) e o serviço Entrelaços de ${commission}.`,
      },
      {
        question: "Quanto o casal recebe?",
        answer: `100% do valor cadastrado. Em um presente de ${exampleGift}, entram ${exampleGift} no saldo de vocês, no Pix ou no cartão, em qualquer número de parcelas: o convidado paga as taxas e o serviço Entrelaços. A única tarifa descontada do saldo é a de saque.`,
      },
      {
        question: "Por que o total muda com o número de parcelas?",
        answer: `Vocês recebem o presente de uma vez, mesmo quando o convidado parcela em até ${maxInstallments}x. O acréscimo cobre o custo de adiantar essas parcelas, por isso cresce a cada parcela a mais. O total é dividido em parcelas iguais, com eventual ajuste de centavos na última.`,
      },
      {
        question: "Podemos simular quanto o convidado vai pagar?",
        answer:
          "Sim. No cadastro ou na edição do presente e na tela de taxas, abram “Simular taxas e parcelamento”. A simulação mostra o total do convidado no Pix e em cada parcelamento. Escolher parcelas nessa janela não altera o presente: quem decide como pagar é o convidado.",
      },
      {
        question: "O preço de um presente pode mudar?",
        answer:
          "Pode, se as tarifas da Pagar.me mudarem. O preço de cada compra é calculado quando o convidado abre o pagamento e fica valendo para aquela compra; mudanças posteriores não alteram pagamentos já iniciados.",
      },
    ],
  },
  {
    id: "recebimentos",
    title: "Conta e recebimentos",
    questions: [
      {
        question: "Quem processa os pagamentos?",
        answer:
          "A Pagar.me, empresa do grupo Stone. Ela recebe o pagamento do convidado, separa a parte do casal e a do Entrelaços e guarda o saldo de vocês até o saque. Não é preciso abrir conta por fora: o cadastro é feito na área de Recebimentos do painel.",
      },
      {
        question: "Quem deve ser o titular dos recebimentos?",
        answer:
          "Uma pessoa do casal, com CPF. Ela informa seus dados pessoais e a conta bancária que vai receber os saques, que precisa estar no mesmo CPF.",
      },
      {
        question: "Como o titular confirma que é dono da conta?",
        answer:
          "No cadastro, o titular declara que o CPF e a conta bancária são dele, que tem 18 anos ou mais e que os dados são verdadeiros. O Entrelaços confere o CPF, a idade e se a conta está no mesmo CPF antes de enviar à Pagar.me. Não é preciso enviar fotos nem documentos. Os presentes podem ser recebidos assim que a Pagar.me ativar a conta.",
      },
      {
        question: "Pagamento confirmado significa saldo disponível?",
        answer:
          "São etapas diferentes. Um pagamento pode estar confirmado e ainda aguardar liberação. O painel distingue os valores recebidos, os que aguardam liberação e o saldo disponível para saque.",
      },
      {
        question: "Em quanto tempo um presente pago fica disponível?",
        answer:
          "No Pix, o valor fica disponível para saque assim que o pagamento é confirmado. No cartão, fica disponível em até 2 dias úteis, inteiro, seja qual for o número de parcelas escolhido pelo convidado.",
      },
    ],
  },
  {
    id: "saques",
    title: "Saques e suporte",
    questions: [
      {
        question: "Quanto custa sacar?",
        answer: `Cada saque custa ${withdrawalFee}, descontado do saldo. A tarifa aparece antes da confirmação. Como ela é cobrada por saque, juntar presentes em menos saques reduz o custo.`,
      },
      {
        question: "Como solicitamos e acompanhamos um saque?",
        answer: `Com saldo disponível, o titular escolhe um valor maior que ${withdrawalFee}, confere a tarifa e confirma com a senha do Entrelaços. O dinheiro vai para a conta bancária cadastrada nos Recebimentos. O andamento aparece no histórico: saque solicitado ainda não significa transferência concluída.`,
      },
      {
        question: "Como pedir ajuda com um pagamento, saque ou estorno?",
        answer:
          "Consultem primeiro a situação na área de Recebimentos. Para dúvidas sobre uma movimentação, falem com a equipe do Entrelaços; estornos são feitos pela nossa equipe. Não enviem senhas nem códigos de segurança pelo WhatsApp.",
      },
    ],
  },
];
