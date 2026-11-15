import { createHmac, timingSafeEqual } from "node:crypto";

/** Clock tolerance for event signatures (anti-replay, with idempotency by event id). */
export const SIGNATURE_TOLERANCE_S = 300;

/** Same scheme as the platform: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signEvent(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyEvent(secret: string, body: string, header: string | null, now = Math.floor(Date.now() / 1000)): boolean {
  if (!secret) return false;
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(now - ts) > SIGNATURE_TOLERANCE_S) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"), "hex");
  const got = Buffer.from(m[2]!, "hex");
  return expected.length === got.length && timingSafeEqual(expected, got);
}
