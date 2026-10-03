'use client';

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, Marker } from 'maplibre-gl';
import type { PositionArchive, RescueAsset, SearchArea } from '@/lib/types';

export function SearchMap({ areas, assets, archives }: { areas: SearchArea[]; assets: RescueAsset[]; archives: PositionArchive[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const archiveMarkersRef = useRef<Marker[]>([]);

  useEffect(() => {
    let disposed = false;
    void import('maplibre-gl').then(({ Map, Marker: MapMarker, LngLatBounds, Popup }) => {
      if (disposed || !containerRef.current) return;
      const map = new Map({ container: containerRef.current, center: [121.68, 30.82], zoom: 8.5, style: 'https://demotiles.maplibre.org/style.json' });
      mapRef.current = map;
      map.on('load', () => {
        const bounds = new LngLatBounds();
        areas.forEach((area) => {
          map.addSource(area.id, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[area.bounds[0], area.bounds[1]], [area.bounds[2], area.bounds[1]], [area.bounds[2], area.bounds[3]], [area.bounds[0], area.bounds[3]], [area.bounds[0], area.bounds[1]]]] } } });
          map.addLayer({ id: `${area.id}-fill`, type: 'fill', source: area.id, paint: { 'fill-color': area.status === 'active' ? '#0e7490' : '#f59e0b', 'fill-opacity': .22 } });
          map.addLayer({ id: `${area.id}-line`, type: 'line', source: area.id, paint: { 'line-color': area.status === 'active' ? '#0e7490' : '#f59e0b', 'line-width': 1.5 } });
          bounds.extend([area.bounds[0], area.bounds[1]]);
          bounds.extend([area.bounds[2], area.bounds[3]]);
        });
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60 });

        const drawAssetMarkers = () => {
          markersRef.current.forEach((marker) => marker.remove());
          markersRef.current = assets.map((asset) => new MapMarker({
            color: asset.status === 'offline' ? '#dc2626' : '#0f766e',
            opacity: asset.positionStale ? 0.55 : 1
          }).setLngLat([asset.lng, asset.lat]).setPopup(new Popup({ offset: 12 }).setHTML(
            `<strong>${asset.name}</strong><br/>状态：${asset.status}${asset.positionStale ? '<br/><span style="color:#dc2626">失联前位置·已过期</span>' : ''}`
          )).addTo(map));
        };

        const drawArchiveMarkers = () => {
          archiveMarkersRef.current.forEach((marker) => marker.remove());
          archiveMarkersRef.current = archives.map((entry) => {
            const el = document.createElement('div');
            el.style.width = '12px';
            el.style.height = '12px';
            el.style.border = '2px dashed #d97706';
            el.style.borderRadius = '50%';
            el.style.background = 'rgba(217,119,6,.15)';
            return new MapMarker({ element: el, anchor: 'center' })
              .setLngLat([entry.lng, entry.lat])
              .setPopup(new Popup({ offset: 12 }).setHTML(`过期位置档案<br/>${entry.at}<br/>仅留档，不参与态势与覆盖率`))
              .addTo(map);
          });
        };

        drawAssetMarkers();
        drawArchiveMarkers();
        mapRef.current = map;
        (map as unknown as { __drawAssets?: () => void; __drawArchives?: () => void }).__drawAssets = drawAssetMarkers;
        (map as unknown as { __drawAssets?: () => void; __drawArchives?: () => void }).__drawArchives = drawArchiveMarkers;
      });
    });
    return () => {
      disposed = true;
      markersRef.current.forEach((marker) => marker.remove());
      archiveMarkersRef.current.forEach((marker) => marker.remove());
      mapRef.current?.remove();
    };
    // 只初始化一次地图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据变化时只重绘标记，不重建整张地图
  useEffect(() => {
    const map = mapRef.current as (MapLibreMap & { __drawAssets?: () => void }) | null;
    if (map && map.loaded?.()) map.__drawAssets?.();
  }, [assets]);

  useEffect(() => {
    const map = mapRef.current as (MapLibreMap & { __drawArchives?: () => void }) | null;
    if (map && map.loaded?.()) map.__drawArchives?.();
  }, [archives]);

  return <div ref={containerRef} className="map-shell" aria-label="搜救海域地图" />;
}
