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
    name: "Mensagens por convite e mural público",
    status: "scaffold",
    note: "Cada convite pode publicar um recado, exibido no mural em tempo de execução.",
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
      className={["entrelacos-feature-availability", className]
        .filter(Boolean)
        .join(" ")}
      {...sectionProps}
    >
      <div className="entrelacos-feature-availability__heading">
        <p className="entrelacos-feature-availability__eyebrow">
          Área compartilhada
        </p>
        <h3 id="feature-availability-title">Status do modelo</h3>
      </div>
      <ul className="entrelacos-feature-availability__list">
        {items.map((item, index) => (
          <motion.li
            key={item.name}
            initial={reducedMotion ? false : { opacity: 1, y: 8 }}
            whileInView={reducedMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.25 }}
            transition={{ duration: 0.25, delay: index * 0.04 }}
          >
            <div>
              <strong>{item.name}</strong>
              <p>{item.note}</p>
            </div>
            <span data-status={item.status}>
              {item.status === "scaffold" ? "Estruturado" : "Planejado"}
            </span>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

export { FeatureAvailability };
