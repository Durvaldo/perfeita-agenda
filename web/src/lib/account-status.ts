import { unscopedDb } from "@/lib/db";
import { platformEnabled } from "@/server/platform/config";

/** Better Auth error code returned when a deactivated account tries to sign in. */
export const ACCOUNT_DISABLED = "ACCOUNT_DISABLED";
/** Better Auth error code returned when the barbershop is suspended. */
export const TENANT_SUSPENDED = "TENANT_SUSPENDED";

type AccessFields = {
  role: string;
  professional: { active: boolean } | null;
  /** Revoked/suspended by the Gestão Perfeita platform (TASK-0044). */
  disabledAt?: Date | null;
  tenant?: { status: string } | null;
};

/**
 * Whether a user's access is blocked:
 * - a professional whose professional record is deactivated (ADR-0008);
 * - a user disabled by the platform (`disabledAt`, ADR-0017);
 * - a user of a suspended barbershop (`Tenant.status = suspended`, ADR-0017) — ONLY with
 *   GP_PLATFORM_ENABLED, so turning the flag off keeps the legacy behavior exactly.
 */
export function isAccessBlocked(user: AccessFields): boolean {
  if (user.disabledAt) return true;
  if (platformEnabled() && user.tenant?.status === "suspended") return true;
  return user.role === "professional" && user.professional !== null && !user.professional.active;
}

/** Why access is blocked (sign-in error code), or null when it is not. */
export function accessBlockReason(user: AccessFields): typeof ACCOUNT_DISABLED | typeof TENANT_SUSPENDED | null {
  if (!isAccessBlocked(user)) return null;
  return platformEnabled() && user.tenant?.status === "suspended" && !user.disabledAt ? TENANT_SUSPENDED : ACCOUNT_DISABLED;
}

const accessSelect = {
  role: true,
  disabledAt: true,
  professional: { select: { active: true } },
  tenant: { select: { status: true } },
} as const;

/** Loads the user (outside any tenant context, as auth runs before one exists) and checks access. */
export async function userAccessBlockReason(userId: number) {
  const user = await unscopedDb.user.findUnique({ where: { id: userId }, select: accessSelect });
  return user === null ? null : accessBlockReason(user);
}

export async function isUserAccessBlocked(userId: number): Promise<boolean> {
  return (await userAccessBlockReason(userId)) !== null;
}
