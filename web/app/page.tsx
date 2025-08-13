'use client';

import dynamic from 'next/dynamic';

const ShipMap = dynamic(() => import('../components/ShipMap'), { ssr: false });

export default function Home() {
  return <ShipMap />;
}