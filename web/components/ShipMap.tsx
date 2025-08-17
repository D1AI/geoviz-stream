"use client";

import React, { useMemo } from "react";
import { Map } from "react-map-gl/maplibre";
import { DeckGL } from "@deck.gl/react";
import { ScatterplotLayer, PathLayer } from "@deck.gl/layers";
import { useShipStream } from "@/hooks/useShipStream";
import { useShipTracks, ShipTrack, ShipPosition } from "@/hooks/useShipTracks";

export default function ShipMap() {
    // Latest de-bounced batch from your stream hook
    const ships = useShipStream();

    // Track builder (20 min window, up to 800 pts/ship, min 6 m movement,
    // and add a “keepalive” point every 45s even if not moved to visualize pauses)
    const { tracks, currentPositions } = useShipTracks(ships, {
        maxMinutes: 20,
        maxPointsPerShip: 800,
        minMoveMeters: 6,
        keepaliveSecs: 45
    });

    const layers = useMemo(() => {
        // cyan-ish trails with rounded joints, drawn above the basemap
        const trails = new PathLayer<ShipTrack>({
            id: "ship-trails",
            data: tracks.filter(t => t.path.length >= 2),
            getPath: (d) => d.path.map(([x, y]) => [x, y]),
            widthUnits: "pixels",
            getWidth: 2.5,
            capRounded: true,
            jointRounded: true,
            parameters: { depthTest: false }, // keep on top for readability
            getColor: [0, 220, 255, 160],
            pickable: false
        });

        // bright points with halo + outline; radius scales a bit with zoom
        const points = new ScatterplotLayer<ShipPosition>({
            id: "ships-layer",
            data: currentPositions,
            getPosition: (d) => [d.lon, d.lat],
            radiusUnits: "pixels",
            getRadius: 6,               // base size
            radiusMinPixels: 4,
            radiusMaxPixels: 10,
            filled: true,
            getFillColor: [255, 80, 80, 220],
            stroked: true,
            lineWidthMinPixels: 1.5,
            getLineColor: [20, 20, 20, 200],
            parameters: { depthTest: false },
            pickable: true,
            autoHighlight: true,
        });

        return [trails, points];
    }, [tracks, currentPositions]);

    return (
        <DeckGL
            initialViewState={{ longitude: 0.45, latitude: 51.47, zoom: 7 }}
            controller
            layers={layers}
            getTooltip={({ object }) =>
                object
                    ? `ID: ${object.id ?? ""}${object.sog != null ? ` · ${Number(object.sog).toFixed(1)} kn` : ""
                    }${object.cog != null ? ` · COG ${Math.round(Number(object.cog))}°` : ""
                    }`
                    : null
            }
        >
            <Map mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" />
        </DeckGL>
    );
}