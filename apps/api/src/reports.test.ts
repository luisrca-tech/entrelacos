import { describe, expect, it } from "vitest";
import {
  createRsvpCsv,
  createRsvpPdf,
  formatRsvpState,
  type RsvpReport,
} from "./reports";

const report: RsvpReport = {
  siteId: "site-demo",
  reportTitle: "Ana & João",
  generatedAt: "2029-01-10T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
  groupFilter: null,
  stateFilter: null,
  totals: { pending: 1, confirmed: 1, declined: 1 },
  selectedTotals: { pending: 1, confirmed: 1, declined: 1 },
  rows: [
    {
      groupName: "=SILVA",
      memberName: "João, 'Lívia'",
      rsvpState: "CONFIRMED",
      representativePhone: "+5511999999999",
    },
    {
      groupName: "Grupo externo",
      memberName: "Pessoa\nLonga",
      rsvpState: "PENDING",
      representativePhone: "",
    },
    {
      groupName: "Família Souza",
      memberName: "Marina Souza",
      rsvpState: "DECLINED",
      representativePhone: "",
    },
  ],
};

describe("RSVP report formats", () => {
  it("presents every RSVP state in Brazilian Portuguese", () => {
    expect(formatRsvpState("PENDING")).toBe("Pendente");
    expect(formatRsvpState("CONFIRMED")).toBe("Confirmado");
    expect(formatRsvpState("DECLINED")).toBe("Não comparecerá");
  });

  it("creates rectangular RFC 4180 CSV with BOM, CRLF, and formula protection", () => {
    const bytes = createRsvpCsv(report, true);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv).toContain("\r\n");
    expect(csv).not.toContain("\n\n");
    const records = csv.split("\r\n").filter(Boolean);
    expect(records).toHaveLength(5);
    expect(
      records.every((row) => {
        let quoted = false;
        let count = 1;
        for (const character of row) {
          if (character === '"') quoted = !quoted;
          if (character === "," && !quoted) count += 1;
        }
        return count === 16;
      }),
    ).toBe(true);
    expect(csv).toContain('"\'=SILVA"');
    expect(csv).toContain('"\'+5511999999999"');
    expect(csv).toContain('"Pessoa\nLonga"');
    expect(csv).toContain("\"João, 'Lívia'\"");
    expect(csv).toContain('"Pendente"');
    expect(csv).toContain('"Confirmado"');
    expect(csv).toContain('"Não comparecerá"');
    expect(csv).not.toMatch(/"(?:PENDING|CONFIRMED|DECLINED)"/u);
  });

  it("omits representativePhone column when phone is excluded", () => {
    const csv = new TextDecoder().decode(createRsvpCsv(report, false));
    expect(csv.split("\r\n")[0].split(",")).toHaveLength(15);
    expect(csv).not.toContain("representativePhone");
    expect(csv).not.toContain("+5511999999999");
  });

  it("presents an RSVP state filter in Brazilian Portuguese", () => {
    const csv = new TextDecoder().decode(
      createRsvpCsv({ ...report, stateFilter: "DECLINED" }),
    );
    expect(csv).toContain('"Não comparecerá"');
    expect(csv).not.toContain('"DECLINED"');
  });

  it("embeds DejaVu Unicode fonts and paginates long reports", async () => {
    const bytes = await createRsvpPdf(
      {
        ...report,
        rows: Array.from({ length: 90 }, (_, index) => ({
          groupName: `Família ${index} — São José`,
          memberName: `Convidado ${index} com um nome suficientemente comprido para quebrar linha`,
          rsvpState:
            index % 2 === 0 ? ("CONFIRMED" as const) : ("PENDING" as const),
          representativePhone: "+5511999999999",
        })),
      },
      true,
    );
    const pdf = new TextDecoder("latin1").decode(bytes);
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
    expect(pdf).toContain("DejaVuSans");
  });
});
