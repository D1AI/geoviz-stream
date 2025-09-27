"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ShipPosition } from "@/types/Ship";

const numberOrUndefined = (value: unknown): number | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "string" && value.trim() === "") return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
};

const toUnixSeconds = (value: number | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (value > 1e11) return value / 1000; // convert ms → s
    if (value > 1e10) return value / 1000; // handle slightly smaller ms timestamps
    return value;
};

const normalizeShip = (payload: unknown): ShipPosition | null => {
    if (!payload || typeof payload !== "object") return null;
    const rec = payload as Record<string, unknown>;

    const id = rec.id ?? rec.mmsi ?? rec.shipId ?? rec.UserID;
    const lat = numberOrUndefined(rec.lat ?? rec.latitude ?? rec.Latitude);
    const lon = numberOrUndefined(rec.lon ?? rec.longitude ?? rec.Longitude);

    if (!id || lat == null || lon == null) return null;

    const sog = numberOrUndefined(rec.sog ?? rec.Sog);
    const cog = numberOrUndefined(rec.cog ?? rec.Cog);
    const hdg = numberOrUndefined(rec.hdg ?? rec.TrueHeading ?? rec.heading);
    const ts = toUnixSeconds(numberOrUndefined(rec.t ?? rec.ts ?? rec.timestamp ?? rec.TimeStamp));

    return {
        id: String(id),
        lat,
        lon,
        sog,
        cog,
        hdg,
        t: ts,
    };
};

export function useShipStream(
    params?: { bbox?: [number, number, number, number]; lookbackMin?: number },
    batchMs = 500
) {
    const [ships, setShips] = useState<ShipPosition[]>([]);
    const [historyComplete, setHistoryComplete] = useState(false);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const latest = useRef<Map<string, ShipPosition>>(new Map());

    const url = useMemo(() => {
        if (typeof window === "undefined") return "";
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
        if (!url) return;

        latest.current = new Map();
        setShips([]);
        setHistoryComplete((params?.lookbackMin ?? 0) <= 0);
        setConnected(false);
        setError(null);

        const es = new EventSource(url, { withCredentials: false });

        let buffer: ShipPosition[] = [];
        let flushTimer: ReturnType<typeof setTimeout> | null = null;

        const flush = () => {
            if (!buffer.length) return;
            const batch = [...buffer];
            buffer = [];
            setShips(batch);
        };

        es.onopen = () => {
            setConnected(true);
        };

        es.onmessage = (ev) => {
            try {
                const payload = JSON.parse(ev.data);
                const frames = Array.isArray(payload) ? payload : [payload];
                for (const frame of frames) {
                    if (frame && typeof frame === "object" && (frame as { type?: string }).type === "history_complete") {
                        setHistoryComplete(true);
                        continue;
                    }
                    const ship = normalizeShip(frame);
                    if (!ship) continue;
                    latest.current.set(ship.id, ship);
                    buffer.push(ship);
                }

                if (!flushTimer && buffer.length) {
                    flushTimer = setTimeout(() => {
                        flushTimer = null;
                        flush();
                    }, batchMs);
                }
            } catch {
                // Ignore malformed payloads (heartbeats, etc.)
            }
        };

        es.onerror = () => {
            setConnected(false);
            setError("stream disconnected");
        };

        return () => {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            flush();
            try {
                es.close();
            } catch {
                // ignore
            }
        };
    }, [url, batchMs]);

    return {
        ships,
        latest: latest.current,
        historyComplete,
        connected,
        error,
    };
}
