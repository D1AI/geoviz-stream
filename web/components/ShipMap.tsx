"use client";

import React, { useMemo, useState } from "react";
import { Map } from "react-map-gl/maplibre";
import { DeckGL } from "@deck.gl/react";
import { PathLayer, IconLayer } from "@deck.gl/layers";
import { useShipStream } from "@/hooks/useShipStream";
import { useShipTracks, ShipTrack, ShipPosition } from "@/hooks/useShipTracks";

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

export default function ShipMap() {
    // HUD state
    const [presetIdx, setPresetIdx] = useState(0);
    const [lookback, setLookback] = useState(60); // minutes
    const bbox = PRESETS[presetIdx].bbox;

    // Stream and build tracks (client-side accumulator)
    const ships = useShipStream({ bbox, lookbackMin: lookback }, 300); // 300ms batches
    const { tracks, currentPositions } = useShipTracks(ships, {
        maxMinutes: Math.max(lookback, 20),
        maxPointsPerShip: 1000,
        minMoveMeters: 6,
        keepaliveSecs: 45,
    });

    // Helper: map SOG (kn) into icon size (pixels)
    const sizeFromSog = (sog?: number) => {
        const s = Math.max(0, Math.min(30, (sog ?? 0))); // clamp 0..30 kn
        return 16 + s * 0.7; // 16..37 px
    };

    // Recent-tail window (minutes) for crisper highlight
    const recentMinutes = Math.min(lookback, 10);

    const layers = useMemo(() => {
        // 1) Dim long-tail
        const longTail = new PathLayer<ShipTrack>({
            id: "trails-long",
            data: tracks.filter((t) => t.path.length >= 2),
            getPath: (d) => d.path.map(([x, y]) => [x, y]),
            widthUnits: "pixels",
            getWidth: 2,
            capRounded: true,
            jointRounded: true,
            parameters: { depthTest: false },
            getColor: [0, 200, 240, 70], // subtle cyan
            pickable: false,
        });

        // 2) Recent-tail (last N minutes only), brighter and slightly thicker
        const cutoff = Date.now() / 1000 - recentMinutes * 60;
        const recentTail = new PathLayer<ShipTrack>({
            id: "trails-recent",
            data: tracks
                .map((t) => ({
                    ...t,
                    path: t.path.filter((p) => p[2] >= cutoff),
                }))
                .filter((t) => t.path.length >= 2),
            getPath: (d) => d.path.map(([x, y]) => [x, y]),
            widthUnits: "pixels",
            getWidth: 3,
            capRounded: true,
            jointRounded: true,
            parameters: { depthTest: false },
            getColor: [0, 240, 255, 180], // bright cyan
            pickable: false,
        });

        // 3) Ships as oriented triangles (IconLayer)
        const shipsLayer = new IconLayer<ShipPosition>({
            id: "ships",
            data: currentPositions,
            getPosition: (d) => [d.lon, d.lat],
            iconAtlas: TRI_SVG_URL,
            iconMapping: { ship: { x: 0, y: 0, width: 64, height: 64, mask: false } },
            getIcon: (_d) => "ship",
            sizeUnits: "pixels",
            getSize: (d) => sizeFromSog(d.sog),
            // COG degrees, deck.gl expects degrees clockwise from positive x-axis, but our SVG points up (north).
            // Map: SVG up (north) = 0°, deck.gl 0° points right (east) → angle = 90 - COG
            getAngle: (d) =>
                typeof d.cog === "number" ? 90 - Number(d.cog) : 0,
            getColor: [0, 255, 255, 230],
            parameters: { depthTest: false },
            pickable: true,
            autoHighlight: true,
        });

        return [longTail, recentTail, shipsLayer];
    }, [tracks, currentPositions, recentMinutes]);

    const shipsCount = currentPositions.length;
    const pointsCount = useMemo(
        () => tracks.reduce((acc, t) => acc + t.path.length, 0),
        [tracks]
    );

    return (
        <div className="fixed inset-0">   {/* 👈 fills the viewport */}
            <DeckGL
                controller
                initialViewState={{ longitude: -1.3, latitude: 50.5, zoom: 7 }}
                layers={layers}
                style={{ width: '100%', height: '100%' }}  // 👈 ensure size
                getTooltip={({ object }) =>
                    object
                        ? `ID: ${object.id ?? ""}${object.sog != null ? ` · ${Number(object.sog).toFixed(1)} kn` : ""
                        }${object.cog != null ? ` · COG ${Math.round(Number(object.cog))}°` : ""
                        }`
                        : null
                }
            >
                {/* Map must also be 100% of its parent */}
                <Map
                    reuseMaps
                    mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
                    style={{ width: '100%', height: '100%' }}   // 👈 ensure size
                />
            </DeckGL>

            {/* HUD floats above */}
            <HUD
                presetIdx={presetIdx}
                setPresetIdx={setPresetIdx}
                lookback={lookback}
                setLookback={setLookback}
                fpsApprox={60}
                pointsCount={pointsCount}
                shipsCount={shipsCount}
            />
        </div>
    );
}

// ----- HUD component -----
function HUD(props: {
    presetIdx: number;
    setPresetIdx: (i: number) => void;
    lookback: number;
    setLookback: (m: number) => void;
    fpsApprox: number;
    pointsCount: number;
    shipsCount: number;
}) {
    const {
        presetIdx,
        setPresetIdx,
        lookback,
        setLookback,
        fpsApprox,
        pointsCount,
        shipsCount,
    } = props;

    const lookbacks = [5, 15, 30, 60, 120];

    return (
        <div className="absolute left-4 top-4 z-10 rounded-2xl bg-zinc-900/85 text-zinc-100 backdrop-blur-lg shadow-2xl border border-zinc-700 max-w-sm">
            <div className="p-4">
                <h2 className="text-2xl font-semibold tracking-tight mb-2">ship-stream</h2>
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
                    {/* BBOX preset */}
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

                    {/* lookback minutes */}
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

                {/* Selected ship card (placeholder hook point) */}
                <div className="rounded-xl bg-zinc-800/70 border border-zinc-700 px-3 py-3 text-sm">
                    <p className="text-zinc-300 font-medium mb-1">Selected ship</p>
                    <p className="text-zinc-400">Tip: click empty map to clear selection.</p>
                </div>
            </div>
        </div>
    );
}