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
    name: "Public Astro site shell",
    status: "scaffold",
    note: "Shared layout and section composition are available.",
  },
  {
    name: "Motion and reduced-motion foundation",
    status: "scaffold",
    note: "A small functional island is ready for later choreography.",
  },
  {
    name: "RSVP behavior",
    status: "planned",
    note: "Domain flow and API contracts arrive in a later block.",
  },
  {
    name: "Admin and guest authentication",
    status: "planned",
    note: "No login, session, or success simulation is included here.",
  },
  {
    name: "Approved media pipeline",
    status: "planned",
    note: "No generated or client media is bundled in this scaffold.",
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
          Shared surface
        </p>
        <h3 id="feature-availability-title">Scaffold status</h3>
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
              {item.status === "scaffold" ? "Scaffolded" : "Planned"}
            </span>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

export { FeatureAvailability };
