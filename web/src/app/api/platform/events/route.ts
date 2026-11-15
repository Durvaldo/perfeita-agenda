import { NextResponse } from "next/server";
import { platformEnabled, webhookSecret } from "@/server/platform/config";
import { type PlatformEvent, processPlatformEvent } from "@/server/platform/events";
import { verifyEvent } from "@/server/platform/signature";

export const dynamic = "force-dynamic";

/**
 * Receives Gestão Perfeita platform events (contract v1). Disabled (404) unless
 * GP_PLATFORM_ENABLED=true. Every request must carry a valid, fresh HMAC signature.
 */
export async function POST(request: Request): Promise<Response> {
  if (!platformEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const body = await request.text();
  if (!verifyEvent(webhookSecret(), body, request.headers.get("x-gp-signature"))) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  let event: PlatformEvent;
  try {
    event = JSON.parse(body) as PlatformEvent;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!event?.id || !event.type || !event.organization_id) {
    return NextResponse.json({ error: "invalid_event" }, { status: 422 });
  }
  const result = await processPlatformEvent(event);
  return NextResponse.json(result.body, { status: result.status });
}
