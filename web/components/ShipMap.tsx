"use client";

import React, { useMemo, useState } from "react";
import { Map } from "react-map-gl/maplibre";
import { DeckGL } from "@deck.gl/react";
import { PathLayer, IconLayer } from "@deck.gl/layers";
import { useShipStream } from "@/hooks/useShipStream";
import { useShipTracks, ShipTrack, ShipPosition } from "@/hooks/useShipTracks";

type ViewStateLike = {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
};
type Timestampish = { ts?: number; timestamp?: number };

const TRI_SVG_URL =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-32 -32 64 64">
      <polygon points="0,-28 14,28 -14,28" fill="white" />
    </svg>`
    );

type Preset = {
    name: string;
    bbox: [number, number, number, number]; // lat1,lon1,lat2,lon2
};

const PRESETS: Preset[] = [
    { name: "Global (off)", bbox: [-90, -180, 90, 180] },
    { name: "English Channel", bbox: [48.5, -5.5, 51.5, 2.5] },
    { name: "Gulf of Mexico", bbox: [22.0, -97.0, 30.5, -81.0] },
];

// small helpers
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const secondsAgo = (unixSec?: number) =>
    unixSec ? Math.max(0, Math.round(Date.now() / 1000 - unixSec)) : undefined;

type XY = [number, number];

const path2D = (t: ShipTrack): XY[] =>
    t.path.map(([x, y]) => [x, y] as XY);


export default function ShipMap() {
    // HUD state
    const [presetIdx, setPresetIdx] = useState(0);
    const [lookback, setLookback] = useState(60); // minutes
    const bbox = PRESETS[presetIdx].bbox;

    // Map viewState so we can scale icon size by zoom and also clear selection by clicking map
    const [viewState, setViewState] = useState<ViewStateLike>({
        longitude: -1.3,
        latitude: 50.5,
        zoom: 7,
        pitch: 0,
        bearing: 0,
    });

    // Stream and build tracks (client-side accumulator)
    const { ships } = useShipStream({ bbox, lookbackMin: lookback }, 300); // 300ms batches

    const { tracks, currentPositions } = useShipTracks(ships, {
        maxMinutes: Math.max(lookback, 20),
        maxPointsPerShip: 1000,
        minMoveMeters: 6,
        keepaliveSecs: 45,
    });

    const [selectedId, setSelectedId] = useState<string | number | null>(null);
    const selectedPos = useMemo(
        () => currentPositions.find((p: ShipPosition) => p.id === selectedId),
        [currentPositions, selectedId]
    );
    const selectedTrack = useMemo(
        () => tracks.find((t: ShipTrack) => t.id === selectedId),
        [tracks, selectedId]
    );

    const latestTs =
        (selectedPos as (ShipPosition & Timestampish) | undefined)?.ts ??
        (selectedPos as (ShipPosition & Timestampish) | undefined)?.timestamp ??
        (selectedTrack?.path?.length
            ? selectedTrack.path[selectedTrack.path.length - 1][2]
            : undefined);
    const lastUpdatedSeconds = secondsAgo(latestTs);

    // Helper: map SOG (kn) into icon base size (pixels)
    const sizeFromSog = (sog?: number) => {
        const s = Math.max(0, Math.min(30, sog ?? 0)); // clamp 0..30 kn
        return 16 + s * 0.7; // 16..37 px
    };

    // zoom-based scale: smaller when zoomed out
    const zoomScale = useMemo(() => {
        // ~0.28x at z=3, ~1.0x near z=10, capped [0.25..1.2]
        const scaled = (viewState.zoom - 3) / 7; // z=10 => 1
        return clamp(scaled, 0.25, 1.2);
    }, [viewState.zoom]);

    // Recent-tail window (minutes) for crisper highlight
    const recentMinutes = Math.min(lookback, 10);

    const layers = useMemo(() => {
        // 1) Dim long-tail
        const longTail = new PathLayer<ShipTrack>({
            id: "trails-long",
            data: tracks.filter((t) => t.path.length >= 2),
            getPath: (d) => path2D(d),             // <-- typed tuples
            widthUnits: "pixels",
            getWidth: 2,
            capRounded: true,
            jointRounded: true,
            getColor: [0, 200, 240, 70],
            pickable: false,
        });

        // 2) Recent-tail (last N minutes only), brighter and slightly thicker
        const cutoff = Date.now() / 1000 - recentMinutes * 60;
        const recentData: ShipTrack[] = tracks
            .map((t) => ({ ...t, path: t.path.filter((p) => p[2] >= cutoff) }))
            .filter((t) => t.path.length >= 2);

        const recentTail = new PathLayer<ShipTrack>({
            id: "trails-recent",
            data: recentData,
            getPath: (d) => path2D(d),             // <-- typed tuples
            widthUnits: "pixels",
            getWidth: 3,
            capRounded: true,
            jointRounded: true,
            getColor: [0, 240, 255, 180],
            pickable: false,
        });

        // 3) Ships as oriented triangles (IconLayer)
        const shipsLayer = new IconLayer<ShipPosition>({
            id: "ships",
            data: currentPositions,
            getPosition: (d) => [d.lon, d.lat],
            iconAtlas: TRI_SVG_URL,
            iconMapping: { ship: { x: 0, y: 0, width: 64, height: 64, mask: false } },
            getIcon: () => "ship",
            sizeUnits: "pixels",
            getSize: (d) => sizeFromSog(d.sog) * zoomScale,
            // Correct orientation: 0° = north, clockwise, matches COG
            getAngle: (d) => (typeof d.cog === "number" ? Number(d.cog) : 0),
            getColor: (d) => (d.id === selectedId ? [255, 255, 255, 255] : [0, 255, 255, 230]),
            pickable: true,
            autoHighlight: true,
            // DeckGL's pickingInfo type is complex; use `any` and destructure `object` for compatibility
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onClick: ({ object }: any) => {
                if (object) setSelectedId(object.id);
            },
            updateTriggers: {
                getSize: [zoomScale],
                getColor: [selectedId],
            },
        });

        // --- selected track ---
        const selectedPath = selectedTrack && selectedTrack.path.length >= 2 ? [selectedTrack] : [];
        const selectedTail = new PathLayer<ShipTrack>({
            id: "selected-track",
            data: selectedPath,
            getPath: (d) => path2D(d),             // <-- typed tuples
            widthUnits: "pixels",
            getWidth: 4,
            capRounded: true,
            jointRounded: true,
            getColor: [255, 255, 255, 220],
            pickable: false,
        });

        return [longTail, recentTail, shipsLayer, selectedTail];
    }, [tracks, currentPositions, recentMinutes, zoomScale, selectedId, selectedTrack]);

    const shipsCount = currentPositions.length;
    const pointsCount = useMemo(
        () => tracks.reduce((acc, t) => acc + t.path.length, 0),
        [tracks]
    );

    return (
        <div className="fixed inset-0">
            <DeckGL
                controller
                viewState={viewState}
                onViewStateChange={(params) => setViewState(params.viewState as ViewStateLike)}
                layers={layers}
                style={{ width: "100%", height: "100%" }}
                onClick={({ picked }: { picked: boolean }) => {
                    if (!picked) setSelectedId(null);
                }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                getTooltip={({ object }: any) =>
                    object
                        ? `ID: ${object.id ?? ""}${object.sog != null ? ` · ${Number(object.sog).toFixed(1)} kn` : ""}${object.cog != null ? ` · COG ${Math.round(Number(object.cog))}°` : ""}`
                        : null
                }
            >
                <Map
                    reuseMaps
                    mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
                    style={{ width: "100%", height: "100%" }}
                />
            </DeckGL>

            <HUD
                presetIdx={presetIdx}
                setPresetIdx={setPresetIdx}
                lookback={lookback}
                setLookback={setLookback}
                fpsApprox={60}
                pointsCount={pointsCount}
                shipsCount={shipsCount}
                selected={selectedPos as ShipPosition | undefined}
                lastUpdatedSeconds={lastUpdatedSeconds}
                onClear={() => setSelectedId(null)}
            />
        </div>
    );
}

function ArrowIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
                d="M2.07102 11.3494L0.963068 10.2415L9.2017 1.98864H2.83807L2.85227 0.454545H11.8438V9.46023H10.2955L10.3097 3.09659L2.07102 11.3494Z"
                fill="currentColor"
            />
        </svg>
    );
}

function HUD(props: {
    presetIdx: number;
    setPresetIdx: (i: number) => void;
    lookback: number;
    setLookback: (m: number) => void;
    fpsApprox: number;
    pointsCount: number;
    shipsCount: number;
    selected?: ShipPosition | null;
    lastUpdatedSeconds?: number;
    onClear: () => void;
}) {
    const {
        presetIdx,
        setPresetIdx,
        lookback,
        setLookback,
        fpsApprox,
        pointsCount,
        shipsCount,
        selected,
        lastUpdatedSeconds,
        onClear,
    } = props;

    const lookbacks = [5, 15, 30, 60, 120];
    const selectedLabel =
        (selected?.id != null ? String(selected.id) : undefined);

    // pick a few common fields if present
    const fields: Array<[string, string | number | undefined]> = selected
        ? [
            ["ID", selectedLabel],
            ["SOG (kn)", selected.sog != null ? Number(selected.sog).toFixed(1) : undefined],
            ["COG (°)", selected.cog != null ? Math.round(Number(selected.cog)) : undefined],
            ["Lat", selected.lat != null ? Number(selected.lat).toFixed(5) : undefined],
            ["Lon", selected.lon != null ? Number(selected.lon).toFixed(5) : undefined],
        ]
        : [];

    return (
        <div className="absolute left-4 top-4 z-10 rounded-2xl bg-zinc-900/85 text-zinc-100 backdrop-blur-lg shadow-2xl border border-zinc-700 w-96">
            <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                    <h2 className="text-2xl font-semibold tracking-tight">ship-stream</h2>
                    <a
                        className="flex items-center gap-2 transition-colors text-zinc-400 hover:text-zinc-200"
                        rel="noopener noreferrer"
                        target="_blank"
                        href="https://aniketpant.me"
                        aria-label="Aniket Pant portfolio (opens in new tab)"
                    >
                        <ArrowIcon />
                        <span className="text-sm">aniket</span>
                    </a>
                </div>
                <p className="text-xs text-zinc-400 mb-3">Ingestor → Kafka → Stream → Deck.GL</p>

                <div className="flex items-center gap-3 text-sm mb-3">
                    <span className="text-zinc-400">FPS:</span>
                    <span className="font-semibold">{fpsApprox}</span>
                    <span className="text-zinc-400 ml-2">Total points:</span>
                    <span className="font-semibold">{pointsCount}</span>
                    <span className="text-zinc-400 ml-2">Ships:</span>
                    <span className="font-semibold">{shipsCount}</span>
                </div>

                <div className="flex gap-2 mb-3">
                    <select
                        className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm"
                        value={presetIdx}
                        onChange={(e) => setPresetIdx(Number(e.target.value))}
                    >
                        {PRESETS.map((p, i) => (
                            <option key={p.name} value={i}>
                                {p.name}
                            </option>
                        ))}
                    </select>

                    <select
                        className="w-28 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm"
                        value={lookback}
                        onChange={(e) => setLookback(Number(e.target.value))}
                    >
                        {lookbacks.map((m) => (
                            <option key={m} value={m}>
                                {m} min
                            </option>
                        ))}
                    </select>
                </div>

                <div className="rounded-xl bg-zinc-800/70 border border-zinc-700 px-3 py-3 text-sm">
                    <p className="text-zinc-300 font-medium mb-1">Selected ship</p>

                    {!selected ? (
                        <p className="text-zinc-400">Tip: click a ship to see details. Click empty map to clear.</p>
                    ) : (
                        <div>
                            <div className="flex items-center justify-between">
                                <p className="font-semibold">{selectedLabel}</p>
                                <button onClick={onClear} className="text-xs text-zinc-400 hover:text-zinc-200 underline">
                                    Clear
                                </button>
                            </div>
                            <p className="text-zinc-400 mt-1">
                                {lastUpdatedSeconds != null ? `Last updated ${lastUpdatedSeconds}s ago` : "Last updated: n/a"}
                            </p>
                            <ul className="mt-2 space-y-1">
                                {fields
                                    .filter(([, v]) => v != null && v !== "")
                                    .map(([k, v]) => (
                                        <li key={k} className="flex justify-between gap-3">
                                            <span className="text-zinc-400">{k}</span>
                                            {k === "ID" ? (
                                                <a
                                                    href={`https://www.vesselfinder.com/vessels/details/${v}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-zinc-200 hover:text-zinc-50 underline"
                                                >
                                                    {v}
                                                </a>
                                            ) : (
                                                <span className="text-zinc-200">{v}</span>
                                            )}
                                        </li>
                                    ))}
                            </ul>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}