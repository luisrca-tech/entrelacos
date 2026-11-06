import { describe, expect, it } from "vitest";
import {
  createInvitationCsv,
  createInvitationPdf,
  filterInvitationReportRows,
  type InvitationReport,
} from "./reports";

const report: InvitationReport = {
  siteId: "site-demo",
  reportTitle: "Ana & João",
  generatedAt: "2029-01-10T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
  filters: { search: "família", status: "CONFIRMED", guestType: "ADULT" },
  totals: {
    invitations: 2,
    guests: 3,
    adults: 2,
    children: 1,
    pending: 1,
    confirmed: 1,
    declined: 1,
  },
  selectedTotals: {
    invitations: 1,
    guests: 1,
    adults: 1,
    children: 0,
    pending: 0,
    confirmed: 1,
    declined: 0,
  },
  rows: [
    {
      invitationId: "invitation-one",
      invitationName: "=Família Silva",
      guestName: "João, 'Silva'",
      guestType: "ADULT",
      rsvpState: "CONFIRMED",
      phone: "+5511999999999",
      email: "joao@example.test",
    },
  ],
};

describe("invitation report", () => {
  it("exports counts per invitation ID and does not merge invitations with the same name", () => {
    const guest = report.rows[0];
    if (!guest) throw new Error("Missing report fixture row");
    const csv = new TextDecoder().decode(
      createInvitationCsv(
        {
          ...report,
          rows: [
            guest,
            { ...guest, rsvpState: "PENDING" },
            { ...guest, invitationId: "invitation-two", rsvpState: "DECLINED" },
          ],
        },
        { model: "groups", includePhone: true, includeEmail: false },
      ),
    );
    expect(csv.split("\r\n").filter(Boolean)).toEqual([
      '"Convite","Convidados","Confirmados","Sem resposta","Não irão","Situação do convite","Telefone"',
      `"'=Família Silva","2","1","1","0","Em parte","'+5511999999999"`,
      `"'=Família Silva","1","0","0","1","Não irão","'+5511999999999"`,
    ]);
    expect(csv).not.toContain(guest.guestName);
  });

  it("matches accent-insensitive names and applies status/type to the same guest", () => {
    const rows = [
      {
        invitationName: "Família Silva",
        guestName: "João",
        guestType: "ADULT" as const,
        rsvpState: "CONFIRMED" as const,
      },
      {
        invitationName: "Família Silva",
        guestName: "Lívia",
        guestType: "CHILD" as const,
        rsvpState: "PENDING" as const,
      },
      {
        invitationName: "Outro convite",
        guestName: "Outra",
        guestType: "ADULT" as const,
        rsvpState: "CONFIRMED" as const,
      },
    ];
    expect(
      filterInvitationReportRows(rows, {
        search: "familia",
        status: "CONFIRMED",
        guestType: "ADULT",
      }),
    ).toEqual([rows[0]]);
    expect(
      filterInvitationReportRows(rows, {
        status: "PENDING",
        guestType: "ADULT",
      }),
    ).toEqual([]);
  });

  it("exports exactly one data row per selected guest and protects spreadsheet cells", () => {
    const bytes = createInvitationCsv(report, {
      includePhone: false,
      includeEmail: false,
    });
    const csv = new TextDecoder().decode(bytes);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(csv).toContain('"\'=Família Silva"');
    expect(csv).toContain("\"João, 'Silva'\"");
    expect(csv).toContain('"Adulto"');
    expect(csv).toContain('"Irá comparecer"');
    expect(csv).not.toContain("+5511999999999");
    expect(csv).not.toContain("joao@example.test");
    expect(csv).not.toMatch(/(?:invitationId|guestId|PIN|token)/iu);
  });

  it("includes contact columns only when individually requested", () => {
    const phone = new TextDecoder().decode(
      createInvitationCsv(report, { includePhone: true, includeEmail: false }),
    );
    expect(phone).toContain("+5511999999999");
    expect(phone).not.toContain("joao@example.test");
    const email = new TextDecoder().decode(
      createInvitationCsv(report, { includePhone: false, includeEmail: true }),
    );
    expect(email).toContain("joao@example.test");
    expect(email).not.toContain("+5511999999999");
  });

  it.each(["planning", "reception"] as const)(
    "produces a paginated %s PDF with Unicode fonts",
    async (model) => {
      const firstRow = report.rows[0];
      if (!firstRow) throw new Error("Missing report fixture row");
      const bytes = await createInvitationPdf(
        {
          ...report,
          selectedTotals: {
            ...report.selectedTotals,
            guests: 100,
            adults: 100,
            confirmed: 100,
          },
          rows: Array.from({ length: 100 }, (_, index) => ({
            ...firstRow,
            guestName: `Convidado ${index} — São José`,
          })),
        },
        { model, includePhone: false, includeEmail: false },
      );
      const pdf = new TextDecoder("latin1").decode(bytes);
      expect(pdf.startsWith("%PDF-")).toBe(true);
      expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
      expect(pdf).toContain("DejaVuSans");
      expect(pdf).toContain("DejaVuSerif");
    },
  );
});
