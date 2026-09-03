// 시간표 이미지 저장 시트가 마지막 배경 사진을 기억하는 작은 IndexedDB.
// 사진 blob 은 localStorage 에 담기엔 크므로(수 MB) 별도 IDB 에 둔다. 이 기기에만 남는다.
// 사진 배치·모드·배경색·글자크기 등 가벼운 값은 localStorage(ttimg:*)가 맡는다.
import { openDB } from 'idb';

const DB = 'anytime-ttimg';
const STORE = 'kv';
const KEY = 'photo';

let _p = null;
function db() {
  if (!_p) {
    _p = openDB(DB, 1, {
      upgrade(d) { if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); },
    });
  }
  return _p;
}

export async function savePhotoBlob(blob) {
  try { (await db()).put(STORE, blob, KEY); } catch { /* ignore */ }
}

export async function loadPhotoBlob() {
  try { return (await (await db()).get(STORE, KEY)) || null; } catch { return null; }
}

export async function clearPhotoBlob() {
  try { (await db()).delete(STORE, KEY); } catch { /* ignore */ }
}
