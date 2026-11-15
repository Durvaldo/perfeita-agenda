import { unscopedDb as db } from "@/lib/db";
import { reportUserMapping } from "./client";
import { PLATFORM_PROVIDER_ID } from "./config";

// Applies Gestão Perfeita platform events to the Agenda (contract v1,
// gestaoperfeita-platform docs/integrations/README.md). Cross-tenant by nature:
// uses unscopedDb and resolves the tenant ONLY through PlatformTenantMapping.

export type PlatformEvent = {
  id: string;
  type: string;
  version: number;
  organization_id: string;
  module_code: string;
  external_tenant_id: string | null;
  data: Record<string, unknown>;
};

export type EventResult = { status: number; body: Record<string, unknown> };

export class ConflictError extends Error {}

const LOCAL_ROLES = new Set(["admin", "professional"]);

function slugBase(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "barbearia";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugBase(name);
  for (let i = 0; ; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await db.tenant.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
}

async function defaultPlanId(): Promise<number> {
  const fromEnv = Number(process.env.GP_DEFAULT_PLAN_ID);
  if (fromEnv) return fromEnv;
  const plan = await db.plan.findFirst({ orderBy: { id: "asc" }, select: { id: true } });
  if (!plan) throw new Error("Nenhum plano cadastrado para novas barbearias (GP_DEFAULT_PLAN_ID)");
  return plan.id;
}

async function mappingFor(organizationId: string) {
  return db.platformTenantMapping.findUnique({ where: { organizationId } });
}

/** Provisions (or finds) the barbershop of a platform organization. */
async function ensureTenant(ev: PlatformEvent, name: string) {
  const existing = await mappingFor(ev.organization_id);
  if (existing) return existing;
  // Legacy adoption: the platform already knows our tenant id (organization.sync / reconciliation).
  if (ev.external_tenant_id) {
    const tenantId = Number(ev.external_tenant_id);
    const tenant = Number.isInteger(tenantId) ? await db.tenant.findUnique({ where: { id: tenantId } }) : null;
    if (!tenant) throw new ConflictError(`Tenant ${ev.external_tenant_id} não existe na Agenda`);
    const taken = await db.platformTenantMapping.findUnique({ where: { tenantId } });
    if (taken) throw new ConflictError(`Tenant ${tenantId} já está vinculado a outra organização`);
    return db.platformTenantMapping.create({ data: { organizationId: ev.organization_id, tenantId, status: "active" } });
  }
  const tenant = await db.tenant.create({
    data: { name, slug: await uniqueSlug(name), planId: await defaultPlanId(), status: "active" },
  });
  return db.platformTenantMapping.create({ data: { organizationId: ev.organization_id, tenantId: tenant.id, status: "active" } });
}

type Status = "active" | "suspended";

/**
 * Tracks the Agenda entitlement and the organization state separately: the tenant is
 * active only when BOTH are active (resuming the company must not resume a suspended Agenda).
 */
async function setTenantStatus(organizationId: string, change: { entitlement?: Status; organization?: Status }) {
  const m = await mappingFor(organizationId);
  if (!m) return null; // never provisioned here: nothing to change
  const status = change.entitlement ?? (m.status as Status);
  const organizationStatus = change.organization ?? (m.organizationStatus as Status);
  const effective: Status = status === "active" && organizationStatus === "active" ? "active" : "suspended";
  await db.$transaction([
    db.platformTenantMapping.update({ where: { id: m.id }, data: { status, organizationStatus } }),
    db.tenant.update({ where: { id: m.tenantId }, data: { status: effective } }),
  ]);
  return m;
}

/** Disables a local user and kills their sessions. History (appointments, orders) is untouched. */
async function disableUser(userId: number) {
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { disabledAt: new Date() } }),
    db.session.deleteMany({ where: { userId } }),
  ]);
}

type Member = { userId: string; email: string; name: string; role: string | null; enabled: boolean };

/**
 * Grants/revokes a platform user in a barbershop.
 * - mapped by platform user id (`sub`), never by e-mail alone;
 * - an unmapped e-mail already used in ANOTHER tenant is a conflict (1 user = 1 tenant today);
 * - new users have no password: they sign in through the platform (OIDC).
 */
async function applyMember(tenantId: number, m: Member) {
  const mapping = await db.platformUserMapping.findUnique({ where: { platformUserId: m.userId } });
  if (!m.enabled) {
    if (mapping) await disableUser(mapping.userId);
    return null;
  }
  const role = m.role && LOCAL_ROLES.has(m.role) ? (m.role as "admin" | "professional") : "professional";

  let localUserId: number;
  if (mapping) {
    const user = await db.user.findUniqueOrThrow({ where: { id: mapping.userId } });
    if (user.tenantId !== tenantId) throw new ConflictError("Usuário já vinculado a outra barbearia");
    await db.user.update({ where: { id: user.id }, data: { role, disabledAt: null, name: m.name || user.name } });
    localUserId = user.id;
  } else {
    const email = m.email.trim().toLowerCase();
    const byEmail = await db.user.findUnique({ where: { email } });
    if (byEmail && byEmail.tenantId !== tenantId) {
      throw new ConflictError("E-mail já usado por um usuário de outra barbearia na Agenda");
    }
    if (byEmail && (await db.platformUserMapping.findUnique({ where: { userId: byEmail.id } }))) {
      throw new ConflictError("Usuário local já vinculado a outra identidade da plataforma");
    }
    const user = byEmail
      ? await db.user.update({ where: { id: byEmail.id }, data: { role, disabledAt: null } })
      : await db.user.create({ data: { email, name: m.name || email, tenantId, role, emailVerified: true } });
    await db.platformUserMapping.create({ data: { platformUserId: m.userId, userId: user.id } });
    // Lets Better Auth find this user by the OIDC `sub` (no e-mail-based linking).
    await db.account.upsert({
      where: { providerId_accountId: { providerId: PLATFORM_PROVIDER_ID, accountId: m.userId } },
      update: { userId: user.id },
      create: { providerId: PLATFORM_PROVIDER_ID, accountId: m.userId, userId: user.id },
    });
    localUserId = user.id;
    await reportUserMapping(m.userId, user.id);
  }

  if (role === "professional") {
    await db.professional.upsert({
      where: { userId: localUserId },
      update: { active: true },
      create: { userId: localUserId, tenantId },
    });
  }
  return localUserId;
}

function reply(m: { tenantId: number; status: string; organizationStatus: string } | null): EventResult {
  const active = m?.status === "active" && m.organizationStatus === "active";
  return { status: 200, body: m ? { external_tenant_id: String(m.tenantId), status: active ? "active" : "suspended" } : {} };
}

async function handle(ev: PlatformEvent): Promise<EventResult> {
  const d = ev.data;
  switch (ev.type) {
    case "entitlement.activated": {
      await ensureTenant(ev, String(d.name ?? "Barbearia"));
      await setTenantStatus(ev.organization_id, { entitlement: "active" });
      return reply(await mappingFor(ev.organization_id));
    }
    case "entitlement.changed":
      return reply(await mappingFor(ev.organization_id));
    case "entitlement.suspended":
      await setTenantStatus(ev.organization_id, { entitlement: "suspended" });
      return reply(await mappingFor(ev.organization_id));
    case "organization.suspended":
      await setTenantStatus(ev.organization_id, { organization: "suspended" });
      return reply(await mappingFor(ev.organization_id));
    case "organization.activated": {
      await setTenantStatus(ev.organization_id, { organization: "active" });
      return reply(await mappingFor(ev.organization_id));
    }
    case "organization.updated": {
      const m = await mappingFor(ev.organization_id);
      if (m && typeof d.name === "string") await db.tenant.update({ where: { id: m.tenantId }, data: { name: d.name } });
      return reply(m);
    }
    case "member_module_grant.changed": {
      const m = await mappingFor(ev.organization_id);
      if (!m) throw new ConflictError("Barbearia ainda não provisionada para esta organização");
      await applyMember(m.tenantId, {
        userId: String(d.user_id),
        email: String(d.email ?? ""),
        name: String(d.name ?? ""),
        role: (d.module_role as string | null) ?? null,
        enabled: Boolean(d.enabled),
      });
      return reply(m);
    }
    case "member.revoked":
    case "member.suspended": {
      const mapping = await db.platformUserMapping.findUnique({ where: { platformUserId: String(d.user_id) } });
      const m = await mappingFor(ev.organization_id);
      if (mapping && m) {
        const user = await db.user.findUnique({ where: { id: mapping.userId }, select: { tenantId: true } });
        if (user?.tenantId === m.tenantId) await disableUser(mapping.userId);
      }
      return reply(m);
    }
    case "organization.sync": {
      const ent = d.entitlement as { status: string } | null;
      const m = await ensureTenant(ev, String(d.name ?? "Barbearia"));
      await setTenantStatus(ev.organization_id, {
        entitlement: !!ent && ["active", "trial"].includes(ent.status) ? "active" : "suspended",
        organization: d.organization_status === "active" ? "active" : "suspended",
      });
      const members = (d.members as { user_id: string; email: string; name: string; module_role: string | null; membership_status: string }[]) ?? [];
      const desired = new Set(members.map((x) => x.user_id));
      for (const x of members) {
        await applyMember(m.tenantId, { userId: x.user_id, email: x.email, name: x.name, role: x.module_role, enabled: x.membership_status === "active" });
      }
      // Platform-linked users of this tenant no longer in the desired set lose access.
      const linked = await db.platformUserMapping.findMany({ where: { platformUserId: { notIn: [...desired] } } });
      for (const l of linked) {
        const u = await db.user.findUnique({ where: { id: l.userId }, select: { tenantId: true, disabledAt: true } });
        if (u?.tenantId === m.tenantId && !u.disabledAt) await disableUser(l.userId);
      }
      return reply(await mappingFor(ev.organization_id));
    }
    default:
      // member.invited, member.active, unknown future types: acknowledged, nothing to do.
      return reply(await mappingFor(ev.organization_id));
  }
}

/** Idempotent entry point: an event id is applied at most once. */
export async function processPlatformEvent(ev: PlatformEvent): Promise<EventResult> {
  if (ev.module_code !== "agenda" || ev.version !== 1) {
    return { status: 422, body: { error: "unsupported_event" } };
  }
  if (await db.platformProcessedEvent.findUnique({ where: { eventId: ev.id } })) {
    return reply(await mappingFor(ev.organization_id));
  }
  try {
    const result = await handle(ev);
    await db.platformProcessedEvent.create({ data: { eventId: ev.id, type: ev.type } }).catch(() => undefined);
    return result;
  } catch (error) {
    if (error instanceof ConflictError) {
      console.warn(JSON.stringify({ msg: "platform.event_conflict", event_id: ev.id, type: ev.type, error: error.message }));
      return { status: 409, body: { error: "conflict", message: error.message } };
    }
    throw error;
  }
}
