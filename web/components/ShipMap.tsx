import React, { useEffect, useMemo } from 'react';
import { Map } from 'react-map-gl/maplibre';
import { DeckGL } from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { useShipStream } from "@/hooks/useShipStream";

export default function ShipMap() {

    const ships = useShipStream();

    useEffect(() => {
        console.log("Ships:", ships);
    }, [ships]);

    const layers = useMemo(() => [
        new ScatterplotLayer({
            id: "ships-layer",
            data: ships,
            getPosition: (d: any) => [d.lon, d.lat],
            getFillColor: [255, 0, 0, 150],
            getRadius: 1000,
            radiusUnits: "meters",
            stroked: true,
            lineWidthMinPixels: 1,
            getLineColor: [0, 0, 0],
            pickable: true,
            autoHighlight: true,
        })
    ], [ships]);

    return (
        <DeckGL
            initialViewState={{ longitude: 0.45, latitude: 51.47, zoom: 11 }}
            controller
            layers={layers}
        >
            <Map mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" />
        </DeckGL>
    );
}