import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  readRsvpReport: vi.fn(),
  createRsvpCsv: vi.fn(),
  createRsvpPdf: vi.fn(),
  ReportsServiceError: class ReportsServiceError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly title: string,
    ) {
      super(title);
      this.name = "ReportsServiceError";
    }
  },
}));

vi.mock("./authHttp", () => ({
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
  requireAdminSession: mocks.requireAdminSession,
}));

vi.mock("./reports", () => ({
  ReportsServiceError: mocks.ReportsServiceError,
  readRsvpReport: mocks.readRsvpReport,
  createRsvpCsv: mocks.createRsvpCsv,
  createRsvpPdf: mocks.createRsvpPdf,
}));

import { createReportsHttpRouter } from "./reportsHttp";

const adminOrigin = "https://admin.example.test";
const requestId = "f4217d1d-bcae-4ac1-a67b-fabc195b7b86";
const report = {
  siteId: "site-1",
  reportTitle: "Ana & João",
  generatedAt: "2029-01-10T12:00:00.000Z",
  timezone: "America/Sao_Paulo" as const,
  groupFilter: null,
  stateFilter: null,
  totals: { pending: 1, confirmed: 0, declined: 0 },
  selectedTotals: { pending: 1, confirmed: 0, declined: 0 },
  rows: [],
};

function request(path: string, origin = adminOrigin): Request {
  return new Request(`https://api.example.test${path}`, {
    headers: { Origin: origin },
  });
}

function router() {
  return createReportsHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin,
    now: () => new Date("2029-01-10T12:00:00.000Z"),
  });
}

describe("RSVP report HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "admin-1", role: "SITE_ADMIN" },
    });
    mocks.readRsvpReport.mockResolvedValue(report);
    mocks.createRsvpCsv.mockReturnValue(new TextEncoder().encode("csv"));
    mocks.createRsvpPdf.mockResolvedValue(new TextEncoder().encode("pdf"));
  });

  it("requires exact admin origin and explicit UUID and phone query", async () => {
    const foreign = await router().request(
      request(
        `/v1/sites/site-1/reports/rsvp.csv?requestId=${requestId}&includePhone=false`,
        "https://evil.example.test",
      ),
    );
    expect(foreign.status).toBe(403);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();

    const missing = await router().request(
      request(`/v1/sites/site-1/reports/rsvp.csv?requestId=${requestId}`),
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe("VALIDATION_ERROR");
    expect(mocks.readRsvpReport).not.toHaveBeenCalled();
  });

  it("returns binary attachment bytes, no-store, and safe filename", async () => {
    const response = await router().request(
      request(
        `/v1/sites/site-1/reports/rsvp.csv?requestId=${requestId}&includePhone=true&state=CONFIRMED`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="entrelacos-rsvp-site-1-20290110120000-${requestId}.csv"`,
    );
    expect(await response.text()).toBe("csv");
    expect(mocks.readRsvpReport).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "admin-1", role: "SITE_ADMIN" },
      "site-1",
      { requestId, includePhone: true, state: "CONFIRMED" },
      expect.any(Date),
    );
  });

  it("uses PDF content type and converts generation failures to problem responses", async () => {
    const pdf = await router().request(
      request(
        `/v1/sites/site-1/reports/rsvp.pdf?requestId=${requestId}&includePhone=false`,
      ),
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(await pdf.text()).toBe("pdf");

    mocks.createRsvpPdf.mockRejectedValue(new Error("font failure"));
    const failed = await router().request(
      request(
        `/v1/sites/site-1/reports/rsvp.pdf?requestId=${requestId}&includePhone=false`,
      ),
    );
    expect(failed.status).toBe(503);
    expect(failed.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});
