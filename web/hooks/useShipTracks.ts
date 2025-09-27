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

const toRad = (d: number) => (d * Math.PI) / 180;
const EARTH_RADIUS_M = 6371000;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

const bearingDegrees = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x =
        Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    const brng = Math.atan2(y, x);
    const deg = (brng * 180) / Math.PI;
    return (deg + 360) % 360;
};

const toUnixSeconds = (value: number): number => {
    if (!Number.isFinite(value)) return Date.now() / 1000;
    return value > 1e11 ? value / 1000 : value;
};

const MS_PER_KNOT = 0.514444; // meters per second at 1 knot
const MAX_SPEED_KNOTS = 60; // ignore jumps faster than roughly 60 kn
const MAX_JUMP_METERS = 80000; // ignore single hops longer than ~80 km

const finiteOrUndefined = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

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

        for (const incoming of ships) {
            if (!incoming?.id || incoming.lat == null || incoming.lon == null) continue;

            const lat = Number(incoming.lat);
            const lon = Number(incoming.lon);
            const t = toUnixSeconds(typeof incoming.t === "number" ? incoming.t : Date.now() / 1000);

            let tr = tracksRef.current.get(incoming.id);
            if (!tr) {
                tr = { id: incoming.id, path: [], last: { ...incoming, lat, lon, t } };
                tracksRef.current.set(incoming.id, tr);
                changed = true;
            }

            const lastPoint = tr.path[tr.path.length - 1];
            const distance = lastPoint ? haversineMeters(lastPoint[1], lastPoint[0], lat, lon) : 0;
            const timeGap = lastPoint ? Math.max(t - lastPoint[2], 0) : Infinity;
            const movedEnough = !lastPoint || distance >= minMoveMeters;
            const needsKeepalive = keepaliveSecs != null && timeGap >= keepaliveSecs;

            const incomingSog = finiteOrUndefined(incoming.sog);
            const incomingCog = finiteOrUndefined(incoming.cog);
            const incomingHdg = finiteOrUndefined(incoming.hdg);

            const derivedSog = lastPoint && timeGap > 0
                ? (distance / Math.max(timeGap, 1e-3)) / MS_PER_KNOT
                : undefined;
            const derivedCog = lastPoint && distance >= minMoveMeters / 2
                ? bearingDegrees(lastPoint[1], lastPoint[0], lat, lon)
                : undefined;

            const candidateSog = incomingSog ?? derivedSog;
            const candidateCog = incomingCog ?? derivedCog;

            const unrealisticJump = !!lastPoint && (
                distance > MAX_JUMP_METERS ||
                (derivedSog !== undefined && derivedSog > MAX_SPEED_KNOTS) ||
                (incomingSog !== undefined && incomingSog > MAX_SPEED_KNOTS)
            );

            const previous = tr.last;
            const next: ShipPosition = {
                ...incoming,
                lat,
                lon,
                t,
                sog: candidateSog ?? finiteOrUndefined(previous?.sog),
                cog: candidateCog ?? finiteOrUndefined(previous?.cog),
                hdg: incomingHdg ?? finiteOrUndefined(previous?.hdg),
            };

            if (unrealisticJump) {
                tr.path = [[lon, lat, t]];
                tr.last = next;
                changed = true;
                continue;
            }

            if (movedEnough || needsKeepalive) {
                tr.path.push([lon, lat, t]);
                tr.last = next;
                changed = true;

                while (tr.path.length && tr.path[0][2] < cutoff) tr.path.shift();

                if (tr.path.length > maxPointsPerShip) {
                    tr.path.splice(0, tr.path.length - maxPointsPerShip);
                }
            } else {
                tr.last = next;
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
