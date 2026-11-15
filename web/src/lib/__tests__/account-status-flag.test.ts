import { afterEach, describe, expect, test } from "vitest";
import { accessBlockReason, isAccessBlocked } from "@/lib/account-status";

const admin = { role: "admin", professional: null, disabledAt: null, tenant: { status: "suspended" } };

describe("account status x GP_PLATFORM_ENABLED", () => {
  afterEach(() => {
    delete process.env.GP_PLATFORM_ENABLED;
  });

  test("flag off: suspended barbershop keeps the legacy behavior (not blocked)", () => {
    expect(isAccessBlocked(admin)).toBe(false);
    expect(accessBlockReason(admin)).toBeNull();
  });

  test("flag on: suspended barbershop is blocked", () => {
    process.env.GP_PLATFORM_ENABLED = "true";
    expect(accessBlockReason(admin)).toBe("TENANT_SUSPENDED");
  });
});
