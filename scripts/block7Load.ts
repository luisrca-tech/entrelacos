import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  asc,
  eq,
  inArray,
  sql,
} from "../packages/database/node_modules/drizzle-orm";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "../packages/database/src/connection";
import {
  guestGroup,
  guestMember,
  guestRateLimitEvent,
  site,
  siteOrigin,
} from "../packages/database/src/schema";

export const LOAD_SHAPE = {
  tenantCount: 20,
  guestsPerTenant: 500,
  totalGuests: 10_000,
} as const;

export const DEFAULT_BASE_URL = "http://127.0.0.1:18080";
export const DEFAULT_CONCURRENCY_LEVELS = [5, 20] as const;
const FIXTURE_PREFIX = "block7-load-";
const FIXTURE_EVENT_DATE = "2099-12-31";
const FIXTURE_TIME = new Date("2099-01-01T00:00:00.000Z");

export interface LoadGuest {
  groupId: string;
  memberId: string;
  fullName: string;
  phoneE164: string;
}

export interface LoadTenant {
  index: number;
  siteId: string;
  repositorySlug: string;
  provisioningKey: string;
  publicUrl: string;
  origin: string;
  isDemo: false;
  guests: LoadGuest[];
}

export interface LoadPlan {
  prefix: string;
  tenants: LoadTenant[];
}

export interface TenantSnapshot {
  tenantIndex: number;
  siteCount: number;
  groupCount: number;
  guestCount: number;
  siteHash: string;
  groupHash: string;
  guestHash: string;
}

export interface RequestSample {
  latencyMs: number;
  status?: number;
  timedOut: boolean;
  error?: string;
  problemCode?: string;
}

export interface TrafficMeasurement {
  name: string;
  mode: "steady" | "burst";
  concurrency: number;
  requests: number;
  durationMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  statusCounts: Record<string, number>;
  problemCodes: Record<string, number>;
  errors: number;
  timeouts: number;
  rateLimits: number;
}

export interface CleanupEvidence {
  verified: boolean;
  remainingSites: number;
  remainingGroups: number;
  remainingGuests: number;
  remainingRateLimitEvents: number;
  preexistingOrphanRateLimitEventsRemoved: number;
}

export interface LoadRunReport {
  status: "completed";
  generatedAt: string;
  databaseTarget: "test";
  httpBaseUrl: string;
  shape: typeof LOAD_SHAPE;
  resources: {
    runtime: string;
    platform: string;
    cpuCount: number;
    memoryGiB: number;
  };
  seed: {
    durationMs: number;
    tenants: number;
    groups: number;
    guests: number;
  };
  traffic: TrafficMeasurement[];
  isolation: {
    beforeSeed: {
      tenants: number;
      groups: number;
      guests: number;
      aggregateHash: string;
    };
    afterSeed: {
      tenants: number;
      groups: number;
      guests: number;
      aggregateHash: string;
    };
    afterTraffic: {
      tenants: number;
      groups: number;
      guests: number;
      aggregateHash: string;
    };
    stableTenantSnapshots: number;
  };
  cleanup: CleanupEvidence;
  limitations: string[];
}

type LoadDatabase = DatabaseConnection["db"];

function hashRows(rows: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function aggregateSnapshots(snapshots: readonly TenantSnapshot[]): string {
  return hashRows(
    snapshots.map(({ tenantIndex, ...snapshot }) => ({
      tenantIndex,
      ...snapshot,
    })),
  );
}

function snapshotTotals(snapshots: readonly TenantSnapshot[]) {
  return {
    tenants: snapshots.filter((snapshot) => snapshot.siteCount > 0).length,
    groups: snapshots.reduce((sum, snapshot) => sum + snapshot.groupCount, 0),
    guests: snapshots.reduce((sum, snapshot) => sum + snapshot.guestCount, 0),
    aggregateHash: aggregateSnapshots(snapshots),
  };
}

export function assertSafeLoadPrefix(prefix: string): void {
  if (
    !prefix.startsWith(FIXTURE_PREFIX) ||
    !/^block7-load-[A-Za-z0-9-]{1,40}$/.test(prefix) ||
    /(?:demo|legacy|prod|production)/i.test(prefix)
  ) {
    throw new Error(
      "Load prefix must be a unique block7-load marker and cannot target demo, legacy, or production data",
    );
  }
}

export function assertLocalBaseUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "18080" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("Block 7 load requires http://127.0.0.1:18080");
  }
}

function syntheticPhone(tenantIndex: number, guestIndex: number): string {
  const areaCode = `${1 + Math.floor(tenantIndex / 9)}${1 + (tenantIndex % 9)}`;
  const subscriber = String(guestIndex).padStart(8, "0");
  return `+55${areaCode}9${subscriber}`;
}

function loopbackHost(tenantIndex: number): string {
  return `127.0.0.${tenantIndex + 1}`;
}

export function defaultLoadPrefix(): string {
  return `${FIXTURE_PREFIX}${process.pid}-${Date.now().toString(36)}`;
}

export function buildLoadPlan(prefix: string): LoadPlan {
  assertSafeLoadPrefix(prefix);
  const tenants = Array.from(
    { length: LOAD_SHAPE.tenantCount },
    (_, tenantIndex) => {
      const tenantNumber = String(tenantIndex + 1).padStart(2, "0");
      const siteId = `${prefix}-site-${tenantNumber}`;
      const repositorySlug = `${prefix}-t${tenantNumber}`.toLowerCase();
      const provisioningKey = `${prefix}:qa-owned:t${tenantNumber}`;
      const origin = `http://${loopbackHost(tenantIndex)}:18080`;
      const guests = Array.from(
        { length: LOAD_SHAPE.guestsPerTenant },
        (_, guestIndex) => {
          const guestNumber = String(guestIndex + 1).padStart(3, "0");
          const groupId = `${siteId}-group-${guestNumber}`;
          return {
            groupId,
            memberId: `${groupId}-member`,
            fullName: `QA Load Tenant ${tenantNumber} Guest ${guestNumber}`,
            phoneE164: syntheticPhone(tenantIndex, guestIndex),
          };
        },
      );
      return {
        index: tenantIndex,
        siteId,
        repositorySlug,
        provisioningKey,
        publicUrl: `${origin}/`,
        origin,
        isDemo: false as const,
        guests,
      };
    },
  );
  return { prefix, tenants };
}

function fixtureSiteValues(plan: LoadPlan) {
  return plan.tenants.map((tenant) => ({
    id: tenant.siteId,
    repositorySlug: tenant.repositorySlug,
    provisioningKey: tenant.provisioningKey,
    displayName: `QA Load Site ${String(tenant.index + 1).padStart(2, "0")}`,
    partnerOneName: `QA Load Partner A ${tenant.index + 1}`,
    partnerTwoName: `QA Load Partner B ${tenant.index + 1}`,
    eventDate: FIXTURE_EVENT_DATE,
    lifecycle: "ACTIVE" as const,
    publicationState: "PUBLISHED" as const,
    isDemo: false,
    muralEnabled: true,
    publicUrl: tenant.publicUrl,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  }));
}

async function insertChunks<T>(
  insert: (values: T[]) => Promise<unknown>,
  values: T[],
  chunkSize = 500,
): Promise<void> {
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    await insert(values.slice(offset, offset + chunkSize));
  }
}

export async function seedLoadFixtures(
  db: LoadDatabase,
  plan: LoadPlan,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SET CONSTRAINTS guest_group_representative_member_fk DEFERRED`,
    );
    await insertChunks(
      (values) => tx.insert(site).values(values as never),
      fixtureSiteValues(plan),
      20,
    );
    await insertChunks(
      (values) =>
        tx.insert(siteOrigin).values(
          values.map((tenant) => ({
            id: `${tenant.siteId}-origin`,
            siteId: tenant.siteId,
            origin: tenant.origin,
          })) as never,
        ),
      plan.tenants,
      20,
    );
    for (const tenant of plan.tenants) {
      await insertChunks(
        (values) =>
          tx.insert(guestGroup).values(
            values.map((guest) => ({
              id: guest.groupId,
              siteId: tenant.siteId,
              name: `${guest.fullName} Group`,
              normalizedName: `${guest.fullName.toLowerCase()} group`,
              isForeign: false,
              phoneE164: guest.phoneE164,
              representativeMemberId: guest.memberId,
              createdAt: FIXTURE_TIME,
              updatedAt: FIXTURE_TIME,
            })) as never,
          ),
        tenant.guests,
      );
      await insertChunks(
        (values) =>
          tx.insert(guestMember).values(
            values.map((guest) => ({
              id: guest.memberId,
              siteId: tenant.siteId,
              groupId: guest.groupId,
              fullName: guest.fullName,
              normalizedName: guest.fullName.toLowerCase(),
              createdAt: FIXTURE_TIME,
              updatedAt: FIXTURE_TIME,
            })) as never,
          ),
        tenant.guests,
      );
    }
  });
}

export async function snapshotTenant(
  db: LoadDatabase,
  tenant: LoadTenant,
): Promise<TenantSnapshot> {
  const [sites, groups, guests] = await Promise.all([
    db
      .select({
        id: site.id,
        repositorySlug: site.repositorySlug,
        lifecycle: site.lifecycle,
        publicationState: site.publicationState,
        isDemo: site.isDemo,
        muralEnabled: site.muralEnabled,
        publicUrl: site.publicUrl,
      })
      .from(site)
      .where(eq(site.id, tenant.siteId))
      .orderBy(asc(site.id)),
    db
      .select({
        id: guestGroup.id,
        siteId: guestGroup.siteId,
        name: guestGroup.name,
        normalizedName: guestGroup.normalizedName,
        phoneE164: guestGroup.phoneE164,
        representativeMemberId: guestGroup.representativeMemberId,
        isForeign: guestGroup.isForeign,
        messageRevision: guestGroup.messageRevision,
      })
      .from(guestGroup)
      .where(eq(guestGroup.siteId, tenant.siteId))
      .orderBy(asc(guestGroup.id)),
    db
      .select({
        id: guestMember.id,
        siteId: guestMember.siteId,
        groupId: guestMember.groupId,
        fullName: guestMember.fullName,
        normalizedName: guestMember.normalizedName,
        rsvpState: guestMember.rsvpState,
        rsvpRevision: guestMember.rsvpRevision,
      })
      .from(guestMember)
      .where(eq(guestMember.siteId, tenant.siteId))
      .orderBy(asc(guestMember.id)),
  ]);
  return {
    tenantIndex: tenant.index,
    siteCount: sites.length,
    groupCount: groups.length,
    guestCount: guests.length,
    siteHash: hashRows(sites),
    groupHash: hashRows(groups),
    guestHash: hashRows(guests),
  };
}

export async function snapshotPlan(
  db: LoadDatabase,
  plan: LoadPlan,
): Promise<TenantSnapshot[]> {
  return Promise.all(plan.tenants.map((tenant) => snapshotTenant(db, tenant)));
}

async function assertNoExistingFixtures(
  db: LoadDatabase,
  plan: LoadPlan,
): Promise<void> {
  const existing = await db
    .select({ id: site.id, repositorySlug: site.repositorySlug })
    .from(site)
    .where(
      inArray(
        site.id,
        plan.tenants.map((tenant) => tenant.siteId),
      ),
    );
  if (existing.length > 0) {
    throw new Error(
      "Load fixture identifier already exists; refusing to overwrite",
    );
  }
}

export async function cleanupLoadFixtures(
  db: LoadDatabase,
  plan: LoadPlan,
): Promise<CleanupEvidence> {
  const siteIds = plan.tenants.map((tenant) => tenant.siteId);
  // Site-scoped lookup events with a null groupId are intentionally not
  // covered by the composite guest-group cascade. Delete them first, using
  // the exact generated site IDs, before deleting the fixture sites.
  await db
    .delete(guestRateLimitEvent)
    .where(inArray(guestRateLimitEvent.siteId, siteIds));
  await db.delete(site).where(inArray(site.id, siteIds));
  const [sites, groups, guests, rateLimitEvents] = await Promise.all([
    db.select({ id: site.id }).from(site).where(inArray(site.id, siteIds)),
    db
      .select({ id: guestGroup.id })
      .from(guestGroup)
      .where(inArray(guestGroup.siteId, siteIds)),
    db
      .select({ id: guestMember.id })
      .from(guestMember)
      .where(inArray(guestMember.siteId, siteIds)),
    db
      .select({ id: guestRateLimitEvent.id })
      .from(guestRateLimitEvent)
      .where(inArray(guestRateLimitEvent.siteId, siteIds)),
  ]);
  const evidence = {
    verified:
      sites.length === 0 &&
      groups.length === 0 &&
      guests.length === 0 &&
      rateLimitEvents.length === 0,
    remainingSites: sites.length,
    remainingGroups: groups.length,
    remainingGuests: guests.length,
    remainingRateLimitEvents: rateLimitEvents.length,
    preexistingOrphanRateLimitEventsRemoved: 0,
  };
  if (!evidence.verified)
    throw new Error("Load fixture cleanup verification failed");
  return evidence;
}

const LOAD_SITE_ID_PATTERN = /^block7-load-[A-Za-z0-9-]{1,40}-site-[0-9]{2}$/;

/** Remove only orphaned rate-limit rows left by this runner's generated site IDs. */
export async function cleanupOrphanedLoadRateLimitEvents(
  db: LoadDatabase,
): Promise<number> {
  const candidates = await db.execute(sql`
    SELECT event.id, event.site_id
    FROM guest_rate_limit_event AS event
    LEFT JOIN site ON site.id = event.site_id
    WHERE site.id IS NULL
      AND event.site_id LIKE ${`${FIXTURE_PREFIX}%`}
  `);
  const orphanIds = candidates.rows
    .filter((row) => {
      const siteId = row.site_id;
      return typeof siteId === "string" && LOAD_SITE_ID_PATTERN.test(siteId);
    })
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");
  if (orphanIds.length === 0) return 0;
  await db
    .delete(guestRateLimitEvent)
    .where(inArray(guestRateLimitEvent.id, orphanIds));
  const remaining = await db
    .select({ id: guestRateLimitEvent.id })
    .from(guestRateLimitEvent)
    .where(inArray(guestRateLimitEvent.id, orphanIds));
  if (remaining.length > 0) {
    throw new Error("Orphaned load rate-limit cleanup verification failed");
  }
  return orphanIds.length;
}

export async function runWithCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await cleanup();
  }
}

export async function finalizeLoadRun(
  cleanup: () => Promise<void>,
  close: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } finally {
    await close();
  }
}

export function percentile(
  values: readonly number[],
  percentileValue: number,
): number {
  if (values.length === 0) return 0;
  if (percentileValue < 0 || percentileValue > 100) {
    throw new Error("Percentile must be between 0 and 100");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(
    0,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[Math.min(rank, sorted.length - 1)] ?? 0;
}

export function summarizeSamples(
  samples: readonly RequestSample[],
): Omit<
  TrafficMeasurement,
  "name" | "mode" | "concurrency" | "requests" | "durationMs"
> {
  const statusCounts: Record<string, number> = {};
  const problemCodes: Record<string, number> = {};
  const latencies: number[] = [];
  let errors = 0;
  let timeouts = 0;
  let rateLimits = 0;
  for (const sample of samples) {
    if (sample.status !== undefined) {
      const key = String(sample.status);
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
      if (sample.status >= 400) errors += 1;
      if (sample.status === 429) rateLimits += 1;
    }
    if (sample.problemCode) {
      problemCodes[sample.problemCode] =
        (problemCodes[sample.problemCode] ?? 0) + 1;
    }
    if (sample.timedOut) {
      timeouts += 1;
      errors += 1;
    } else if (sample.error) {
      errors += 1;
    }
    if (Number.isFinite(sample.latencyMs)) latencies.push(sample.latencyMs);
  }
  return {
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    statusCounts,
    problemCodes,
    errors,
    timeouts,
    rateLimits,
  };
}

function syntheticClientIp(requestIndex: number): string {
  return `198.51.100.${(requestIndex % 5) + 1}`;
}

function requestTarget(
  plan: LoadPlan,
  baseUrl: string,
  requestIndex: number,
): { url: string; init: RequestInit } {
  const tenant = plan.tenants[requestIndex % plan.tenants.length];
  const guest = tenant.guests[requestIndex % tenant.guests.length];
  const headers = {
    Origin: tenant.origin,
    "X-Forwarded-For": syntheticClientIp(requestIndex),
  };
  const route = requestIndex % 10;
  if (route < 3) {
    return { url: `${baseUrl}/v1/health`, init: { headers } };
  }
  if (route < 5) {
    return {
      url: `${baseUrl}/v1/public/sites/${tenant.siteId}/mural`,
      init: { headers },
    };
  }
  return {
    url: `${baseUrl}/v1/public/sites/${tenant.siteId}/guest/challenge`,
    init: {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: guest.fullName,
        phone: guest.phoneE164,
      }),
    },
  };
}

async function performRequest(
  target: { url: string; init: RequestInit },
  timeoutMs: number,
): Promise<RequestSample> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(target.url, {
      ...target.init,
      signal: controller.signal,
    });
    const body = await response.text();
    let problemCode: string | undefined;
    if (response.status >= 400) {
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        if (
          typeof parsed.code === "string" &&
          /^[A-Z0-9_]{2,64}$/.test(parsed.code)
        ) {
          problemCode = parsed.code;
        }
      } catch {
        // Problem bodies are optional; response status remains evidence.
      }
    }
    return {
      latencyMs: performance.now() - started,
      status: response.status,
      timedOut: false,
      problemCode,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      latencyMs: performance.now() - started,
      timedOut,
      error: timedOut
        ? "TIMEOUT"
        : error instanceof Error
          ? error.name
          : "REQUEST_FAILED",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function trafficStage(
  plan: LoadPlan,
  baseUrl: string,
  mode: "steady" | "burst",
  concurrency: number,
  requests: number,
  timeoutMs: number,
): Promise<TrafficMeasurement> {
  const samples: RequestSample[] = [];
  let next = 0;
  const started = performance.now();
  async function worker(): Promise<void> {
    while (true) {
      const requestIndex = next;
      next += 1;
      if (requestIndex >= requests) return;
      samples[requestIndex] = await performRequest(
        requestTarget(plan, baseUrl, requestIndex),
        timeoutMs,
      );
      if (mode === "steady")
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests) }, () => worker()),
  );
  return {
    name: `${mode}-c${concurrency}`,
    mode,
    concurrency,
    requests,
    durationMs: performance.now() - started,
    ...summarizeSamples(samples),
  };
}

export interface LoadRunOptions {
  prefix?: string;
  baseUrl?: string;
  concurrencyLevels?: readonly number[];
  steadyRequestsPerLevel?: number;
  burstRequestsPerLevel?: number;
  timeoutMs?: number;
}

function safeFailure(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      typeof (current as { code?: unknown }).code === "string"
    ) {
      if (
        "constraint" in current &&
        typeof (current as { constraint?: unknown }).constraint === "string"
      ) {
        return `DATABASE_CONSTRAINT_${(current as { constraint: string }).constraint}`;
      }
      return `DATABASE_ERROR_${(current as { code: string }).code}`;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  if (error instanceof Error && /identity mismatch/i.test(error.message)) {
    return "DATABASE_IDENTITY_MISMATCH";
  }
  if (
    error instanceof Error &&
    /Missing required database environment/i.test(error.message)
  ) {
    return "DATABASE_ENVIRONMENT_MISSING";
  }
  return error instanceof Error ? error.name : "LOAD_RUN_FAILED";
}

export async function executeBlock7Load(
  options: LoadRunOptions = {},
): Promise<LoadRunReport> {
  const prefix = options.prefix ?? defaultLoadPrefix();
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const plan = buildLoadPlan(prefix);
  assertLocalBaseUrl(baseUrl);
  const concurrencyLevels =
    options.concurrencyLevels ?? DEFAULT_CONCURRENCY_LEVELS;
  if (
    concurrencyLevels.length < 2 ||
    concurrencyLevels.some((value) => value < 1)
  ) {
    throw new Error("At least two positive concurrency levels are required");
  }
  const steadyRequests = options.steadyRequestsPerLevel ?? 500;
  const burstRequests = options.burstRequestsPerLevel ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (
    ![steadyRequests, burstRequests, timeoutMs].every(Number.isInteger) ||
    steadyRequests < 1 ||
    burstRequests < 1 ||
    timeoutMs < 1
  ) {
    throw new Error("Traffic volumes and timeout must be positive integers");
  }

  const connection = createDatabaseConnection({ target: "test" });
  let verified = false;
  let beforeSeed: TenantSnapshot[] = [];
  let afterSeed: TenantSnapshot[] = [];
  let afterTraffic: TenantSnapshot[] = [];
  let traffic: TrafficMeasurement[] = [];
  let seedDurationMs = 0;
  let cleanup: CleanupEvidence = {
    verified: false,
    remainingSites: 0,
    remainingGroups: 0,
    remainingGuests: 0,
    remainingRateLimitEvents: 0,
    preexistingOrphanRateLimitEventsRemoved: 0,
  };
  let preexistingOrphanRateLimitEventsRemoved = 0;
  try {
    await verifyDatabaseConnection(connection);
    verified = true;
    preexistingOrphanRateLimitEventsRemoved =
      await cleanupOrphanedLoadRateLimitEvents(connection.db);
    await assertNoExistingFixtures(connection.db, plan);
    beforeSeed = await snapshotPlan(connection.db, plan);
    const seedStarted = performance.now();
    await seedLoadFixtures(connection.db, plan);
    seedDurationMs = performance.now() - seedStarted;
    afterSeed = await snapshotPlan(connection.db, plan);
    traffic = [];
    for (const concurrency of concurrencyLevels) {
      traffic.push(
        await trafficStage(
          plan,
          baseUrl,
          "steady",
          concurrency,
          steadyRequests,
          timeoutMs,
        ),
      );
      traffic.push(
        await trafficStage(
          plan,
          baseUrl,
          "burst",
          concurrency,
          burstRequests,
          timeoutMs,
        ),
      );
    }
    afterTraffic = await snapshotPlan(connection.db, plan);
  } finally {
    await finalizeLoadRun(async () => {
      if (verified) {
        cleanup = await cleanupLoadFixtures(connection.db, plan);
        cleanup.preexistingOrphanRateLimitEventsRemoved =
          preexistingOrphanRateLimitEventsRemoved;
      }
    }, connection.close);
  }

  const stableTenantSnapshots = afterSeed.reduce(
    (count, snapshot, index) =>
      count +
      (JSON.stringify(snapshot) === JSON.stringify(afterTraffic[index])
        ? 1
        : 0),
    0,
  );
  if (stableTenantSnapshots !== LOAD_SHAPE.tenantCount) {
    throw new Error("Tenant isolation snapshot changed during traffic");
  }

  return {
    status: "completed",
    generatedAt: new Date().toISOString(),
    databaseTarget: "test",
    httpBaseUrl: baseUrl,
    shape: LOAD_SHAPE,
    resources: {
      runtime: process.version,
      platform: platform(),
      cpuCount: cpus().length,
      memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
    },
    seed: {
      durationMs: seedDurationMs,
      tenants: LOAD_SHAPE.tenantCount,
      groups: LOAD_SHAPE.totalGuests,
      guests: LOAD_SHAPE.totalGuests,
    },
    traffic,
    isolation: {
      beforeSeed: snapshotTotals(beforeSeed),
      afterSeed: snapshotTotals(afterSeed),
      afterTraffic: snapshotTotals(afterTraffic),
      stableTenantSnapshots,
    },
    cleanup,
    limitations: [
      "Admin read traffic was not attempted because no local admin identity or session was established without storing credentials.",
      "Public mural and PIN challenge traffic used configured local routes; no external communication provider belongs to this flow.",
      "This is a load slice, not complete Block 7 contract evidence: RSVP writes, message publication/edit, family-session authentication, and cross-tenant negative requests were not exercised.",
      "The exact requested distribution is 10,000 one-member groups; couple, family, foreign, and other group shapes were not exercised in this load run.",
      "Evidence covers this exact 20-tenant by 500-guest fixture and measured request volumes only; it is not a future capacity guarantee.",
    ],
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

export function renderLoadReport(report: LoadRunReport): string {
  const stages = report.traffic
    .map(
      (stage) =>
        `| ${stage.name} | ${stage.concurrency} | ${stage.requests} | ${formatMs(stage.durationMs)} | ${formatMs(stage.p50Ms)} | ${formatMs(stage.p95Ms)} | ${formatMs(stage.p99Ms)} | ${stage.errors} | ${stage.timeouts} | ${stage.rateLimits} | ${Object.entries(
          stage.statusCounts,
        )
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([status, count]) => `${status}:${count}`)
          .join(", ")} | ${Object.entries(stage.problemCodes)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([code, count]) => `${code}:${count}`)
          .join(", ")} |`,
    )
    .join("\n");
  const aggregate = (value: LoadRunReport["isolation"]["beforeSeed"]) =>
    `${value.tenants} tenants, ${value.groups} groups, ${value.guests} guests (aggregate SHA-256 ${value.aggregateHash})`;
  return `# Block 7 Load Report

Status: completed
Generated: ${report.generatedAt}
Database target: \`test\` only; connection identity was verified before seed.
HTTP target: ${report.httpBaseUrl}

## Environment and resources

- Runtime: ${report.resources.runtime} on ${report.resources.platform}
- CPUs: ${report.resources.cpuCount}; host memory: ${report.resources.memoryGiB} GiB
- API harness: \`APP_ENV=test\` and \`TRUST_PROXY_HEADERS=true\` on the local server only; synthetic loopback origins and client IPs were used for tenant/rate-limit separation
- Fixture marker: unique \`block7-load-*\` QA-owned prefix; \`isDemo=false\`; no demo, legacy, or production identifiers were selected
- Verification boundary: full name and registered phone locate the invitation; the six-digit manual PIN remains the only confirmation mechanism

## Shape and seed

- Exact shape: ${report.shape.tenantCount} active tenants x ${report.shape.guestsPerTenant} guests = ${report.shape.totalGuests} guests
- Seeded rows: ${report.seed.tenants} sites, ${report.seed.groups} guest groups, ${report.seed.guests} guest members
- Guest modeling: 10,000 groups with one member each is intentional, so every synthetic guest has an independent group identity and public lookup/rate-limit scope.
- Group-shape coverage: this run intentionally used 10,000 one-member groups; couple, family, foreign, and other shapes were not exercised.
- Seed duration: ${formatMs(report.seed.durationMs)}

## HTTP stages

Traffic mixed real local routes: 30% \`GET /v1/health\`, 20% public mural reads at \`GET /v1/public/sites/:siteId/mural\`, and 50% public guest challenge starts at \`POST /v1/public/sites/:siteId/guest/challenge\`. Challenge requests intentionally reuse deterministic guests during burst traffic to exercise cooldown/rate-limit behavior. RSVP writes, message writes, and cross-tenant negative requests were not exercised; admin reads were not run because no safe local admin identity/session was available.

| Stage | Concurrency | Requests | Duration | p50 | p95 | p99 | HTTP errors | Timeouts | Rate limits (429) | Statuses | Problem codes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
${stages}

## Isolation evidence

- Before seed: ${aggregate(report.isolation.beforeSeed)}
- After seed baseline: ${aggregate(report.isolation.afterSeed)}
- After HTTP traffic: ${aggregate(report.isolation.afterTraffic)}
- Tenant snapshots unchanged after traffic: ${report.isolation.stableTenantSnapshots}/${report.shape.tenantCount}
- Snapshot hashes cover site identity/publication fields, group identity/phone fields, and guest identity/RSVP fields per tenant. The load runner did not update any fixture rows during HTTP stages.

## Cleanup evidence

- Cleanup ran in \`finally\` after the verified test connection: ${report.cleanup.verified ? "verified" : "not verified"}
- Remaining fixture sites: ${report.cleanup.remainingSites}; groups: ${report.cleanup.remainingGroups}; guests: ${report.cleanup.remainingGuests}
- Remaining fixture guest rate-limit events: ${report.cleanup.remainingRateLimitEvents}
- Pre-existing orphaned runner rate-limit events removed: ${report.cleanup.preexistingOrphanRateLimitEventsRemoved}
- Cleanup scope was the exact generated site IDs, with database cascade for dependent fixture rows. Unrelated rows were not selected.

## Limitations

This is load evidence for the tested slice, not a complete Block 7 contract sign-off.

${report.limitations.map((limitation) => `- ${limitation}`).join("\n")}
`;
}

export async function writeLoadReport(
  report: LoadRunReport,
  reportPath = resolve("docs/block7LoadReport.md"),
): Promise<void> {
  await mkdir(resolve(reportPath, ".."), { recursive: true });
  await writeFile(reportPath, renderLoadReport(report), "utf8");
}

export function loadDatabaseEnvironment(): void {
  const envPath = resolve("packages/database/.env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    if (process.env[name] !== undefined) continue;
    process.env[name] = trimmed.slice(separator + 1).trim();
  }
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseCliOptions(
  args: string[],
): LoadRunOptions & { reportPath?: string } {
  const parseNumber = (name: string): number | undefined => {
    const value = argumentValue(args, name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed))
      throw new Error(`${name} must be an integer`);
    return parsed;
  };
  const concurrency = argumentValue(args, "--concurrency")
    ?.split(",")
    .map(Number);
  if (concurrency?.some((value) => !Number.isInteger(value))) {
    throw new Error("--concurrency values must be integers");
  }
  return {
    prefix: argumentValue(args, "--prefix"),
    baseUrl: argumentValue(args, "--base-url"),
    concurrencyLevels: concurrency,
    steadyRequestsPerLevel: parseNumber("--steady"),
    burstRequestsPerLevel: parseNumber("--burst"),
    timeoutMs: parseNumber("--timeout-ms"),
    reportPath: argumentValue(args, "--report"),
  };
}

if (import.meta.main) {
  loadDatabaseEnvironment();
  const { reportPath, ...options } = parseCliOptions(process.argv.slice(2));
  executeBlock7Load(options)
    .then((report) => writeLoadReport(report, reportPath))
    .then(() => {
      console.log("Block 7 load completed; sanitized report written");
    })
    .catch((error) => {
      console.error(`Failure class: ${safeFailure(error)}`);
      console.error(
        "Block 7 load failed; no unsanitized error details were logged",
      );
      process.exitCode = 1;
    });
}

export { safeFailure };
