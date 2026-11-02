export function showcaseConfiguration(
  target: string,
  confirmation: string,
  productionAuthorized = false,
) {
  if (
    !["development", "production"].includes(target) ||
    confirmation !== `POPULATE ${target} EntreLacos showcases` ||
    (target === "production" && productionAuthorized !== true)
  )
    throw new Error(
      "Explicit environment-specific showcase authorization is required",
    );
  const suffix = target === "production" ? "" : "-dev";
  return {
    target: target as "development" | "production",
    botanicalSiteId: "demo-wedding",
    lettersSiteId: "demo-wedding-cartas",
    botanicalOrigin: `https://demo${suffix}.entrelacos.workers.dev`,
    lettersOrigin: `https://demo-cartas${suffix}.entrelacos.workers.dev`,
  };
}

export function assertShowcaseSource(
  source: Record<string, unknown> | undefined,
  config: ReturnType<typeof showcaseConfiguration>,
): void {
  if (
    !source ||
    source.id !== config.botanicalSiteId ||
    source.is_demo !== true ||
    source.repository_slug !== "demo-wedding" ||
    source.partner_one_name !== "Marina" ||
    source.partner_two_name !== "Caio" ||
    source.event_date !== "2027-09-18" ||
    source.lifecycle !== "ACTIVE" ||
    source.publication_state !== "PUBLISHED" ||
    source.public_url !== `${config.botanicalOrigin}/`
  ) {
    throw new Error(
      "Existing showcase identity does not match the selected environment",
    );
  }
}

// Reserved NANP example numbers never refer to invited customers or receive notifications.
export const showcaseFamilies = [
  {
    slug: "duarte",
    name: "Família Duarte",
    phone: "+12025550140",
    guests: [
      { name: "Helena Duarte", type: "ADULT", state: "CONFIRMED" },
      { name: "Ricardo Duarte", type: "ADULT", state: "CONFIRMED" },
      { name: "Sofia Duarte", type: "CHILD", state: "CONFIRMED" },
    ],
  },
  {
    slug: "lima",
    name: "Família Lima",
    phone: "+12025550141",
    guests: [
      { name: "Gabriel Lima", type: "ADULT", state: "CONFIRMED" },
      { name: "Júlia Lima", type: "ADULT", state: "PENDING" },
    ],
  },
  {
    slug: "azevedo",
    name: "Família Azevedo",
    phone: "+12025550142",
    guests: [
      { name: "Teresa Azevedo", type: "ADULT", state: "PENDING" },
      { name: "Eduardo Azevedo", type: "ADULT", state: "PENDING" },
    ],
  },
  {
    slug: "ramos",
    name: "Família Ramos",
    phone: "+12025550143",
    guests: [
      { name: "Bia Ramos", type: "ADULT", state: "DECLINED" },
      { name: "André Ramos", type: "ADULT", state: "DECLINED" },
    ],
  },
] as const;

export const showcaseMessages = [
  {
    slug: "helena",
    author: "Helena Duarte · exemplo",
    text: "Marina e Caio, que a casa de vocês tenha sempre café passado, conversa boa e espaço para sonhar. Estamos contando os dias para celebrar esse amor!",
  },
  {
    slug: "gabriel",
    author: "Gabriel Lima · exemplo",
    text: "Da primeira viagem juntos até este sim: é lindo ver a parceria de vocês crescer. Que venham muitos capítulos felizes. A pista de dança já tem companhia!",
  },
  {
    slug: "teresa",
    author: "Teresa Azevedo · exemplo",
    text: "Que vocês continuem escolhendo um ao outro nos dias de festa e nos dias comuns. Recebam nosso carinho e os melhores desejos para essa nova etapa.",
  },
  {
    slug: "bia",
    author: "Bia Ramos · exemplo",
    text: "Mesmo de longe, vamos brindar por vocês. Que nunca faltem cumplicidade, risadas e coragem para construir os sonhos de mãos dadas!",
  },
  {
    slug: "ricardo",
    author: "Ricardo Duarte · exemplo",
    text: "A alegria de vocês contagia todo mundo. Vai ser um privilégio estar pertinho nesse dia tão esperado. Um abraço enorme para os dois!",
  },
  {
    slug: "julia",
    author: "Júlia Lima · exemplo",
    text: "Já estamos preparando o abraço! Que esse encontro reúna todas as pessoas queridas e vire uma lembrança bonita para a vida inteira.",
  },
] as const;

// Illustrative contribution amounts, not retail quotes or promises of physical delivery.
export const showcaseGifts = [
  {
    slug: "cafe",
    title: "Café da manhã a dois",
    description:
      "Para os cafés demorados da nossa vida juntos. Um presente simbólico para celebrar os dias comuns.",
    cents: 15000,
    alt: "Xícara de café com grãos sobre tecido marrom",
    photo: "photo-1497515114629-f71d768fd07c",
    sourcePage:
      "https://unsplash.com/photos/white-ceramic-mug-and-saucer-with-coffee-beans-on-brown-textile-tNALoIZhqVM",
    credit: "Mike Kenneally / Unsplash",
  },
  {
    slug: "cozinha",
    title: "Nossa cozinha, nossas receitas",
    description:
      "Uma contribuição para equipar a cozinha e inventar novos pratos de domingo.",
    cents: 35000,
    alt: "Frigideira com ingredientes frescos para preparar uma massa",
    photo: "photo-1518291344630-4857135fb581",
    sourcePage:
      "https://unsplash.com/photos/flat-lay-photography-of-frying-pan-beside-tomatoes-on-blue-surface-seDjj4dmC9s",
    credit: "Icons8 Team / Unsplash",
  },
  {
    slug: "viagem",
    title: "Malas prontas para a lua de mel",
    description:
      "Para levar nossos planos na bagagem e voltar com histórias para contar.",
    cents: 55000,
    alt: "Mala de viagem pronta para uma nova aventura",
    photo: "photo-1714235058886-a0b38ad5066c",
    sourcePage:
      "https://unsplash.com/photos/a-hand-is-reaching-for-a-piece-of-luggage-y_cczw0Uc6E",
    credit: "Eminent Luggage / Unsplash",
  },
  {
    slug: "casa",
    title: "Uma mesa para receber quem amamos",
    description:
      "Um carinho para a casa nova, com espaço para os amigos e os almoços em família.",
    cents: 80000,
    alt: "Mesa de jantar com cadeiras em uma sala iluminada",
    photo: "photo-1770646403987-64cf5c08c870",
    sourcePage:
      "https://unsplash.com/photos/modern-dining-table-with-chairs-in-sunlit-room-4tYCKtVrjzs",
    credit: "Clay Banks / Unsplash",
  },
] as const;
