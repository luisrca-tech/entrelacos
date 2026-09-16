import type {
  HeroContent,
  Navigation,
  PageSeo,
  SiteIdentity,
  StoryContent,
} from "@entrelacos/template-root/v1";

export const site: SiteIdentity = {
  name: "Casa Aurora",
  href: "/",
};

export const navigation: Navigation = {
  ariaLabel: "Navegação da Casa Aurora",
  menuLabel: "Abrir menu",
  links: [
    { label: "Acolhimento", href: "#acolhimento" },
    { label: "Hospedagem", href: "/hospedagem" },
  ],
};

export const accommodationNavigation: Navigation = {
  ariaLabel: "Navegação de hospedagem da Casa Aurora",
  menuLabel: "Abrir menu",
  links: [
    { label: "Acolhimento", href: "/#acolhimento" },
    { label: "Hospedagem", href: "/hospedagem" },
  ],
};

export const homeSeo: PageSeo = {
  title: "Casa Aurora | Encontro",
  description: "Informações sobre o encontro na Casa Aurora.",
  canonical: "https://fixture.example.test/",
  robots: "noindex, nofollow",
  socialImage: {
    url: "https://fixture.example.test/casa-aurora.png",
    alt: "Prévia da Casa Aurora",
  },
};

export const accommodationSeo: PageSeo = {
  title: "Hospedagem | Casa Aurora",
  description: "Orientações de chegada e hospedagem.",
  canonical: "https://fixture.example.test/hospedagem",
  robots: "noindex, nofollow",
  socialImage: {
    url: "https://fixture.example.test/casa-aurora-hospedagem.png",
    alt: "Orientações de hospedagem da Casa Aurora",
  },
};

export const hero: HeroContent = {
  id: "acolhimento",
  eyebrow: "Encontro de outono",
  title: "Uma casa para reunir histórias.",
  description:
    "Esta composição técnica usa dados próprios e o mesmo layout público.",
  dateLabel: "12 de abril de 2028",
  locationLabel: "Pirenópolis, GO",
  media: {
    kind: "image",
    src: "/fixture-hero.svg",
    alt: "Textura abstrata em tons de terracota",
    width: 1600,
    height: 1000,
  },
};

export const welcome: StoryContent = {
  id: "boas-vindas",
  eyebrow: "Boas-vindas",
  title: "Um encontro pensado para estar presente.",
  description:
    "A fixture pode omitir, reordenar e complementar seções sem alterar o pacote compartilhado.",
  body: "O conteúdo desta seção pertence ao host e é serializado como dados simples.",
  media: hero.media,
};
