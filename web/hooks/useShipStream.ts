"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ShipPosition } from "@/types/Ship";

export function useShipStream(
    params?: { bbox?: [number, number, number, number]; lookbackMin?: number },
    batchMs = 500
) {
    const [ships, setShips] = useState<ShipPosition[]>([]);
    const latest = useRef<Map<string, ShipPosition>>(new Map());

    const url = useMemo(() => {
        const u = new URL("/api/ships", window.location.origin);
        if (params?.bbox) {
            const [lat1, lon1, lat2, lon2] = params.bbox;
            u.searchParams.set("bbox", `${lat1},${lon1},${lat2},${lon2}`);
        }
        if (typeof params?.lookbackMin === "number") {
            u.searchParams.set("lookback_min", String(params.lookbackMin));
        }
        return u.toString();
    }, [params?.bbox?.join(","), params?.lookbackMin]);

    useEffect(() => {
        const es = new EventSource(url, { withCredentials: false });

        let buffer: ShipPosition[] = [];
        let flushTimer: any = null;

        const flush = () => {
            if (buffer.length) {
                setShips((prev) => {
                    const next = [...prev, ...buffer];
                    buffer = [];
                    return next;
                });
            }
        };

        es.onmessage = (ev) => {
            try {
                const payload = JSON.parse(ev.data);
                // payload might be a single message or a batch
                const arr = Array.isArray(payload) ? payload : [payload];
                for (const msg of arr) {
                    // de-dup / latest-by-id cache if needed
                    if (msg?.id != null) latest.current.set(String(msg.id), msg);
                    buffer.push(msg);
                }
                if (!flushTimer) {
                    flushTimer = setTimeout(() => {
                        flushTimer = null;
                        flush();
                    }, batchMs);
                }
            } catch {
                // ignore parse errors or heartbeat comments
            }
        };

        es.onerror = () => {
            // TODO: show a toast when disconnected
        };

        return () => {
            try { es.close(); } catch { }
            if (flushTimer) clearTimeout(flushTimer);
        };
    }, [url, batchMs]);

    return { ships, latest: latest.current };
}