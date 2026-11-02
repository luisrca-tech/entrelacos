import type { CSSProperties } from "react";
import "./RingsLoader.css";

const sliceDepths = Array.from({ length: 12 }, (_, depth) => depth);

export function RingsLoader({
  label = "Carregando painel",
}: {
  label?: string;
}) {
  return (
    <div
      className="rings-loader"
      data-rings-loader=""
      role="status"
      aria-busy="true"
      aria-label={label}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="rings-loader-art" aria-hidden="true">
        <div className="rings-loader-stage">
          {["first", "second"].map((ring) => (
            <div
              className={`rings-loader-ring rings-loader-${ring}`}
              key={ring}
            >
              {sliceDepths.map((slice) => (
                <i
                  className="rings-loader-slice"
                  style={{ "--ring-slice": slice } as CSSProperties}
                  key={slice}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <span
        className="font-admin-display text-[1.8rem] tracking-[-0.035em] text-admin-graphite"
        aria-hidden="true"
      >
        Entrelaços
      </span>
      <p className="m-0 text-sm">{label}…</p>
    </div>
  );
}
