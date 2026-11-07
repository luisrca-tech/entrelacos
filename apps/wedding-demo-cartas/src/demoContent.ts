export const inactive = import.meta.env.PUBLIC_SITE_INACTIVE === "true";
export const access = {
  siteId: import.meta.env.PUBLIC_SITE_ID,
  apiOrigin: import.meta.env.PUBLIC_API_URL,
  panelOrigin: import.meta.env.PUBLIC_ADMIN_ORIGIN,
};
export const site = { name: "Marina & Caio", href: "/" };
const siteUrl =
  import.meta.env.PUBLIC_SITE_URL ??
  "https://demo-cartas.entrelacos.workers.dev";
export const seo = {
  title: "Cartas do Nosso Sim — Marina & Caio | EntreLaços",
  description:
    "Demonstração do modelo Cartas do Nosso Sim, com carta do casal, programação, confirmação de presença e mural.",
  canonical: new URL("/", siteUrl).href,
  robots: "noindex, nofollow" as const,
  socialImage: {
    url: new URL("/marina-caio-gallery-three.webp", siteUrl).href,
    alt: "Marina e Caio trocam olhares em um retrato próximo",
  },
};
export const footer = {
  names: "Marina & Caio",
  dateLabel: "18 de setembro de 2027",
  links: [
    { label: "História", href: "#story" },
    { label: "Programação", href: "#schedule" },
    { label: "Locais", href: "#ceremony-venue" },
  ],
  rsvp: { label: "Confirmar presença", href: "#guest-access" },
  year: "2027",
  copyright: "© Marina & Caio",
  attribution: "Feito com Entrelaços",
};
export const schedule = {
  id: "schedule",
  title: "A partir das 16h.",
  guidanceLabel: "Orientações práticas",
  entries: [
    {
      id: "ceremony",
      time: "16:00",
      title: "Cerimônia",
      body: "A cerimônia começa às 16h.",
      location: "Santuário Basílica Sagrada Família",
    },
    {
      id: "cocktail",
      time: "18:00",
      title: "Recepção",
      body: "Depois da cerimônia, nos encontramos para o coquetel e a festa.",
      location: "Casablanca Eventos",
    },
    {
      id: "dinner",
      time: "19:30",
      title: "Jantar",
      body: "Jantar, brindes e pista de dança.",
    },
  ],
  guidance: [
    {
      id: "arrival",
      title: "Chegada",
      body: "Reserve alguns minutos para estacionar na igreja. Na recepção, informe seu nome à equipe.",
    },
    {
      id: "attire",
      title: "Traje",
      body: "Traje social.",
    },
  ],
};
const ceremonyName = "Santuário Basílica Sagrada Família";
const ceremonyAddress =
  "Rua C-14, 155, Vila Nova Canaã, Goiânia, GO, 74415-220";
const ceremonyDestination = encodeURIComponent(
  `${ceremonyName}, ${ceremonyAddress}`,
);

export const ceremonyVenue = {
  id: "ceremony-venue",
  title: "Cerimônia · 16h",
  name: ceremonyName,
  address: ceremonyAddress,
  mapEmbedUrl: `https://maps.google.com/maps?q=${ceremonyDestination}&output=embed`,
  directions: {
    label: "Como chegar",
    href: `https://www.google.com/maps/dir/?api=1&destination=${ceremonyDestination}`,
  },
  fallback: {
    label: "Abrir endereço",
    href: `https://www.google.com/maps/search/?api=1&query=${ceremonyDestination}`,
  },
  labels: {
    mapTitle: "Mapa do Santuário Basílica Sagrada Família",
    addressLabel: "Endereço completo",
    copyLabel: "Copiar endereço",
    copiedLabel: "Endereço copiado",
    copyErrorLabel: "Não foi possível copiar o endereço",
  },
};

export const receptionVenue = {
  id: "venue",
  title: "Recepção · 18h",
  name: "Casablanca Eventos",
  address: "Av Ipanema 747, Jardim Atlântico, Goiânia, GO, 74343-010",
  mapEmbedUrl:
    "https://maps.google.com/maps?q=Casablanca%20Eventos%2C%20Av%20Ipanema%20747%2C%20Jardim%20Atl%C3%A2ntico%2C%20Goi%C3%A2nia%2C%20GO%2074343-010&output=embed",
  directions: {
    label: "Como chegar",
    href: "https://www.google.com/maps/dir/?api=1&destination=Casablanca%20Eventos%2C%20Av%20Ipanema%20747%2C%20Jardim%20Atl%C3%A2ntico%2C%20Goi%C3%A2nia%2C%20GO%2074343-010",
  },
  fallback: {
    label: "Abrir endereço",
    href: "https://casablancaeventosgoiania.com.br/contato",
  },
  labels: {
    mapTitle: "Mapa do Casablanca Eventos",
    addressLabel: "Endereço completo",
    copyLabel: "Copiar endereço",
    copiedLabel: "Endereço copiado",
    copyErrorLabel: "Não foi possível copiar o endereço",
  },
};
export const guestAccess = {
  siteId: import.meta.env.PUBLIC_SITE_ID ?? "",
  apiOrigin: import.meta.env.PUBLIC_API_URL ?? "",
};
