import { platformApiKey, platformUrl } from "./config";

export type AccessDecision =
  | { allowed: true; module_role: string | null }
  | { allowed: false; reason: string };

async function post(path: string, body: unknown, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(`${platformUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${platformApiKey()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

/**
 * Asks the platform whether this user may use the Agenda in this barbershop.
 * Fails closed: any network/HTTP error is reported as "unavailable" and the caller denies.
 */
export async function checkPlatformAccess(
  platformUserId: string,
  tenantId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessDecision | { allowed: false; reason: "unavailable" }> {
  try {
    const res = await post("/api/v1/integration/access-check", { user_id: platformUserId, external_tenant_id: String(tenantId) }, fetchImpl);
    if (!res.ok) return { allowed: false, reason: "unavailable" };
    const json = (await res.json()) as { allowed?: boolean; reason?: string; module_role?: string | null };
    return json.allowed === true ? { allowed: true, module_role: json.module_role ?? null } : { allowed: false, reason: json.reason ?? "denied" };
  } catch {
    return { allowed: false, reason: "unavailable" };
  }
}

/** Best effort: tells the platform our local id of a central user. Errors are swallowed. */
export async function reportUserMapping(platformUserId: string, localUserId: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!platformUrl() || !platformApiKey()) return;
  try {
    await post("/api/v1/integration/mappings", { user_id: platformUserId, external_user_id: String(localUserId) }, fetchImpl);
  } catch {
    // reconciliation (organization.sync) will retry implicitly
  }
}
