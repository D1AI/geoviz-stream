"use client";

import { useEffect, useRef, useState } from "react";
import type { ShipPosition } from "@/types/Ship";

const DEFAULT_URL = (process.env.NEXT_PUBLIC_WS_URL as string) || "ws://localhost:8000/ws";

export function useShipStream(url: string = DEFAULT_URL, batchMs = 500) {
    const [ships, setShips] = useState<ShipPosition[]>([]);
    const latest = useRef<Map<string, ShipPosition>>(new Map());

    useEffect(() => {
        let closed = false;
        let ws: WebSocket | null = null;

        const open = () => {
            ws = new WebSocket(url);

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data) as Partial<ShipPosition> & { mt?: string };
                    // Minimal schema guard
                    if (!msg || typeof msg.id !== "string" || typeof msg.lat !== "number" || typeof msg.lon !== "number") {
                        return;
                    }
                    // Save latest per id
                    latest.current.set(msg.id, {
                        id: msg.id,
                        lat: msg.lat,
                        lon: msg.lon,
                        sog: msg.sog,
                        cog: msg.cog,
                        hdg: msg.hdg,
                        t: msg.t
                    });
                } catch {
                    // ignore malformed frames
                }
            };

            ws.onclose = () => {
                if (!closed) setTimeout(open, 1000); // simple reconnect
            };
        };

        open();

        const timer = window.setInterval(() => {
            if (latest.current.size) {
                // Emit and clear to keep memory bounded
                setShips(Array.from(latest.current.values()));
                latest.current.clear();
            }
        }, batchMs);

        return () => {
            closed = true;
            window.clearInterval(timer);
            try { ws?.close(); } catch { }
        };
    }, [url, batchMs]);

    return ships;
}