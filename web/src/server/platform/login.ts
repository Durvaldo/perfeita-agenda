import { unscopedDb as db } from "@/lib/db";
import { checkPlatformAccess } from "./client";
import { platformEnabled } from "./config";

export const PLATFORM_ACCESS_DENIED = "PLATFORM_ACCESS_DENIED";
export const PLATFORM_UNAVAILABLE = "PLATFORM_UNAVAILABLE";

/**
 * Login gate for users linked to the platform (any sign-in method, OIDC or password):
 * the platform is the source of truth of who may use the Agenda (ADR-0017).
 * Returns null to allow, or the error code to deny. Fails closed when the platform
 * cannot be reached. Users NOT linked to the platform are unaffected (legacy path).
 */
export async function platformLoginDecision(userId: number, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!platformEnabled()) return null;
  const mapping = await db.platformUserMapping.findUnique({ where: { userId } });
  if (!mapping) return null;
  const user = await db.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!user?.tenantId) return PLATFORM_ACCESS_DENIED;
  const decision = await checkPlatformAccess(mapping.platformUserId, user.tenantId, fetchImpl);
  if (decision.allowed) return null;
  return decision.reason === "unavailable" ? PLATFORM_UNAVAILABLE : PLATFORM_ACCESS_DENIED;
}
