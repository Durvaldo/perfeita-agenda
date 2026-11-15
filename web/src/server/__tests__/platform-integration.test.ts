// @vitest-environment node
// Gestão Perfeita platform integration (TASK-0044, ADR-0017): signed events,
// idempotency, provisioning, legacy adoption, conflicts, revocation, suspension and login gate.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { unscopedDb as db } from "@/lib/db";
import { POST as eventsRoute } from "@/app/api/platform/events/route";
import { GET as customersRoute } from "@/app/api/customers/route";
import { signEvent, verifyEvent } from "@/server/platform/signature";
import { platformLoginDecision } from "@/server/platform/login";
import { PLATFORM_PROVIDER_ID } from "@/server/platform/config";
import { seed } from "../../../prisma/seed-data";
import { truncateAll } from "../../../tests/db";
import { call, loginCookie } from "../../../tests/api";

const SECRET = "test-webhook-secret";
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

function envelope(type: string, organizationId: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: randomUUID(), type, version: 1, occurred_at: new Date().toISOString(), organization_id: organizationId, module_code: "agenda", external_tenant_id: null, data, ...extra };
}

async function send(ev: object, opts: { secret?: string; timestamp?: number } = {}) {
  const body = JSON.stringify(ev);
  const res = await eventsRoute(
    new Request("http://localhost:3001/api/platform/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gp-signature": signEvent(opts.secret ?? SECRET, body, opts.timestamp) },
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const grant = (org: string, userId: string, email: string, enabled = true, role = "professional") =>
  envelope("member_module_grant.changed", org, { organization_id: org, user_id: userId, email, name: email.split("@")[0], module_code: "agenda", enabled, module_role: role });

describe("platform integration", () => {
  beforeAll(async () => {
    process.env.GP_WEBHOOK_SECRET = SECRET;
    process.env.GP_PLATFORM_ENABLED = "true";
    process.env.GP_PLATFORM_URL = "http://platform.test";
    process.env.GP_API_KEY = "gpm_test.key";
  });
  beforeEach(async () => {
    await truncateAll();
    await seed(db);
    process.env.GP_PLATFORM_ENABLED = "true";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  afterAll(async () => {
    delete process.env.GP_PLATFORM_ENABLED;
    await db.$disconnect();
  });
  const realFetch = globalThis.fetch;
  // The mapping report is best effort; keep tests offline.
  const offline = () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  };

  test("route is off without the flag; bad or stale signatures are rejected", async () => {
    process.env.GP_PLATFORM_ENABLED = "false";
    expect((await send(envelope("entitlement.activated", ORG_A, {}))).status).toBe(404);
    process.env.GP_PLATFORM_ENABLED = "true";
    expect((await send(envelope("entitlement.activated", ORG_A, {}), { secret: "wrong" })).status).toBe(401);
    expect((await send(envelope("entitlement.activated", ORG_A, {}), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect(verifyEvent("", "x", signEvent("", "x"))).toBe(false); // no secret configured → never valid
    expect(await db.platformTenantMapping.count()).toBe(0);
  });

  test("provisions a barbershop only on entitlement.activated, once (replay is a no-op)", async () => {
    const tenantsBefore = await db.tenant.count();
    await send(envelope("member.invited", ORG_A, { organization_id: ORG_A }));
    expect(await db.tenant.count()).toBe(tenantsBefore);

    const ev = envelope("entitlement.activated", ORG_A, { organization_id: ORG_A, status: "active", name: "Barbearia Alfa" });
    const first = await send(ev);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ external_tenant_id: expect.any(String), status: "active" });
    const again = await send(ev);
    expect(again.body).toEqual(first.body);
    // a different event for the same org does not duplicate either
    await send(envelope("entitlement.activated", ORG_A, { organization_id: ORG_A, status: "active" }));
    expect(await db.tenant.count()).toBe(tenantsBefore + 1);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: Number(first.body.external_tenant_id) } });
    expect(tenant).toMatchObject({ name: "Barbearia Alfa", status: "active" });
  });

  test("organization.sync adopts a legacy barbershop without duplicating and converges members", async () => {
    offline();
    const legacy = await db.tenant.findUniqueOrThrow({ where: { slug: "barbearia-centro" } });
    const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@barbearia-centro.com" } });
    const tenantsBefore = await db.tenant.count();
    const zonaSulBefore = await db.tenant.findUniqueOrThrow({ where: { slug: "barbearia-zona-sul" } });
    const platformAdminId = randomUUID();
    const res = await send(
      envelope(
        "organization.sync",
        ORG_A,
        { organization_id: ORG_A, name: "Barbearia Centro", organization_status: "active", entitlement: { status: "active" }, members: [{ user_id: platformAdminId, email: "ADMIN@barbearia-centro.com", name: "Admin", module_role: "admin", membership_status: "active" }] },
        { external_tenant_id: String(legacy.id) },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.external_tenant_id).toBe(String(legacy.id));
    expect(await db.tenant.count()).toBe(tenantsBefore);
    // existing local user of THAT tenant is linked (not duplicated), keeps its password login
    const mapping = await db.platformUserMapping.findUniqueOrThrow({ where: { platformUserId: platformAdminId } });
    expect(mapping.userId).toBe(admin.id);
    expect(await db.account.count({ where: { userId: admin.id, providerId: "credential" } })).toBe(1);
    expect(await db.account.count({ where: { userId: admin.id, providerId: PLATFORM_PROVIDER_ID, accountId: platformAdminId } })).toBe(1);
    // the other barbershop is untouched
    expect((await db.tenant.findUniqueOrThrow({ where: { slug: "barbearia-zona-sul" } })).status).toBe(zonaSulBefore.status);

    // a second organization cannot adopt the same tenant
    const steal = await send(envelope("organization.sync", ORG_B, { organization_status: "active", entitlement: { status: "active" }, members: [] }, { external_tenant_id: String(legacy.id) }));
    expect(steal.status).toBe(409);
  });

  test("same e-mail in another barbershop is a 409 conflict and nothing moves; two tenants stay separate", async () => {
    offline();
    const a = await send(envelope("entitlement.activated", ORG_A, { name: "Alfa" }));
    await send(envelope("entitlement.activated", ORG_B, { name: "Beta" }));
    const carlos = await db.user.findUniqueOrThrow({ where: { email: "carlos@barbearia-centro.com" } });

    const res = await send(grant(ORG_A, randomUUID(), "carlos@barbearia-centro.com"));
    expect(res.status).toBe(409);
    expect((await db.user.findUniqueOrThrow({ where: { id: carlos.id } })).tenantId).toBe(carlos.tenantId);
    expect(await db.platformUserMapping.count()).toBe(0);

    const ana = randomUUID();
    expect((await send(grant(ORG_A, ana, "ana@alfa.exemplo"))).status).toBe(200);
    const local = await db.user.findUniqueOrThrow({ where: { email: "ana@alfa.exemplo" }, include: { professional: true, accounts: true } });
    expect(local.tenantId).toBe(Number(a.body.external_tenant_id));
    expect(local.professional?.tenantId).toBe(local.tenantId);
    expect(local.accounts.map((x) => x.providerId)).toEqual([PLATFORM_PROVIDER_ID]); // no password
    // the same platform user granted in Beta cannot be moved there
    expect((await send(grant(ORG_B, ana, "ana@alfa.exemplo"))).status).toBe(409);
    expect((await db.user.findUniqueOrThrow({ where: { id: local.id } })).tenantId).toBe(local.tenantId);
  });

  test("revoking deactivates the user, kills sessions and blocks the API, keeping history", async () => {
    offline();
    const legacy = await db.tenant.findUniqueOrThrow({ where: { slug: "barbearia-centro" } });
    const rafael = await db.user.findUniqueOrThrow({ where: { email: "rafael@barbearia-centro.com" } });
    const pid = randomUUID();
    await send(envelope("organization.sync", ORG_A, { organization_status: "active", entitlement: { status: "active" }, members: [{ user_id: pid, email: rafael.email, name: rafael.name, module_role: "professional", membership_status: "active" }] }, { external_tenant_id: String(legacy.id) }));

    process.env.GP_PLATFORM_ENABLED = "false"; // password login without the platform gate for this step
    const cookie = await loginCookie(rafael.email);
    expect((await call(customersRoute, { cookie })).status).toBe(200);
    process.env.GP_PLATFORM_ENABLED = "true";
    const appointmentsBefore = await db.appointment.count({ where: { professional: { userId: rafael.id } } });

    await send(grant(ORG_A, pid, rafael.email, false));
    expect((await db.user.findUniqueOrThrow({ where: { id: rafael.id } })).disabledAt).not.toBeNull();
    expect(await db.session.count({ where: { userId: rafael.id } })).toBe(0);
    expect((await call(customersRoute, { cookie })).status).toBe(401);
    expect(await db.appointment.count({ where: { professional: { userId: rafael.id } } })).toBe(appointmentsBefore);
    await expect(loginCookie(rafael.email)).rejects.toThrow();

    // granting again restores access
    await send(grant(ORG_A, pid, rafael.email, true));
    expect((await db.user.findUniqueOrThrow({ where: { id: rafael.id } })).disabledAt).toBeNull();
  });

  test("suspended barbershop is blocked; resuming the company does not resume a suspended Agenda", async () => {
    offline();
    const legacy = await db.tenant.findUniqueOrThrow({ where: { slug: "barbearia-centro" } });
    await send(envelope("organization.sync", ORG_A, { organization_status: "active", entitlement: { status: "active" }, members: [] }, { external_tenant_id: String(legacy.id) }));
    process.env.GP_PLATFORM_ENABLED = "false";
    const cookie = await loginCookie("admin@barbearia-centro.com");
    process.env.GP_PLATFORM_ENABLED = "true";

    await send(envelope("entitlement.suspended", ORG_A, { status: "suspended" }));
    expect((await db.tenant.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe("suspended");
    expect((await call(customersRoute, { cookie })).status).toBe(401);
    await expect(loginCookie("admin@barbearia-centro.com")).rejects.toThrow();
    // the other barbershop keeps working
    expect((await call(customersRoute, { cookie: await loginCookie("admin@barbearia-zona-sul.com") })).status).toBe(200);

    await send(envelope("organization.suspended", ORG_A, { status: "suspended" }));
    await send(envelope("organization.activated", ORG_A, { status: "active" }));
    expect((await db.tenant.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe("suspended");
    await send(envelope("entitlement.activated", ORG_A, { status: "active" }));
    expect((await db.tenant.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe("active");
    expect((await call(customersRoute, { cookie: await loginCookie("admin@barbearia-centro.com") })).status).toBe(200);
  });

  test("login gate: platform-linked users need a live grant; fails closed; legacy users unaffected", async () => {
    offline();
    const legacy = await db.tenant.findUniqueOrThrow({ where: { slug: "barbearia-centro" } });
    const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@barbearia-centro.com" } });
    const pid = randomUUID();
    await send(envelope("organization.sync", ORG_A, { organization_status: "active", entitlement: { status: "active" }, members: [{ user_id: pid, email: admin.email, name: "Admin", module_role: "admin", membership_status: "active" }] }, { external_tenant_id: String(legacy.id) }));

    const seen: unknown[] = [];
    const platform = (allowed: boolean, status = 200): typeof fetch =>
      (async (_url: unknown, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)));
        return Response.json(allowed ? { allowed: true, module_role: "admin" } : { allowed: false, reason: "no_grant" }, { status });
      }) as typeof fetch;

    expect(await platformLoginDecision(admin.id, platform(true))).toBeNull();
    expect(seen[0]).toEqual({ user_id: pid, external_tenant_id: String(legacy.id) });
    expect(await platformLoginDecision(admin.id, platform(false))).toBe("PLATFORM_ACCESS_DENIED");
    expect(await platformLoginDecision(admin.id, platform(true, 503))).toBe("PLATFORM_UNAVAILABLE");
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await platformLoginDecision(admin.id, down)).toBe("PLATFORM_UNAVAILABLE");

    // not linked → legacy behaviour; flag off → no gate at all
    const other = await db.user.findUniqueOrThrow({ where: { email: "admin@barbearia-zona-sul.com" } });
    expect(await platformLoginDecision(other.id, down)).toBeNull();
    process.env.GP_PLATFORM_ENABLED = "false";
    expect(await platformLoginDecision(admin.id, down)).toBeNull();
  });
});
