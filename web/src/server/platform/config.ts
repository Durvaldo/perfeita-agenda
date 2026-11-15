// Gestão Perfeita platform integration settings (TASK-0044, ADR-0017).
// Everything is off unless GP_PLATFORM_ENABLED=true: current logins and tenants
// keep working exactly as before.

export const PLATFORM_PROVIDER_ID = "gestaoperfeita";

export function platformEnabled(): boolean {
  return process.env.GP_PLATFORM_ENABLED === "true";
}

export function platformUrl(): string {
  return (process.env.GP_PLATFORM_URL ?? "").replace(/\/+$/, "");
}

export function platformApiKey(): string {
  return process.env.GP_API_KEY ?? "";
}

export function webhookSecret(): string {
  return process.env.GP_WEBHOOK_SECRET ?? "";
}
