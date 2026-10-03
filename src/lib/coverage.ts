import type { PositionReport, SearchArea } from './types';

/** 位置记录有效期：超过该时长的位置视为过期，只留档、不计入覆盖率。与页面过期判定一致。 */
export const POSITION_TTL_MS = 10 * 60_000;

/** 单位位置覆盖半径（度）：单位上报位置对周边海域的搜索覆盖范围。 */
export const COVER_RADIUS_DEG = 0.07;

const GRID_COLS = 28;
const GRID_ROWS = 28;

export function isPositionExpired(time: string | number, now: number = Date.now()): boolean {
  return now - new Date(time).getTime() > POSITION_TTL_MS;
}

/**
 * 按新鲜位置点重算搜索区覆盖率。
 * 将搜索区分成网格，任一新鲜（未过期）位置点覆盖半径内的格子视为已搜索，
 * 已搜索格子占比即为覆盖率。过期位置只留档，不参与计算。
 */
export function coverageForArea(area: SearchArea, trail: PositionReport[], now: number = Date.now()): number {
  const [west, south, east, north] = area.bounds;
  const fresh = trail.filter((point) => !isPositionExpired(point.time, now));
  const inArea = fresh.filter((point) => point.lng >= west && point.lng <= east && point.lat >= south && point.lat <= north);
  if (inArea.length === 0) return 0;

  const r2 = COVER_RADIUS_DEG ** 2;
  let covered = 0;
  for (let col = 0; col < GRID_COLS; col += 1) {
    for (let row = 0; row < GRID_ROWS; row += 1) {
      const lng = west + ((col + 0.5) / GRID_COLS) * (east - west);
      const lat = south + ((row + 0.5) / GRID_ROWS) * (north - south);
      if (inArea.some((point) => (point.lng - lng) ** 2 + (point.lat - lat) ** 2 <= r2)) covered += 1;
    }
  }
  return Math.round((covered / (GRID_COLS * GRID_ROWS)) * 100);
}
