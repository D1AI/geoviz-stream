export interface ShipPosition {
    id: string;         // MMSI
    lat: number;
    lon: number;
    sog?: number;       // speed over ground (knots)
    cog?: number;       // course over ground (deg)
    hdg?: number;       // heading (deg)
    t?: number;         // epoch seconds
}