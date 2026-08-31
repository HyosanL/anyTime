import { callFn } from './functions.js';
import { getPosition } from './auth';

// 현재 위치로 지오펜싱 재인증. 'OK' | 'OUT_OF_AREA' | 'NO_LOCATION' | 'ERROR'
export async function verifyGeo() {
  const { lat, lng } = await getPosition();
  if (lat == null || lng == null) return 'NO_LOCATION';
  const r = await callFn('geoVerify', { lat, lng });
  if (!r.ok) return r.status === 'permission-denied' ? 'OUT_OF_AREA' : 'ERROR';
  return 'OK';
}
