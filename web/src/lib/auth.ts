import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins";
import { userAccessBlockReason } from "@/lib/account-status";
import { unscopedDb } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { PLATFORM_PROVIDER_ID, platformEnabled, platformUrl } from "@/server/platform/config";
import { platformLoginDecision } from "@/server/platform/login";

// Sign-in with the Gestão Perfeita central issuer (OIDC, ADR-0017). Only when
// GP_PLATFORM_ENABLED=true; e-mail/password stays available as fallback.
const platformPlugins = platformEnabled()
  ? [
      genericOAuth({
        config: [
          {
            providerId: PLATFORM_PROVIDER_ID,
            discoveryUrl: `${platformUrl()}/api/auth/.well-known/openid-configuration`,
            clientId: process.env.GP_OIDC_CLIENT_ID ?? "",
            clientSecret: process.env.GP_OIDC_CLIENT_SECRET ?? "",
            scopes: ["openid", "profile", "email"],
            pkce: true,
            // Accounts are pre-linked by sub (platform events); never create users or link by e-mail here.
            disableSignUp: true,
            disableImplicitSignUp: true,
          },
        ],
      }),
    ]
  : [];

// Authentication (ADR-0004). Reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from the environment.
export const auth = betterAuth({
  database: prismaAdapter(unscopedDb, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    // No public sign-up: tenants and users are created by the seed or by
    // app code (ADR-0004). Self-service onboarding is a separate, later task.
    disableSignUp: true,
    password: {
      // bcrypt, compatible with the hashes written by the seed (src/lib/password.ts).
      hash: hashPassword,
      verify: ({ hash, password }) => verifyPassword(password, hash),
    },
  },
  user: {
    additionalFields: {
      role: { type: "string", required: false, input: false },
      tenantId: { type: "number", required: false, input: false },
    },
  },
  advanced: {
    // Our tables use serial integer ids.
    database: { generateId: "serial" },
  },
  databaseHooks: {
    session: {
      create: {
        // Deactivated professionals cannot sign in (ADR-0008).
        // Suspended barbershops and platform-disabled users too (ADR-0017).
        before: async (session) => {
          const blocked = await userAccessBlockReason(Number(session.userId));
          if (blocked) {
            throw new APIError("FORBIDDEN", { code: blocked, message: "Access blocked" });
          }
          // Platform-linked users need a live grant on the platform (fails closed).
          const denied = await platformLoginDecision(Number(session.userId));
          if (denied) {
            throw new APIError("FORBIDDEN", { code: denied, message: "Platform access denied" });
          }
        },
      },
    },
  },
  rateLimit: {
    // Same limit as the legacy Laravel login (5 attempts per minute). Better Auth
    // only enforces rate limits in production by default.
    customRules: { "/sign-in/email": { window: 60, max: 5 } },
  },
  // Must be the last plugin: lets Server Actions set the session cookie.
  account: { accountLinking: { enabled: false } },
  plugins: [...platformPlugins, nextCookies()],
});
