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
        question: "Como contratamos e combinamos o prazo?",
        answer:
          "Conversem com a nossa equipe pelo WhatsApp sobre a data do casamento, o estilo do site e o que precisam. Valores, conteúdo, prazo de preparação, período de publicação e eventuais serviços adicionais são alinhados antes da contratação.",
      },
      {
        question: "Os convidados precisam criar uma conta?",
        answer:
          "Não. As informações do casamento ficam no site. Para confirmar presença, a família usa o telefone de contato cadastrado e o PIN recebido com o convite. Ao pagar um presente, o convidado informa os dados solicitados no fluxo de pagamento.",
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
        answer:
          "Pix e cartão de crédito, à vista ou parcelado, conforme as opções liberadas para a conta recebedora e o valor do presente. O convidado confere as condições e o total antes de confirmar o pagamento.",
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
        answer:
          "Vocês cadastram quanto desejam receber. O sistema calcula automaticamente as taxas e apresenta ao convidado o preço final com elas incluídas. As condições podem combinar um percentual e um valor fixo por compra. O valor fixo é somado à parte percentual uma vez na compra, não repetido em cada parcela.",
      },
      {
        question: "Quanto o casal recebe?",
        answer:
          "Em um novo presente cadastrado por R$ 100,00, o casal recebe R$ 100,00 inteiros: as taxas, o serviço Entrelaços e a antecipação do parcelamento são pagos pelo convidado e já aparecem no total. Com antecipação, o casal recebe tudo de uma vez. Estornos, contestações e eventuais tarifas de saque são movimentações separadas.",
      },
      {
        question: "Como funciona o parcelamento no cartão?",
        answer:
          "O convidado pode escolher entre as opções disponíveis, em até 12 parcelas, respeitando o valor mínimo por parcela. O sistema calcula o acréscimo e divide o total entre as parcelas. Antes de pagar, ele vê o total e os valores das parcelas, incluindo eventual ajuste de centavos na última. O acréscimo já faz parte do total apresentado.",
      },
      {
        question: "Podemos simular quanto o convidado vai pagar?",
        answer:
          "Sim. No cadastro ou na edição do presente e na tela de taxas, abram “Simular taxas e parcelamento”. A simulação mostra quanto vocês recebem (100% do presente), o total que o convidado paga no Pix e no cartão à vista, em 6x e em 12x, e as taxas pagas pelo convidado. Escolher uma quantidade de parcelas nessa janela não altera o presente nem define como ele será pago: o convidado escolhe no checkout, onde confere as condições finais.",
      },
      {
        question: "As taxas e promoções são sempre as mesmas?",
        answer:
          "As condições variam conforme a conta recebedora, a forma de pagamento, o número de parcelas e eventuais promoções vigentes. Por isso, o sistema consulta as tarifas aplicáveis para calcular os valores. Usem a prévia do painel para comparar as opções; o convidado confere o preço final antes de pagar.",
      },
    ],
  },
  {
    id: "recebimentos",
    title: "Conta e recebimentos",
    questions: [
      {
        question: "O que é o Asaas e por que precisamos dessa conta?",
        answer:
          "O Asaas é a plataforma de pagamentos integrada ao Entrelaços. Ele mantém a conta do recebedor, processa os pagamentos e realiza as transferências. O Entrelaços organiza a lista de presentes e os pedidos de saque. A conta é aberta no fluxo de Recebimentos do painel, com os dados e o consentimento do titular.",
      },
      {
        question:
          "Quem deve ser o titular e quais verificações são necessárias?",
        answer:
          "O casal define a pessoa responsável pelos recebimentos no painel. O titular confirma seus dados e segue as etapas de ativação e análise do Asaas, que podem incluir confirmação de celular, documentos e selfie. O guia de Recebimentos acompanha esse processo. A liberação depende da aprovação da conta e da configuração dos pagamentos.",
      },
      {
        question: "Precisamos criar uma conta Asaas por fora?",
        answer:
          "Usem a conta criada pelo fluxo de Recebimentos do Entrelaços. Não abram outra conta para tentar vinculá-la ao casamento. As instruções de ativação e acesso aparecem no guia do painel; a senha e os códigos de segurança são tratados diretamente no Asaas.",
      },
      {
        question: "Pagamento confirmado significa saldo disponível?",
        answer:
          "São etapas diferentes. Um pagamento pode estar confirmado e ainda aguardar liberação. No cartão parcelado, o saldo fica disponível conforme a liberação de cada parcela pelo Asaas. O painel distingue os valores recebidos, os que aguardam liberação e o saldo disponível para saque.",
      },
      {
        question: "Em quanto tempo um presente pago fica disponível?",
        answer:
          "No Pix, o Asaas informa que o valor costuma ficar disponível em alguns instantes após o pagamento. No cartão, à vista ou parcelado, o valor inteiro do presente chega de uma vez, com antecipação, normalmente em até 2 dias úteis após a confirmação. Em situações pontuais, como análise do pagamento, o presente fica como aguardando liberação. Acompanhem a situação no painel.",
      },
      {
        question: "Se o convidado parcelar, recebemos tudo de uma vez?",
        answer:
          "Sim. Com antecipação, o casal recebe o valor inteiro do presente de uma vez, mesmo que o convidado parcele no cartão. O custo da antecipação está incluído no total pago pelo convidado.",
      },
      {
        question: "Como funciona a antecipação dos recebimentos?",
        answer:
          "A antecipação libera os valores de cartão antes do prazo padrão para que o casal receba tudo de uma vez. Ela tem custo próprio, pago pelo convidado e já incluído no total. O saldo só pode ser tratado como disponível após a confirmação do crédito pelo Asaas.",
        reference: {
          label: "Entender as condições de antecipação",
          href: "https://www.asaas.com/antecipacao-de-recebiveis",
        },
      },
    ],
  },
  {
    id: "saques",
    title: "Saques e suporte",
    questions: [
      {
        question: "Saques via Pix são gratuitos?",
        answer:
          "Sim, para contas recebedoras cadastradas como pessoa física (PF) ou MEI, as transferências Pix são gratuitas e ilimitadas. O Entrelaços não cobra uma taxa adicional pelo saque. Para os demais tipos de empresa, há uma franquia mensal de transferências gratuitas e pode haver cobrança após esse limite. Confiram as condições da conta e a prévia antes de confirmar.",
        reference: {
          label: "Consultar as regras de gratuidade do Asaas",
          href: "https://central.ajuda.asaas.com/hc/pt-br/articles/32059618254875",
        },
      },
      {
        question: "Como indicamos a conta bancária que vai receber o saque?",
        answer:
          "Na área de Recebimentos, o titular cadastra e confirma a chave Pix da sua própria conta bancária. Essa é a chave de destino do saque. O Entrelaços prepara separadamente o recebimento dos presentes no Asaas, sem transferir ou alterar as chaves Pix do banco de vocês.",
      },
      {
        question: "Como solicitamos e acompanhamos um saque?",
        answer:
          "Com saldo disponível, o titular escolhe o valor, confere o destinatário e a prévia e confirma o pedido com sua senha do Entrelaços. O andamento aparece no histórico. Se houver uma confirmação adicional exigida pelo Asaas, sigam as instruções apresentadas. Solicitar o saque não significa que a transferência já foi concluída.",
      },
      {
        question: "Quanto tempo demora um saque via Pix?",
        answer:
          "Depois que a transferência é efetivada pelo Asaas, o dinheiro costuma chegar à conta de destino em alguns instantes. O pedido pode aguardar autorização ou análise de segurança antes do envio. Acompanhem o status no histórico: saque solicitado ainda não significa transferência concluída. É necessário ter saldo disponível e a conta liberada para movimentação.",
        reference: {
          label: "Consultar os prazos de transferência",
          href: "https://central.ajuda.asaas.com/hc/pt-br/articles/52772307878811-Quanto-tempo-demora-para-cair-a-transfer%C3%AAncia-de-saque-da-minha-conta",
        },
      },
      {
        question: "Como pedir ajuda com um pagamento, saque ou estorno?",
        answer:
          "Consultem primeiro a situação na área de Recebimentos e no guia do painel. Para dúvidas sobre o site ou ajuda para entender uma movimentação, falem com a equipe do Entrelaços. Verificações da conta, autorizações e estornos podem exigir atendimento ou confirmação no Asaas. Não enviem senhas nem códigos de segurança pelo WhatsApp.",
      },
    ],
  },
];
