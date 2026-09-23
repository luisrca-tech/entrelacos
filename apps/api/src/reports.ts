import { createRequire } from "node:module";
import {
  type InvitationExportQuery,
  type InvitationGuestType,
  invitationExportQuerySchema,
  type RsvpState,
} from "@entrelacos/contracts";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import PDFDocument from "pdfkit";

export type ReportsDatabase = NodePgDatabase<Record<string, never>>;
export type ReportsAdminActor = {
  userId: string;
  role: "OWNER" | "SITE_ADMIN";
};
export type InvitationReportTotals = {
  invitations: number;
  guests: number;
  adults: number;
  children: number;
  pending: number;
  confirmed: number;
  declined: number;
};
export type InvitationReportRow = {
  invitationName: string;
  guestName: string;
  guestType: InvitationGuestType;
  rsvpState: RsvpState;
  phone?: string;
  email?: string;
};
export type InvitationReport = {
  siteId: string;
  reportTitle: string;
  generatedAt: string;
  timezone: "America/Sao_Paulo";
  filters: Pick<InvitationExportQuery, "search" | "status" | "guestType">;
  totals: InvitationReportTotals;
  selectedTotals: InvitationReportTotals;
  rows: InvitationReportRow[];
};

export class ReportsServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
  ) {
    super(title);
    this.name = "ReportsServiceError";
  }
}

function reject(status: number, code: string, title: string): never {
  throw new ReportsServiceError(status, code, title);
}

function parseQuery(value: unknown): InvitationExportQuery {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    return invitationExportQuerySchema.parse({
      ...input,
      ...(typeof input.includePhone === "boolean"
        ? { includePhone: String(input.includePhone) }
        : {}),
      ...(typeof input.includeEmail === "boolean"
        ? { includeEmail: String(input.includeEmail) }
        : {}),
    });
  }
  return invitationExportQuerySchema.parse(value);
}

function searchKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function filterInvitationReportRows<
  T extends Pick<
    InvitationReportRow,
    "invitationName" | "rsvpState" | "guestType"
  >,
>(
  rows: readonly T[],
  filters: Partial<
    Pick<InvitationExportQuery, "search" | "status" | "guestType">
  >,
): T[] {
  const search = searchKey(filters.search ?? "");
  return rows.filter(
    (row) =>
      (!search || searchKey(row.invitationName).includes(search)) &&
      (!filters.status || row.rsvpState === filters.status) &&
      (!filters.guestType || row.guestType === filters.guestType),
  );
}

type DatabaseRow = InvitationReportRow & { invitationId: string };

function summarize(rows: readonly DatabaseRow[]): InvitationReportTotals {
  const invitationIds = new Set<string>();
  const totals: InvitationReportTotals = {
    invitations: 0,
    guests: 0,
    adults: 0,
    children: 0,
    pending: 0,
    confirmed: 0,
    declined: 0,
  };
  for (const row of rows) {
    invitationIds.add(row.invitationId);
    totals.guests += 1;
    if (row.guestType === "ADULT") totals.adults += 1;
    else totals.children += 1;
    if (row.rsvpState === "PENDING") totals.pending += 1;
    else if (row.rsvpState === "CONFIRMED") totals.confirmed += 1;
    else totals.declined += 1;
  }
  totals.invitations = invitationIds.size;
  return totals;
}

export async function readInvitationReport(
  db: ReportsDatabase,
  actor: ReportsAdminActor,
  siteId: string,
  queryValue: unknown,
  nowValue?: Date,
): Promise<InvitationReport> {
  const query = parseQuery(queryValue);
  const generatedAt = nowValue ? new Date(nowValue.getTime()) : new Date();
  if (!Number.isFinite(generatedAt.getTime())) {
    reject(400, "VALIDATION_ERROR", "Invalid report request");
  }
  return db.transaction(
    async (tx) => {
      const access = await tx.execute(sql`
        SELECT s.id, s.display_name
        FROM site s
        INNER JOIN "user" u ON u.id = ${actor.userId} AND u.state = 'ACTIVE'
        WHERE s.id = ${siteId}
          AND (
            ${actor.role === "OWNER"}
            OR EXISTS (
              SELECT 1 FROM site_membership sm
              WHERE sm.site_id = s.id AND sm.user_id = u.id
            )
          )
      `);
      const site = access.rows[0] as
        | { id: string; display_name: string }
        | undefined;
      if (!site) reject(404, "NOT_FOUND", "Not Found");

      const result = await tx.execute(sql`
        SELECT
          i.id AS "invitationId",
          i.name AS "invitationName",
          ${query.includePhone ? sql`i.phone_e164` : sql`NULL::text`} AS phone,
          ${query.includeEmail ? sql`i.email` : sql`NULL::text`} AS email,
          g.full_name AS "guestName",
          g.guest_type AS "guestType",
          g.rsvp_state AS "rsvpState"
        FROM invitation i
        INNER JOIN invitation_guest g
          ON g.site_id = i.site_id AND g.invitation_id = i.id
        WHERE i.site_id = ${site.id}
        ORDER BY i.name ASC, i.id ASC, g.full_name ASC, g.id ASC
      `);
      const allRows = result.rows as unknown as DatabaseRow[];
      const selectedRows = filterInvitationReportRows(allRows, query);
      return {
        siteId: site.id,
        reportTitle: site.display_name,
        generatedAt: generatedAt.toISOString(),
        timezone: "America/Sao_Paulo",
        filters: {
          search: query.search,
          status: query.status,
          guestType: query.guestType,
        },
        totals: summarize(allRows),
        selectedTotals: summarize(selectedRows),
        rows: selectedRows.map((row) => ({
          invitationName: row.invitationName,
          guestName: row.guestName,
          guestType: row.guestType,
          rsvpState: row.rsvpState,
          ...(query.includePhone ? { phone: row.phone ?? "" } : {}),
          ...(query.includeEmail ? { email: row.email ?? "" } : {}),
        })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

const RSVP_LABELS = {
  PENDING: "Sem resposta",
  CONFIRMED: "Irá comparecer",
  DECLINED: "Não comparecerá",
} satisfies Record<RsvpState, string>;
const TYPE_LABELS = {
  ADULT: "Adulto",
  CHILD: "Criança",
} satisfies Record<InvitationGuestType, string>;

function protectSpreadsheetCell(value: string): string {
  return /^[=+\-@\t\r\n]/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  return `"${protectSpreadsheetCell(value).replaceAll('"', '""')}"`;
}

type ContactOptions = { includePhone: boolean; includeEmail: boolean };

export function createInvitationCsv(
  report: InvitationReport,
  options: ContactOptions,
): Uint8Array {
  const rows = [
    [
      "Convite",
      "Convidado",
      "Tipo",
      "Status",
      ...(options.includePhone ? ["Telefone"] : []),
      ...(options.includeEmail ? ["E-mail"] : []),
    ],
    ...report.rows.map((row) => [
      row.invitationName,
      row.guestName,
      TYPE_LABELS[row.guestType],
      RSVP_LABELS[row.rsvpState],
      ...(options.includePhone ? [row.phone ?? ""] : []),
      ...(options.includeEmail ? [row.email ?? ""] : []),
    ]),
  ];
  return new TextEncoder().encode(
    `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
  );
}

const require = createRequire(import.meta.url);
const regularFont = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const boldFont = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
const MM = 72 / 25.4;
const MARGIN = 15 * MM;
const FOOTER_Y = 785;
const PAGE_WIDTH = 595.28;

function pdfText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return (
        point === 9 ||
        point === 10 ||
        point === 13 ||
        (point >= 32 && point !== 127)
      );
    })
    .join("");
}

export function createInvitationPdf(
  report: InvitationReport,
  options: ContactOptions,
): Promise<Uint8Array> {
  return new Promise((resolve, rejectPromise) => {
    const document = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", rejectPromise);
    document.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    try {
      document.registerFont("DejaVu", regularFont);
      document.registerFont("DejaVu-Bold", boldFont);
      document
        .font("DejaVu-Bold")
        .fontSize(18)
        .text(pdfText(report.reportTitle));
      document.font("DejaVu").fontSize(9).moveDown(0.4);
      document.text(`Gerado em ${report.generatedAt} (UTC)`);
      document.text(
        `Busca: ${pdfText(report.filters.search || "Todas")} | Status: ${report.filters.status ? RSVP_LABELS[report.filters.status] : "Todos"} | Tipo: ${report.filters.guestType ? TYPE_LABELS[report.filters.guestType] : "Todos"}`,
      );
      document.moveDown(0.5);
      document.text(
        `Total do site: ${report.totals.invitations} convites, ${report.totals.guests} convidados`,
      );
      document.text(
        `Seleção: ${report.selectedTotals.invitations} convites, ${report.selectedTotals.guests} convidados — ${report.selectedTotals.adults} adultos, ${report.selectedTotals.children} crianças`,
      );
      document.text(
        `Sem resposta: ${report.selectedTotals.pending} | Irá comparecer: ${report.selectedTotals.confirmed} | Não comparecerá: ${report.selectedTotals.declined}`,
      );
      document.moveDown(0.65);
      for (const row of report.rows) {
        const lines = [
          `${row.invitationName} — ${row.guestName}`,
          `${TYPE_LABELS[row.guestType]} | ${RSVP_LABELS[row.rsvpState]}`,
          ...(options.includePhone ? [`Telefone: ${row.phone ?? ""}`] : []),
          ...(options.includeEmail ? [`E-mail: ${row.email ?? ""}`] : []),
        ].map(pdfText);
        const height =
          lines.reduce(
            (sum, line, index) =>
              sum +
              document
                .font(index === 0 ? "DejaVu-Bold" : "DejaVu")
                .fontSize(index === 0 ? 9 : 8)
                .heightOfString(line, { width: PAGE_WIDTH - 2 * MARGIN }),
            0,
          ) + 9;
        if (document.y + height > FOOTER_Y - 18) {
          document.addPage();
        }
        for (const [index, line] of lines.entries()) {
          document
            .font(index === 0 ? "DejaVu-Bold" : "DejaVu")
            .fontSize(index === 0 ? 9 : 8)
            .text(line);
        }
        document.moveDown(0.45);
      }
      const range = document.bufferedPageRange();
      for (
        let index = range.start;
        index < range.start + range.count;
        index += 1
      ) {
        document.switchToPage(index);
        document.font("DejaVu").fontSize(8).fillColor("#555555");
        document.text(
          `Página ${index + 1} / ${range.count}`,
          MARGIN,
          FOOTER_Y,
          {
            width: PAGE_WIDTH - MARGIN * 2,
            align: "right",
          },
        );
      }
      document.end();
    } catch (error) {
      rejectPromise(error);
    }
  });
}
