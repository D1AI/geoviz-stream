// we use a route.ts Route Handler to proxy traffic from the private K8s service to the public internet
// this way, we can continue to listen to WS-type traffic from the server without exposing the WS API
import { NextRequest } from "next/server";
import WebSocket from "ws";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const bbox = searchParams.get("bbox");
    const lookback = searchParams.get("lookback_min");

    if (!bbox) {
        return new Response(JSON.stringify({ error: "bbox query param is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const upstream = new URL(process.env.WS_API_INTERNAL_HOST || "ws://localhost:8000/ws");
    upstream.searchParams.set("bbox", bbox);
    if (lookback) upstream.searchParams.set("lookback_min", lookback);

    let ws: WebSocket | null = null;
    let ping: NodeJS.Timeout | null = null;
    let closed = false;

    const stream = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();

            const cleanup = () => {
                if (closed) return;
                closed = true;
                if (ping) {
                    clearInterval(ping);
                    ping = null;
                }
                try {
                    ws?.close();
                } catch {
                    // ignore
                }
                try {
                    controller.close();
                } catch {
                    // already closed
                }
            };

            const safeEnqueue = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    cleanup();
                }
            };

            const sendData = (payload: unknown) => {
                const body = typeof payload === "string" ? payload : JSON.stringify(payload);
                safeEnqueue(`data: ${body}\n\n`);
            };

            const sendComment = (text: string) => {
                safeEnqueue(`: ${text}\n\n`);
            };

            ws = new WebSocket(upstream.toString());

            ws.on("open", () => {
                ping = setInterval(() => sendComment("ping"), 15000);
            });

            ws.on("message", (buf) => {
                if (closed) return;
                sendData(buf.toString());
            });

            ws.on("error", (err) => {
                sendData({ error: "upstream websocket error", detail: err instanceof Error ? err.message : String(err) });
                cleanup();
            });

            ws.on("close", () => {
                cleanup();
            });

            req.signal?.addEventListener?.("abort", cleanup);
        },
        cancel() {
            closed = true;
            try {
                ws?.close();
            } catch {
                // ignore
            }
            if (ping) {
                clearInterval(ping);
                ping = null;
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
