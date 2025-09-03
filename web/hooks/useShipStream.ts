"use client";

import { useEffect, useRef, useState } from "react";
import type { ShipPosition } from "@/types/Ship";

const BASE_URL =
    (process.env.NEXT_PUBLIC_WS_URL as string) || "ws://localhost:8000/ws";

export function useShipStream(
    params?: { bbox?: [number, number, number, number]; lookbackMin?: number },
    batchMs = 500
) {
    const [ships, setShips] = useState<ShipPosition[]>([]);
    const latest = useRef<Map<string, ShipPosition>>(new Map());

    // Build URL with query params
    const url = (() => {
        const u = new URL(BASE_URL);
        if (params?.bbox) {
            const [lat1, lon1, lat2, lon2] = params.bbox;
            u.searchParams.set("bbox", `${lat1},${lon1},${lat2},${lon2}`);
        }
        if (typeof params?.lookbackMin === "number") {
            u.searchParams.set("lookback_min", String(params.lookbackMin));
        }
        return u.toString().replace("http", "ws");
    })();

    useEffect(() => {
        let closed = false;
        let ws: WebSocket | null = null;

        const open = () => {
            ws = new WebSocket(url);

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    // Ignore control frames from server
                    if (msg?.type === "ping" || msg?.type === "history_start" || msg?.type === "history_done") {
                        return;
                    }
                    // Minimal schema guard
                    if (
                        !msg ||
                        typeof msg.id !== "string" ||
                        typeof msg.lat !== "number" ||
                        typeof msg.lon !== "number"
                    ) {
                        return;
                    }
                    latest.current.set(msg.id, {
                        id: msg.id,
                        lat: msg.lat,
                        lon: msg.lon,
                        sog: msg.sog,
                        cog: msg.cog,
                        hdg: msg.hdg,
                        t: msg.t,
                    });
                } catch {
                    /* ignore malformed frames */
                }
            };

            ws.onclose = () => {
                if (!closed) setTimeout(open, 1000);
            };
        };

        open();

        const timer = window.setInterval(() => {
            if (latest.current.size) {
                setShips(Array.from(latest.current.values()));
                latest.current.clear();
            }
        }, batchMs);

        return () => {
            closed = true;
            window.clearInterval(timer);
            try {
                ws?.close();
            } catch { }
        };
    }, [url, batchMs]);

    return ships;
}