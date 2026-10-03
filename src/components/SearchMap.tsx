'use client';

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, Marker } from 'maplibre-gl';
import type { PositionReport, RescueAsset, SearchArea } from '@/lib/types';
import { isPositionExpired } from '@/lib/coverage';

export function SearchMap({ areas, assets, trail }: { areas: SearchArea[]; assets: RescueAsset[]; trail: PositionReport[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);

  useEffect(() => {
    let disposed = false;
    void import('maplibre-gl').then(({ Map, Marker: MapMarker, LngLatBounds }) => {
      if (disposed || !containerRef.current) return;
      const map = new Map({ container: containerRef.current, center: [121.68, 30.82], zoom: 8.5, style: 'https://demotiles.maplibre.org/style.json' });
      mapRef.current = map;
      map.on('load', () => {
        areas.forEach((area) => {
          map.addSource(area.id, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[area.bounds[0], area.bounds[1]], [area.bounds[2], area.bounds[1]], [area.bounds[2], area.bounds[3]], [area.bounds[0], area.bounds[3]], [area.bounds[0], area.bounds[1]]]] } } });
          map.addLayer({ id: `${area.id}-fill`, type: 'fill', source: area.id, paint: { 'fill-color': area.status === 'active' ? '#0e7490' : '#f59e0b', 'fill-opacity': .22 } });
          map.fitBounds(new LngLatBounds([area.bounds[0], area.bounds[1]], [area.bounds[2], area.bounds[3]]), { padding: 60 });
        });
        markersRef.current = assets.map((asset) => new MapMarker({ color: asset.status === 'offline' ? '#dc2626' : '#0f766e' }).setLngLat([asset.lng, asset.lat]).addTo(map));

        // 位置轨迹：新鲜点青色，过期点灰色只留档
        const features = trail.map((point) => ({
          type: 'Feature' as const,
          properties: { archived: isPositionExpired(point.time) || point.archived },
          geometry: { type: 'Point' as const, coordinates: [point.lng, point.lat] }
        }));
        map.addSource('trail', { type: 'geojson', data: { type: 'FeatureCollection', features } });
        map.addLayer({ id: 'trail-archived', type: 'circle', source: 'trail', filter: ['==', ['get', 'archived'], true], paint: { 'circle-radius': 3, 'circle-color': '#9ca3af', 'circle-opacity': .7 } });
        map.addLayer({ id: 'trail-fresh', type: 'circle', source: 'trail', filter: ['!=', ['get', 'archived'], true], paint: { 'circle-radius': 4, 'circle-color': '#0d9488', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' } });
      });
    });
    return () => { disposed = true; markersRef.current.forEach((marker) => marker.remove()); mapRef.current?.remove(); };
  }, [areas, assets, trail]);

  return <div ref={containerRef} className="map-shell" aria-label="搜救海域地图" />;
}
