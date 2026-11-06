import { createRequire } from "node:module";
import {
  type InvitationExportModel,
  type InvitationExportQuery,
  type InvitationGuestType,
  invitationExportQuerySchema,
  invitationGroupStatus,
  type RsvpState,
} from "@entrelacos/contracts";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import PDFDocument from "pdfkit";
import { normalizeInvitationName } from "./invitations";

export type ReportsDatabase = NodePgDatabase<Record<string, never>>;
export type ReportsAdminActor = {
  userId: string;
  role: "OWNER" | "SITE_ADMIN" | "SITE_ASSISTANT";
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
  invitationId: string;
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
  filters: Pick<
    InvitationExportQuery,
    "search" | "status" | "groupStatus" | "guestType"
  >;
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

function groupInvitationRows(rows: readonly InvitationReportRow[]) {
  const groups = new Map<
    string,
    [InvitationReportRow, ...InvitationReportRow[]]
  >();
  for (const row of rows) {
    const group = groups.get(row.invitationId);
    if (group) group.push(row);
    else groups.set(row.invitationId, [row]);
  }
  return groups.values();
}

function summarize(
  rows: readonly InvitationReportRow[],
): InvitationReportTotals {
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
        INNER JOIN "user" u ON u.id = ${actor.userId} AND u.state = 'ACTIVE' AND u.role = ${actor.role}
        WHERE s.id = ${siteId}
          AND (
            ${actor.role === "OWNER"}
            OR EXISTS (
              SELECT 1 FROM site_membership sm
              WHERE sm.site_id = s.id AND sm.user_id = u.id AND sm.revoked_at IS NULL AND sm.role IN ('SITE_ADMIN', 'SITE_ASSISTANT')
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
      const allRows = result.rows as unknown as InvitationReportRow[];
      const { model, groupStatus, search, guestType } = query;
      const status = model === "reception" ? "CONFIRMED" : query.status;
      const normalizedSearch = normalizeInvitationName(search ?? "");
      let selectedRows = allRows;
      if (!model || model === "reception") {
        selectedRows = filterInvitationReportRows(allRows, {
          search,
          status,
          guestType,
        });
      } else if (normalizedSearch || groupStatus || guestType) {
        selectedRows = [...groupInvitationRows(allRows)]
          .filter(
            (group) =>
              (!normalizedSearch ||
                normalizeInvitationName(group[0].invitationName).includes(
                  normalizedSearch,
                )) &&
              (!groupStatus || invitationGroupStatus(group) === groupStatus) &&
              (!guestType ||
                group.some((guest) => guest.guestType === guestType)),
          )
          .flat();
      }
      return {
        siteId: site.id,
        reportTitle: site.display_name,
        generatedAt: generatedAt.toISOString(),
        timezone: "America/Sao_Paulo",
        filters: {
          search,
          status,
          groupStatus,
          guestType,
        },
        totals: summarize(allRows),
        selectedTotals: summarize(selectedRows),
        rows: selectedRows.map((row) => ({
          invitationId: row.invitationId,
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
const GROUP_LABELS = {
  CONFIRMED: "Confirmados",
  PENDING: "Sem resposta",
  DECLINED: "Não irão",
  PARTIAL: "Em parte",
} as const;

function protectSpreadsheetCell(value: string): string {
  return /^[=+\-@\t\r\n]/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  return `"${protectSpreadsheetCell(value).replaceAll('"', '""')}"`;
}

type ExportOptions = {
  includePhone: boolean;
  includeEmail: boolean;
  model?: InvitationExportModel;
};

export function createInvitationCsv(
  report: InvitationReport,
  options: ExportOptions,
): Uint8Array {
  const grouped = options.model === "groups";
  const contactValues = (row: InvitationReportRow) => [
    ...(options.includePhone ? [row.phone ?? ""] : []),
    ...(options.includeEmail ? [row.email ?? ""] : []),
  ];
  const rows = [
    [
      ...(grouped
        ? [
            "Convite",
            "Convidados",
            "Confirmados",
            "Sem resposta",
            "Não irão",
            "Situação do convite",
          ]
        : ["Convite", "Convidado", "Tipo", "Status"]),
      ...(options.includePhone ? ["Telefone"] : []),
      ...(options.includeEmail ? ["E-mail"] : []),
    ],
    ...(grouped
      ? [...groupInvitationRows(report.rows)].map((group) => {
          const [first] = group;
          const { guests, confirmed, pending, declined } = summarize(group);
          return [
            first.invitationName,
            String(guests),
            String(confirmed),
            String(pending),
            String(declined),
            GROUP_LABELS[invitationGroupStatus(group)],
            ...contactValues(first),
          ];
        })
      : report.rows.map((row) => [
          row.invitationName,
          row.guestName,
          TYPE_LABELS[row.guestType],
          RSVP_LABELS[row.rsvpState],
          ...contactValues(row),
        ])),
  ];
  return new TextEncoder().encode(
    `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
  );
}

const require = createRequire(import.meta.url);
const regularFont = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const boldFont = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
const displayFont = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSerif.ttf");
const MM = 72 / 25.4;
const MARGIN = 15 * MM;
const FOOTER_Y = 785;
const INK = "#2b211b";
const ACCENT = "#8e3a2a";
const MUTED = "#62554b";
const LINE = "#e2d8ca";
const WASH = "#f7f3ed";

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
  options: ExportOptions,
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
      document.registerFont("DejaVu-Serif", displayFont);
      const reception = options.model === "reception";
      const title = reception ? "Lista de recepção" : "Lista para a assessoria";
      const wedding = pdfText(report.reportTitle);
      const width = document.page.width - 2 * MARGIN;
      const bottom = FOOTER_Y - 19;
      const columnWidths = reception
        ? [width - 253, 190, 63]
        : [width - 193, 74, 119];
      const columns = reception
        ? ["Convidado", "Convite", "Chegou"]
        : ["Convidado", "Tipo", "Resposta"];
      let y = MARGIN;

      function rowHeight(
        cells: readonly string[],
        widths: readonly number[],
        bold = false,
      ) {
        document.font(bold ? "DejaVu-Bold" : "DejaVu").fontSize(9);
        return (
          Math.max(
            13,
            ...cells.map((value, index) =>
              document.heightOfString(pdfText(value), {
                width: widths[index] - 20,
              }),
            ),
          ) + 14
        );
      }

      function drawRow(
        cells: readonly string[],
        widths: readonly number[],
        style: "header" | "group" | "guest",
        checkbox = false,
      ) {
        const bold = style !== "guest";
        const height = rowHeight(cells, widths, bold);
        if (bold) document.rect(MARGIN, y, width, height).fill(WASH);
        document.fillColor(style === "group" ? ACCENT : INK);
        let x = MARGIN;
        for (const [index, value] of cells.entries()) {
          document.text(pdfText(value), x + 10, y + 7, {
            width: widths[index] - 20,
          });
          x += widths[index];
        }
        if (checkbox) {
          document
            .rect(MARGIN + width - columnWidths[2] + 10, y + 7, 10, 10)
            .strokeColor(MUTED)
            .stroke();
        }
        y += height;
        document
          .moveTo(MARGIN, y)
          .lineTo(MARGIN + width, y)
          .strokeColor(LINE)
          .stroke();
      }

      function startNextPage() {
        document.addPage();
        document
          .font("DejaVu-Bold")
          .fontSize(10)
          .fillColor(INK)
          .text(`${title} · ${wedding}`, MARGIN, MARGIN, { width });
        y = document.y + 12;
        drawRow(columns, columnWidths, "header");
      }

      const date = new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: report.timezone,
      }).format(new Date(report.generatedAt));
      document
        .font("DejaVu-Bold")
        .fontSize(9)
        .fillColor(ACCENT)
        .text("ENTRELAÇOS", MARGIN, MARGIN);
      document
        .font("DejaVu-Serif")
        .fontSize(25)
        .fillColor(INK)
        .moveDown(0.25)
        .text(title);
      document.font("DejaVu-Serif").fontSize(16).text(wedding);
      document
        .font("DejaVu")
        .fontSize(9)
        .fillColor(MUTED)
        .moveDown(0.5)
        .text(`Gerado em ${date} · horário de Brasília`);

      const { search, status, groupStatus, guestType } = report.filters;
      const scope = [
        search && `Busca: ${search}`,
        groupStatus && GROUP_LABELS[groupStatus],
        status && RSVP_LABELS[status],
        guestType && TYPE_LABELS[guestType],
      ]
        .filter(Boolean)
        .join(" · ");
      document.text(
        reception
          ? "Somente convidados confirmados · ordem alfabética"
          : scope
            ? `Recorte: ${pdfText(scope)}`
            : "Todos os convites",
      );
      y = document.y + 16;

      const { invitations, guests, confirmed, pending, declined } =
        report.selectedTotals;
      const confirmedAdults = report.rows.filter(
        (row) => row.rsvpState === "CONFIRMED" && row.guestType === "ADULT",
      ).length;
      const metrics = reception
        ? [[confirmed, "Confirmados"]]
        : [
            [confirmed, "Confirmados"],
            [pending, "Sem resposta"],
            [declined, "Não irão"],
          ];
      const metricWidth = (width - 10 * (metrics.length - 1)) / metrics.length;
      for (const [index, [count, label]] of metrics.entries()) {
        const x = MARGIN + index * (metricWidth + 10);
        document.rect(x, y, metricWidth, 51).fill(WASH);
        document
          .font("DejaVu-Serif")
          .fontSize(21)
          .fillColor(ACCENT)
          .text(String(count), x + 10, y + 4);
        document
          .font("DejaVu")
          .fontSize(9)
          .fillColor(INK)
          .text(String(label), x + 10, y + 32);
      }
      y += 60;
      document
        .font("DejaVu")
        .fontSize(9)
        .fillColor(MUTED)
        .text(
          `Confirmados: ${confirmedAdults} adultos · ${confirmed - confirmedAdults} crianças` +
            (reception
              ? ""
              : `   |   Recorte: ${invitations} convites · ${guests} convidados`),
          MARGIN,
          y,
          { width },
        );
      y = document.y + 15;
      drawRow(columns, columnWidths, "header");

      if (!report.rows.length) {
        drawRow(
          [
            reception
              ? "Ainda não há convidados confirmados."
              : "Nenhum convidado neste recorte.",
          ],
          [width],
          "guest",
        );
      } else if (reception) {
        const collator = new Intl.Collator("pt-BR", { sensitivity: "base" });
        const sorted = [...report.rows].sort(
          (a, b) =>
            collator.compare(a.guestName, b.guestName) ||
            collator.compare(a.invitationName, b.invitationName),
        );
        for (const row of sorted) {
          const cells = [row.guestName, row.invitationName, ""];
          if (y + rowHeight(cells, columnWidths) > bottom) startNextPage();
          drawRow(cells, columnWidths, "guest", true);
        }
      } else {
        for (const group of groupInvitationRows(report.rows)) {
          const [first] = group;
          const groupLabel = [first.invitationName];
          for (const [index, row] of group.entries()) {
            const contacts = [
              options.includePhone && row.phone,
              options.includeEmail && row.email,
            ].filter(Boolean);
            const cells = [
              [row.guestName, ...contacts].join("\n"),
              TYPE_LABELS[row.guestType],
              RSVP_LABELS[row.rsvpState],
            ];
            const groupHeight =
              index === 0 ? rowHeight(groupLabel, [width], true) : 0;
            const needsPage =
              y + groupHeight + rowHeight(cells, columnWidths) > bottom;
            if (needsPage) startNextPage();
            if (index === 0 || needsPage) {
              drawRow(
                index === 0
                  ? groupLabel
                  : [`${first.invitationName} (continuação)`],
                [width],
                "group",
              );
            }
            drawRow(cells, columnWidths, "guest");
          }
        }
      }

      const range = document.bufferedPageRange();
      for (
        let index = range.start;
        index < range.start + range.count;
        index += 1
      ) {
        document.switchToPage(index);
        document
          .moveTo(MARGIN, FOOTER_Y - 7)
          .lineTo(MARGIN + width, FOOTER_Y - 7)
          .strokeColor(LINE)
          .stroke();
        document.font("DejaVu").fontSize(8).fillColor(MUTED);
        document.text("Entrelaços · Lista de convidados", MARGIN, FOOTER_Y, {
          width,
        });
        document.text(
          `Página ${index + 1} / ${range.count}`,
          MARGIN,
          FOOTER_Y,
          {
            width,
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
