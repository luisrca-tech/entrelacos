import { createRequire } from "node:module";
import { type RsvpState, rsvpExportQuerySchema } from "@entrelacos/contracts";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import PDFDocument from "pdfkit";

export type ReportsDatabase = NodePgDatabase<Record<string, never>>;
export type ReportsAdminActor = {
  userId: string;
  role: "OWNER" | "SITE_ADMIN";
};

export type RsvpTotals = {
  pending: number;
  confirmed: number;
  declined: number;
};

export type RsvpReportRow = {
  groupName: string;
  memberName: string;
  rsvpState: RsvpState;
  representativePhone?: string;
};

export type RsvpReport = {
  siteId: string;
  reportTitle: string;
  generatedAt: string;
  timezone: "America/Sao_Paulo";
  groupFilter: string | null;
  stateFilter: RsvpState | null;
  totals: RsvpTotals;
  selectedTotals: RsvpTotals;
  rows: RsvpReportRow[];
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

function parseQuery(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).includePhone === "boolean"
  ) {
    const input = value as Record<string, unknown>;
    return rsvpExportQuerySchema.parse({
      ...input,
      includePhone: String(input.includePhone),
    });
  }
  return rsvpExportQuerySchema.parse(value);
}

function emptyTotals(): RsvpTotals {
  return { pending: 0, confirmed: 0, declined: 0 };
}

function addState(totals: RsvpTotals, state: RsvpState): void {
  if (state === "PENDING") totals.pending += 1;
  if (state === "CONFIRMED") totals.confirmed += 1;
  if (state === "DECLINED") totals.declined += 1;
}

const RSVP_STATE_LABELS = {
  PENDING: "Pendente",
  CONFIRMED: "Confirmado",
  DECLINED: "Não comparecerá",
} satisfies Record<RsvpState, string>;

export function formatRsvpState(state: RsvpState): string {
  return RSVP_STATE_LABELS[state];
}

type ReportDatabaseRow = {
  group_id: string;
  group_name: string;
  group_phone: string | null;
  member_id: string;
  member_name: string;
  rsvp_state: RsvpState;
};

export async function readRsvpReport(
  db: ReportsDatabase,
  actor: ReportsAdminActor,
  siteId: string,
  queryValue: unknown,
  nowValue?: Date,
): Promise<RsvpReport> {
  const query = parseQuery(queryValue);
  const generatedAt = nowValue ? new Date(nowValue.getTime()) : new Date();
  if (!Number.isFinite(generatedAt.getTime()))
    reject(400, "VALIDATION_ERROR", "Invalid report request");

  return db.transaction(
    async (tx) => {
      const access = await tx.execute(sql`
      SELECT s.id, s.display_name
      FROM site s
      INNER JOIN "user" u
        ON u.id = ${actor.userId} AND u.state = 'ACTIVE'
      WHERE s.id = ${siteId}
        AND (
          ${actor.role === "OWNER"}
          OR EXISTS (
            SELECT 1
            FROM site_membership sm
            WHERE sm.site_id = s.id AND sm.user_id = u.id
          )
        )
    `);
      const site = access.rows[0] as
        | { id: string; display_name: string }
        | undefined;
      if (!site) reject(404, "NOT_FOUND", "Not Found");

      if (query.groupId) {
        const group = await tx.execute(sql`
        SELECT 1
        FROM guest_group
        WHERE site_id = ${site.id} AND id = ${query.groupId}
        LIMIT 1
      `);
        if (group.rows.length === 0) reject(404, "NOT_FOUND", "Not Found");
      }

      const result = await tx.execute(sql`
      SELECT
        gg.id AS group_id,
        gg.name AS group_name,
        ${query.includePhone ? sql`gg.phone_e164` : sql`NULL::text`} AS group_phone,
        gm.id AS member_id,
        gm.full_name AS member_name,
        gm.rsvp_state
      FROM guest_group gg
      INNER JOIN guest_member gm
        ON gm.site_id = gg.site_id AND gm.group_id = gg.id
      WHERE gg.site_id = ${site.id}
      ORDER BY gg.name ASC, gg.id ASC, gm.full_name ASC, gm.id ASC
    `);
      const rows = result.rows as unknown as ReportDatabaseRow[];
      const totals = emptyTotals();
      const selectedTotals = emptyTotals();
      for (const row of rows) {
        addState(totals, row.rsvp_state);
        if (
          (!query.groupId || row.group_id === query.groupId) &&
          (!query.state || row.rsvp_state === query.state)
        ) {
          addState(selectedTotals, row.rsvp_state);
        }
      }

      return {
        siteId: site.id,
        reportTitle: site.display_name,
        generatedAt: generatedAt.toISOString(),
        timezone: "America/Sao_Paulo",
        groupFilter: query.groupId ?? null,
        stateFilter: query.state ?? null,
        totals,
        selectedTotals,
        rows: rows
          .filter(
            (row) =>
              (!query.groupId || row.group_id === query.groupId) &&
              (!query.state || row.rsvp_state === query.state),
          )
          .map((row) => ({
            groupName: row.group_name,
            memberName: row.member_name,
            rsvpState: row.rsvp_state,
            ...(query.includePhone
              ? { representativePhone: row.group_phone ?? "" }
              : {}),
          })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

const CSV_COLUMNS = [
  "recordType",
  "reportTitle",
  "generatedAt",
  "timezone",
  "groupFilter",
  "stateFilter",
  "totalPending",
  "totalConfirmed",
  "totalDeclined",
  "selectedPending",
  "selectedConfirmed",
  "selectedDeclined",
  "groupName",
  "memberName",
  "rsvpState",
] as const;

function protectSpreadsheetCell(value: string): string {
  return /^[=+\-@\t\r\n]/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number): string {
  return `"${protectSpreadsheetCell(String(value)).replaceAll('"', '""')}"`;
}

function csvRow(values: Array<string | number>): string {
  return values.map(csvCell).join(",");
}

export function createRsvpCsv(
  report: RsvpReport,
  includePhone = false,
): Uint8Array {
  const columns = [
    ...CSV_COLUMNS,
    ...(includePhone ? ["representativePhone"] : []),
  ];
  const summary = [
    "SUMMARY",
    report.reportTitle,
    report.generatedAt,
    report.timezone,
    report.groupFilter ?? "",
    report.stateFilter ? formatRsvpState(report.stateFilter) : "",
    report.totals.pending,
    report.totals.confirmed,
    report.totals.declined,
    report.selectedTotals.pending,
    report.selectedTotals.confirmed,
    report.selectedTotals.declined,
    "",
    "",
    "",
    ...(includePhone ? [""] : []),
  ];
  const members = report.rows.map((row) => [
    "MEMBER",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    row.groupName,
    row.memberName,
    formatRsvpState(row.rsvpState),
    ...(includePhone ? [row.representativePhone ?? ""] : []),
  ]);
  const csv = [csvRow(columns), csvRow(summary), ...members.map(csvRow)].join(
    "\r\n",
  );
  return new TextEncoder().encode(`\uFEFF${csv}\r\n`);
}

export const generateRsvpCsv = createRsvpCsv;

const require = createRequire(import.meta.url);
const regularFont = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const boldFont = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
const MM = 72 / 25.4;
const PAGE_WIDTH = 595.28;
const MARGIN = 15 * MM;
const FOOTER_Y = 785;

function formatFilter(value: string | null): string {
  return value ?? "Todos";
}

function formatStateFilter(value: RsvpState | null): string {
  return value ? formatRsvpState(value) : "Todos";
}

function createPdfDocument() {
  return new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    autoFirstPage: true,
  });
}

function pdfText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint >= 32 && codePoint !== 127)
      );
    })
    .join("");
}

export function createRsvpPdf(
  report: RsvpReport,
  includePhone = false,
): Promise<Uint8Array> {
  return new Promise((resolve, rejectPromise) => {
    const document = createPdfDocument();
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", rejectPromise);
    document.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));

    try {
      document.registerFont("DejaVu", regularFont);
      document.registerFont("DejaVu-Bold", boldFont);
      document.font("DejaVu");
      document
        .fontSize(18)
        .font("DejaVu-Bold")
        .text(pdfText(report.reportTitle));
      document.moveDown(0.35);
      document
        .fontSize(9)
        .font("DejaVu")
        .text(`Gerado em ${report.generatedAt} (UTC)`);
      document.text(`Fuso de exibição: ${report.timezone}`);
      document.text(
        `Grupo: ${formatFilter(report.groupFilter)} | Estado: ${formatStateFilter(report.stateFilter)}`,
      );
      document.moveDown(0.5);
      document.fontSize(11).font("DejaVu-Bold").text("Totais do site");
      document
        .fontSize(9)
        .font("DejaVu")
        .text(
          `Pendente: ${report.totals.pending} | Confirmado: ${report.totals.confirmed} | Não comparecerá: ${report.totals.declined}`,
        );
      document.text("Totais selecionados");
      document.text(
        `Pendente: ${report.selectedTotals.pending} | Confirmado: ${report.selectedTotals.confirmed} | Não comparecerá: ${report.selectedTotals.declined}`,
      );
      document.moveDown(0.65);

      const tableTop = () => {
        document.font("DejaVu-Bold").fontSize(9);
        const columns = includePhone
          ? [
              ["Grupo", 140],
              ["Convidado", 195],
              ["Estado", 75],
              ["Telefone", 100],
            ]
          : [
              ["Grupo", 175],
              ["Convidado", 235],
              ["Estado", 100],
            ];
        const y = document.y;
        let x = MARGIN;
        for (const [label, width] of columns) {
          document.text(String(label), x, y, {
            width: width as number,
            height: 12,
            lineBreak: false,
          });
          x += width as number;
        }
        document.y = y + 15;
        document.font("DejaVu").fontSize(8);
        return columns as Array<[string, number]>;
      };

      let columns = tableTop();
      for (const row of report.rows) {
        const values = includePhone
          ? [
              row.groupName,
              row.memberName,
              formatRsvpState(row.rsvpState),
              row.representativePhone ?? "",
            ]
          : [row.groupName, row.memberName, formatRsvpState(row.rsvpState)];
        const heights = values.map((value, index) =>
          document.heightOfString(pdfText(String(value)), {
            width: columns[index]?.[1] ?? 0,
          }),
        );
        const rowHeight = Math.max(...heights, 12) + 4;
        if (document.y + rowHeight > FOOTER_Y - 18) {
          document.addPage({
            size: "A4",
            margins: {
              top: MARGIN,
              bottom: MARGIN,
              left: MARGIN,
              right: MARGIN,
            },
          });
          columns = tableTop();
        }
        const y = document.y;
        let x = MARGIN;
        for (let index = 0; index < values.length; index += 1) {
          const width = columns[index]?.[1] ?? 0;
          document.text(pdfText(String(values[index] ?? "")), x, y, {
            width,
            height: rowHeight,
          });
          x += width;
        }
        document.y = y + rowHeight;
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
        document.fillColor("#000000");
      }
      document.end();
    } catch (error) {
      rejectPromise(error);
    }
  });
}

export const generateRsvpPdf = createRsvpPdf;
