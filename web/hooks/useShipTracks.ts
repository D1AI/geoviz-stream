"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type ShipPosition = {
    id: string;
    lat: number;
    lon: number;
    sog?: number;
    cog?: number;
    hdg?: number;
    t?: number; // epoch seconds (fallback to now if missing)
};

type TrackPoint = [number, number, number]; // [lon, lat, tSecs]
export type ShipTrack = { id: string; path: TrackPoint[]; last: ShipPosition };

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Accumulate per-ship tracks on the client.
 * - Keeps only last `maxMinutes`
 * - Limits points per ship to `maxPointsPerShip`
 * - Appends a new point if moved >= `minMoveMeters`
 * - Optionally appends a "keepalive" point every `keepaliveSecs` even if stationary,
 *   so trails remain visible during pauses.
 */
export function useShipTracks(
    ships: ShipPosition[],
    opts?: {
        maxMinutes?: number;
        maxPointsPerShip?: number;
        minMoveMeters?: number;
        keepaliveSecs?: number; // optional
    }
) {
    const {
        maxMinutes = 15,
        maxPointsPerShip = 500,
        minMoveMeters = 5,
        keepaliveSecs
    } = opts || {};

    const tracksRef = useRef<Map<string, ShipTrack>>(new Map());
    const [version, setVersion] = useState(0); // bump to trigger rerenders

    useEffect(() => {
        if (!ships?.length) return;

        const cutoff = Date.now() / 1000 - maxMinutes * 60;
        let changed = false;

        for (const sp of ships) {
            if (!sp.id || sp.lat == null || sp.lon == null) continue;

            const t = typeof sp.t === "number" ? sp.t : Date.now() / 1000;
            let tr = tracksRef.current.get(sp.id);
            if (!tr) {
                tr = { id: sp.id, path: [], last: sp };
                tracksRef.current.set(sp.id, tr);
                changed = true;
            }

            const last = tr.path[tr.path.length - 1];
            const movedEnough =
                !last || haversineMeters(last[1], last[0], sp.lat, sp.lon) >= minMoveMeters;

            const timeGap = !last ? Infinity : t - last[2];
            const needsKeepalive =
                keepaliveSecs != null && timeGap >= keepaliveSecs;

            if (movedEnough || needsKeepalive) {
                tr.path.push([sp.lon, sp.lat, t]);
                tr.last = sp;
                changed = true;

                // prune by time
                while (tr.path.length && tr.path[0][2] < cutoff) tr.path.shift();

                // limit size
                if (tr.path.length > maxPointsPerShip) {
                    tr.path.splice(0, tr.path.length - maxPointsPerShip);
                }
            } else {
                // still update live attributes for tooltip
                tr.last = sp;
            }
        }

        // prune dead/idle tracks
        for (const [id, tr] of tracksRef.current) {
            if (!tr.path.length || tr.path[tr.path.length - 1][2] < cutoff) {
                tracksRef.current.delete(id);
                changed = true;
            }
        }

        if (changed) setVersion(v => v + 1);
    }, [ships, maxMinutes, maxPointsPerShip, minMoveMeters, keepaliveSecs]);

    const tracks = useMemo(() => Array.from(tracksRef.current.values()), [version]);
    const currentPositions = useMemo(
        () => tracks.map((t) => t.last),
        [tracks]
    );

    return { tracks, currentPositions };
}