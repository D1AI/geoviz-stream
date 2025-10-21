import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_TARGET = "http://localhost:12347/collect";
const TARGET_URL = process.env.FARO_FORWARD_URL ?? DEFAULT_TARGET;

const FORWARDED_HEADERS = ["content-type", "x-faro-session-id", "x-api-key"];

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!TARGET_URL) {
    return NextResponse.json(
      { error: "Faro forward URL not configured" },
      { status: 500, headers: corsHeaders() },
    );
  }

  const body = await request.text();

  const headers = new Headers();
  for (const header of FORWARDED_HEADERS) {
    const value = request.headers.get(header);
    if (value) {
      headers.set(header, value);
    }
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(TARGET_URL, {
      method: "POST",
      headers,
      body,
      keepalive: body.length <= 60_000,
    });
  } catch (error) {
    console.error("[faro-proxy] Error forwarding payload", error);
    return NextResponse.json(
      { error: "Failed to reach Faro backend" },
      { status: 502, headers: corsHeaders() },
    );
  }

  const responseBody = await upstreamResponse.text();
  const responseHeaders = corsHeaders(upstreamResponse);

  return new NextResponse(responseBody || null, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

function corsHeaders(upstream?: Response): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "content-type, x-faro-session-id, x-api-key");
  headers.set("Access-Control-Max-Age", "600");

  if (upstream) {
    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      headers.set("Content-Type", contentType);
    }
  }

  return headers;
}
