"use client";

import { motion, useReducedMotion } from "motion/react";
import type { HTMLAttributes } from "react";

export type FeatureAvailabilityStatus = "scaffold" | "planned";

export type FeatureAvailabilityItem = {
  name: string;
  status: FeatureAvailabilityStatus;
  note: string;
};

export type FeatureAvailabilityProps = Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> & {
  items?: readonly FeatureAvailabilityItem[];
};

export const featureAvailabilityItems: readonly FeatureAvailabilityItem[] = [
  {
    name: "Estrutura pública do site Astro",
    status: "scaffold",
    note: "Layout compartilhado e composição de seções estão disponíveis.",
  },
  {
    name: "Base de animação e movimento reduzido",
    status: "scaffold",
    note: "Uma pequena ilha funcional está pronta para a coreografia posterior.",
  },
  {
    name: "Comportamento de confirmação de presença",
    status: "scaffold",
    note: "Consulta e atualização explícita por família estão disponíveis.",
  },
  {
    name: "Autenticação de administradores e convidados",
    status: "scaffold",
    note: "Sessões reais e o PIN manual do convite protegem os fluxos operacionais.",
  },
  {
    name: "Mensagens e mural público",
    status: "scaffold",
    note: "Cada visitante pode assinar um recado, exibido no mural em tempo de execução.",
  },
  {
    name: "Fluxo de mídia aprovada",
    status: "planned",
    note: "Nenhuma mídia gerada ou do cliente está incluída neste modelo.",
  },
];

function FeatureAvailability({
  items = featureAvailabilityItems,
  className,
  ...sectionProps
}: FeatureAvailabilityProps) {
  const reducedMotion = useReducedMotion();

  return (
    <section
      aria-labelledby="feature-availability-title"
      className={["min-w-0", className].filter(Boolean).join(" ")}
      {...sectionProps}
    >
      <div className="flex items-baseline justify-between gap-4 border-b border-template-line pb-4 [@media(max-width:560px)]:items-start [@media(max-width:560px)]:flex-col">
        <p className="m-0 text-template-muted text-[0.72rem] font-bold tracking-[0.16em] uppercase">
          Área compartilhada
        </p>
        <h3
          className="m-0 font-template-serif text-[clamp(1.8rem,3vw,2.75rem)] font-normal tracking-[-0.05em]"
          id="feature-availability-title"
        >
          Status do modelo
        </h3>
      </div>
      <ul className="m-0 list-none p-0">
        {items.map((item, index) => (
          <motion.li
            key={item.name}
            className="flex items-start justify-between gap-6 border-b border-template-line py-5 [@media(max-width:560px)]:flex-col"
            initial={reducedMotion ? false : { opacity: 1, y: 8 }}
            whileInView={reducedMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.25 }}
            transition={{ duration: 0.25, delay: index * 0.04 }}
          >
            <div>
              <strong className="block text-base">{item.name}</strong>
              <p className="mt-[0.35rem] mb-0 max-w-[30rem] text-template-muted text-[0.92rem] leading-[1.5]">
                {item.note}
              </p>
            </div>
            <span
              className="shrink-0 rounded-[99px] border border-template-line px-[0.65rem] py-[0.35rem] text-template-muted text-[0.68rem] font-bold tracking-[0.08em] uppercase data-[status=scaffold]:border-[#718c72] data-[status=scaffold]:text-[#47654a]"
              data-status={item.status}
            >
              {item.status === "scaffold" ? "Estruturado" : "Planejado"}
            </span>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

export { FeatureAvailability };
