import { describe, expect, it } from "vitest";
import {
  validateFooterContent,
  validateGalleryContent,
  validateHeroContent,
  validateMapEmbedUrl,
  validateMedia,
  validateNavigation,
  validatePageSeo,
  validateScheduleContent,
  validateSectionIds,
  validateSerializableContent,
  validateStoryContent,
  validateVenueContent,
  validateWeddingHomeProps,
  validateWeddingLayoutProps,
} from "./content";

const heroOnlyHome = {
  locale: "pt-BR",
  site: { name: "Casa", href: "/" },
  seo: {
    title: "Casa",
    description: "Uma casa.",
    canonical: "https://fixture.example.test/",
    robots: "noindex, nofollow" as const,
    socialImage: {
      url: "https://fixture.example.test/social-card.png",
      alt: "Imagem da casa",
    },
  },
  navigation: {
    ariaLabel: "Navegação",
    menuLabel: "Abrir menu",
    links: [{ label: "Início", href: "/" }],
  },
  hero: {
    id: "hero",
    title: "Um encontro",
    dateLabel: "Uma data",
    locationLabel: "Um local",
    media: {
      kind: "image" as const,
      src: "/hero.png",
      alt: "Imagem",
      width: 1200,
      height: 800,
    },
  },
};

describe("template-root v1 content contracts", () => {
  it("accepts complete host-owned page SEO", () => {
    expect(
      validatePageSeo({
        title: "A celebração",
        description: "Informações sobre o evento.",
        canonical: "https://fixture.example.test/",
        robots: "noindex, nofollow",
        socialImage: {
          url: "https://fixture.example.test/social-card.png",
          alt: "Imagem social do evento",
        },
      }),
    ).toMatchObject({ title: "A celebração" });
  });

  it("rejects a canonical URL with an unsafe scheme", () => {
    expect(() =>
      validatePageSeo({
        title: "A celebração",
        description: "Informações sobre o evento.",
        canonical: "javascript:alert(1)",
        robots: "noindex, nofollow",
        socialImage: {
          url: "https://fixture.example.test/social-card.png",
          alt: "Imagem social do evento",
        },
      }),
    ).toThrow(/canonical/i);
  });

  it("rejects unsafe navigation links and duplicate section IDs", () => {
    expect(() =>
      validateNavigation({
        ariaLabel: "Navegação",
        menuLabel: "Abrir menu",
        links: [{ label: "Início", href: "javascript:alert(1)" }],
      }),
    ).toThrow(/href/i);
    expect(() => validateSectionIds(["hero", "hero"])).toThrow(/unique/i);
  });

  it("requires a host-owned mobile menu label", () => {
    expect(() =>
      validateNavigation({
        ariaLabel: "Navegação",
        links: [{ label: "Início", href: "/" }],
      } as never),
    ).toThrow(/menuLabel/i);
  });

  it("rejects backslash and browser-normalizable navigation URLs", () => {
    for (const href of [
      "/\\\\external.example",
      "https:\\\\external.example",
    ]) {
      expect(() =>
        validateNavigation({
          ariaLabel: "Navegação",
          menuLabel: "Abrir menu",
          links: [{ label: "Externo", href }],
        }),
      ).toThrow(/href/i);
    }
  });

  it("derives the default order from present sections and requires hero once", () => {
    expect(validateWeddingHomeProps(heroOnlyHome)).toEqual(["hero"]);
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        story: {
          id: "story",
          title: "História",
          entries: [
            { id: "story-one", title: "Primeiro", body: "Texto primeiro." },
            { id: "story-two", title: "Segundo", body: "Texto segundo." },
          ],
        },
        sectionOrder: ["story"],
      }),
    ).toThrow(/hero exactly once/i);
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        sectionOrder: ["hero", "hero"],
      }),
    ).toThrow(/hero exactly once/i);
  });

  it("rejects null and false optional values instead of treating them as omitted", () => {
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        story: null as never,
      }),
    ).toThrow(/story/i);
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        footer: false as never,
      }),
    ).toThrow(/footer/i);
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        sectionOrder: null as never,
      }),
    ).toThrow(/sectionOrder/i);
    expect(() =>
      validateWeddingLayoutProps({
        ...heroOnlyHome,
        navigation: null as never,
      }),
    ).toThrow(/navigation/i);
  });

  it("rejects home navigation anchors that are not rendered", () => {
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        navigation: {
          ...heroOnlyHome.navigation,
          links: [{ label: "Ausente", href: "#missing" }],
        },
      }),
    ).toThrow(/anchor/i);
  });

  it("accepts anchors declared for a stable host extension slot", () => {
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        navigation: {
          ...heroOnlyHome.navigation,
          links: [{ label: "Local", href: "#local" }],
          extensionAnchorIds: ["local"],
        },
      }),
    ).not.toThrow();
  });

  it("rejects missing hero fields and non-finite media dimensions", () => {
    expect(() =>
      validateHeroContent({
        id: "hero",
        title: "Celebração",
        dateLabel: "Uma data",
        locationLabel: "Um local",
      }),
    ).toThrow(/hero\.media/i);
    expect(() =>
      validateMedia({
        kind: "image",
        src: "/hero.png",
        alt: "Imagem",
        width: Number.POSITIVE_INFINITY,
        height: 600,
      }),
    ).toThrow(/width/i);
  });

  it("requires a safe host-owned hero action and a video poster", () => {
    expect(() =>
      validateHeroContent({
        ...heroOnlyHome.hero,
        action: { label: "Confirmar presença", href: "#guest-access" },
      }),
    ).not.toThrow();
    expect(() =>
      validateHeroContent({
        ...heroOnlyHome.hero,
        action: { label: "Abrir", href: "javascript:alert(1)" },
      }),
    ).toThrow(/action\.href/i);
    expect(() =>
      validateHeroContent({
        ...heroOnlyHome.hero,
        action: null as never,
      }),
    ).toThrow(/action/i);
    expect(() =>
      validateHeroContent({
        ...heroOnlyHome.hero,
        media: {
          kind: "video",
          src: "/hero.mp4",
          poster: "",
          alt: "Vídeo",
          width: 1200,
          height: 800,
        },
      }),
    ).toThrow(/poster/i);
  });

  it("accepts a host-owned hero intro and rejects incomplete labels", () => {
    expect(() =>
      validateHeroContent({
        ...heroOnlyHome.hero,
        intro: {
          brandLabel: "Alex & Sam",
          topLabel: "Alex &",
          bottomLabel: "Sam",
        },
      }),
    ).not.toThrow();

    expect(() =>
      validateHeroContent({
        ...heroOnlyHome.hero,
        intro: {
          brandLabel: "Alex & Sam",
          topLabel: "",
          bottomLabel: "Sam",
        },
      }),
    ).toThrow(/hero\.intro\.topLabel/i);
  });

  it("requires gallery media when the home preset enables the hero intro", () => {
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        hero: {
          ...heroOnlyHome.hero,
          intro: {
            brandLabel: "Alex & Sam",
            topLabel: "Alex &",
            bottomLabel: "Sam",
          },
        },
      }),
    ).toThrow(/intro.*gallery/i);
  });

  it("rejects executable content values and canonical fragments", () => {
    expect(() =>
      validateSerializableContent({ render: () => "markup" }),
    ).toThrow(/plain serializable/i);
    expect(() =>
      validateSerializableContent(new URL("https://fixture.example.test")),
    ).toThrow(/plain serializable/i);
    expect(() =>
      validateNavigation({
        ariaLabel: "Navegação",
        menuLabel: "Abrir menu",
        links: [
          {
            label: "Externo",
            href: "https://user:password@fixture.example.test",
          },
        ],
      }),
    ).toThrow(/href/i);
    expect(() =>
      validatePageSeo({
        title: "A celebração",
        description: "Informações sobre o evento.",
        canonical: "https://fixture.example.test/#fragment",
        robots: "noindex, nofollow",
        socialImage: {
          url: "https://fixture.example.test/social-card.png",
          alt: "Imagem social do evento",
        },
      }),
    ).toThrow(/fragment/i);
  });

  it("rejects executable values in arrays even when array methods are tampered", () => {
    const values: unknown[] = ["safe", () => "markup"];
    Object.defineProperty(values, "forEach", { value: () => undefined });
    expect(() => validateSerializableContent(values)).toThrow(
      /plain serializable/i,
    );
  });

  it("requires a host-owned narrative sequence with unique entry anchors", () => {
    expect(() =>
      validateStoryContent({
        id: "story",
        title: "Uma história",
        entries: [
          { id: "story-one", title: "Primeiro", body: "Texto primeiro." },
          { id: "story-two", title: "Segundo", body: "Texto segundo." },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      validateStoryContent({
        id: "story",
        title: "Uma história",
        entries: [{ id: "story-one", title: "Primeiro", body: "Texto." }],
      }),
    ).toThrow(/at least two/i);

    expect(() =>
      validateStoryContent({
        id: "story",
        title: "Uma história",
        entries: [
          { id: "story-one", title: "Primeiro", body: "Texto primeiro." },
          { id: "story-one", title: "Segundo", body: "Texto segundo." },
        ],
      }),
    ).toThrow(/unique/i);
  });

  it("validates optional narrative media as host-owned serializable media", () => {
    expect(() =>
      validateStoryContent({
        id: "story",
        title: "Uma história",
        entries: [
          {
            id: "story-one",
            title: "Primeiro",
            body: "Texto primeiro.",
            media: {
              kind: "image",
              src: "/story-one.svg",
              alt: "Imagem abstrata",
              width: 1200,
              height: 900,
            },
          },
          { id: "story-two", title: "Segundo", body: "Texto segundo." },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      validateStoryContent({
        id: "story",
        title: "Uma história",
        entries: [
          { id: "story-one", title: "Primeiro", body: "Texto primeiro." },
          {
            id: "story-two",
            title: "Segundo",
            body: "Texto segundo.",
            media: null as never,
          },
        ],
      }),
    ).toThrow(/media/i);
  });

  it("validates a compact host-owned gallery and its required labels", () => {
    expect(() =>
      validateGalleryContent({
        id: "gallery",
        title: "Imagens",
        controls: {
          ariaLabel: "Controles da galeria",
          previousLabel: "Imagem anterior",
          nextLabel: "Próxima imagem",
          expandLabel: "Expandir galeria",
          closeLabel: "Fechar galeria",
        },
        items: [
          {
            id: "gallery-one",
            media: {
              kind: "image",
              src: "/gallery-one.svg",
              alt: "Composição abstrata um",
              width: 1200,
              height: 900,
            },
            caption: "Uma lembrança",
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateGalleryContent({
        id: "gallery",
        title: "Imagens",
        controls: {
          ariaLabel: "Controles da galeria",
          previousLabel: "",
          nextLabel: "Próxima imagem",
          expandLabel: "Expandir galeria",
          closeLabel: "Fechar galeria",
        },
        items: [],
      }),
    ).toThrow(/gallery/i);
  });

  it("accepts the manual Google Maps embed form and rejects unsafe origins", () => {
    expect(() =>
      validateMapEmbedUrl("https://www.google.com/maps/embed?pb=fixture"),
    ).not.toThrow();
    expect(() =>
      validateMapEmbedUrl("https://maps.google.com/maps?q=venue&output=embed"),
    ).not.toThrow();
    expect(() =>
      validateMapEmbedUrl("https://evil.example.test/maps/embed?pb=fixture"),
    ).toThrow(/map/i);
    expect(() =>
      validateMapEmbedUrl("https://www.google.com/maps?q=venue"),
    ).toThrow(/map/i);
  });

  it("requires ceremony/reception data and host-owned practical guidance", () => {
    expect(() =>
      validateScheduleContent({
        id: "schedule",
        title: "Programação",
        guidanceLabel: "Orientações práticas",
        entries: [
          {
            id: "ceremony",
            time: "17:00",
            title: "Cerimônia",
            body: "Chegada",
          },
          { id: "reception", time: "19:00", title: "Recepção", body: "Jantar" },
        ],
        guidance: [
          {
            id: "dress",
            title: "Traje",
            body: "Escolha o que for confortável.",
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateScheduleContent({
        id: "schedule",
        title: "Programação",
        guidanceLabel: "Orientações práticas",
        entries: [
          {
            id: "ceremony",
            time: "17:00",
            title: "Cerimônia",
            body: "Chegada",
          },
        ],
        guidance: [],
      }),
    ).toThrow(/at least two/i);
  });

  it("requires a visible address fallback and safe directions link", () => {
    const venue = {
      id: "venue",
      title: "Local",
      name: "Um espaço",
      address: "Uma rua, 1",
      mapEmbedUrl: "https://www.google.com/maps/embed?pb=fixture",
      directions: {
        label: "Como chegar",
        href: "https://www.google.com/maps/dir/?api=1&destination=venue",
      },
      fallback: {
        label: "Abrir endereço",
        href: "https://venue.example.test/contact",
      },
      labels: {
        mapTitle: "Mapa do local",
        addressLabel: "Endereço",
        copyLabel: "Copiar endereço",
        copiedLabel: "Endereço copiado",
        copyErrorLabel: "Não foi possível copiar",
      },
    };
    expect(() => validateVenueContent(venue)).not.toThrow();
    expect(() =>
      validateVenueContent({ ...venue, fallback: undefined }),
    ).toThrow(/fallback/i);
    expect(() =>
      validateVenueContent({
        ...venue,
        directions: { label: "Como chegar", href: "javascript:alert(1)" },
      }),
    ).toThrow(/directions/i);
  });

  it("requires every host-owned footer field", () => {
    expect(() =>
      validateFooterContent({
        names: "Um casal",
        dateLabel: "Uma data",
        links: [{ label: "Local", href: "#venue" }],
        rsvp: { label: "RSVP", href: "#guest-access" },
        year: "2028",
        copyright: "© Um casal",
        attribution: "By the publisher",
      }),
    ).not.toThrow();
    expect(() =>
      validateFooterContent({
        names: "Um casal",
        dateLabel: "Uma data",
        links: [],
        rsvp: { label: "RSVP", href: "#guest-access" },
        year: "2028",
        copyright: "© Um casal",
      }),
    ).toThrow(/attribution/i);
  });

  it("derives the complete default order from available practical sections", () => {
    const home = {
      ...heroOnlyHome,
      story: {
        id: "story",
        title: "História",
        entries: [
          { id: "story-one", title: "Primeiro", body: "Texto primeiro." },
          { id: "story-two", title: "Segundo", body: "Texto segundo." },
        ],
      },
      gallery: {
        id: "gallery",
        title: "Imagens",
        controls: {
          ariaLabel: "Galeria",
          previousLabel: "Anterior",
          nextLabel: "Próxima",
          expandLabel: "Expandir",
          closeLabel: "Fechar",
        },
        items: [{ id: "gallery-one", media: heroOnlyHome.hero.media }],
      },
      schedule: {
        id: "schedule",
        title: "Programação",
        guidanceLabel: "Orientações práticas",
        entries: [
          {
            id: "ceremony",
            time: "17:00",
            title: "Cerimônia",
            body: "Chegada",
          },
          { id: "reception", time: "19:00", title: "Recepção", body: "Jantar" },
        ],
      },
    };
    expect(validateWeddingHomeProps(home)).toEqual([
      "hero",
      "story",
      "gallery",
      "schedule",
    ]);
  });

  it("rejects IDs that collide across rendered sections and entries", () => {
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        gallery: {
          id: "gallery",
          title: "Imagens",
          controls: {
            ariaLabel: "Galeria",
            previousLabel: "Anterior",
            nextLabel: "Próxima",
            expandLabel: "Expandir",
            closeLabel: "Fechar",
          },
          items: [{ id: "shared", media: heroOnlyHome.hero.media }],
        },
        schedule: {
          id: "schedule",
          title: "Programação",
          guidanceLabel: "Orientações",
          entries: [
            {
              id: "shared",
              time: "17:00",
              title: "Cerimônia",
              body: "Chegada",
            },
            {
              id: "reception",
              time: "19:00",
              title: "Recepção",
              body: "Jantar",
            },
          ],
        },
      }),
    ).toThrow(/unique/i);
  });

  it("rejects collisions with generated and extension DOM IDs", () => {
    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        navigation: {
          ...heroOnlyHome.navigation,
          extensionAnchorIds: ["hero"],
        },
      }),
    ).toThrow(/unique/i);

    expect(() =>
      validateWeddingHomeProps({
        ...heroOnlyHome,
        story: {
          id: "story",
          title: "História",
          entries: [
            { id: "hero-title", title: "Primeiro", body: "Texto primeiro." },
            { id: "story-two", title: "Segundo", body: "Texto segundo." },
          ],
        },
      }),
    ).toThrow(/unique/i);
  });
});
