import { supabase } from '../supabase';
import { getPosition } from './auth';

// 현재 위치로 지오펜싱 재인증. 'OK' | 'OUT_OF_AREA' | 'NO_LOCATION' | 'ERROR'
export async function verifyGeo() {
  const { lat, lng } = await getPosition();
  if (lat == null || lng == null) return 'NO_LOCATION';
  const { data, error } = await supabase.rpc('geo_verify', { p_lat: lat, p_lng: lng });
  if (error) return 'ERROR';
  return data;
}
