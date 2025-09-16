// we use a route.ts Route Handler to proxy traffic from the private K8s service to the public internet
// this way, we can continue to listen to WS-type traffic from the server without exposing the WS API
import { NextRequest } from "next/server";
import WebSocket from "ws";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const bbox = searchParams.get("bbox") ?? "";
    const lookback = searchParams.get("lookback_min") ?? "";

    const upstreamUrl =
        `ws://${process.env.WS_API_INTERNAL_HOST || "localhost"}:8000/ws` +
        `?${bbox ? `bbox=${encodeURIComponent(bbox)}&` : ""}` +
        `${lookback ? `lookback_min=${encodeURIComponent(lookback)}` : ""}`;
    let ws: WebSocket | null = null;
    let ping: NodeJS.Timeout | null = null;
    let closed = false;

    const stream = new ReadableStream({
        start(controller) {
            const enc = new TextEncoder();

            const safeEnqueue = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(enc.encode(chunk));
                } catch {
                    // Stream already closed; stop everything.
                    cleanup();
                }
            };

            const sendData = (data: unknown) =>
                safeEnqueue(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);

            const sendComment = (text: string) =>
                safeEnqueue(`: ${text}\n\n`);

            const cleanup = () => {
                if (closed) return;
                closed = true;
                if (ping) { clearInterval(ping); ping = null; }
                try { ws?.close(); } catch { }
                try { controller.close(); } catch { }
            };

            ws = new WebSocket(upstreamUrl);

            ws.on("open", () => {
                // keep-alive so proxies don’t buffer/close
                ping = setInterval(() => sendComment("ping"), 15000);
            });

            ws.on("message", (buf) => {
                if (closed) return;
                sendData(buf.toString());
            });

            ws.on("error", () => {
                // Try to notify once, then close/stop writing.
                sendData({ error: "upstream websocket error" });
                cleanup();
            });

            ws.on("close", () => {
                cleanup();
            });

            // If browser disconnects, stop writing immediately
            req.signal?.addEventListener?.("abort", cleanup);
        },
        cancel() {
            // Called if consumer cancels the stream
            closed = true;
            try { ws?.close(); } catch { }
            if (ping) { clearInterval(ping); ping = null; }
        }
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