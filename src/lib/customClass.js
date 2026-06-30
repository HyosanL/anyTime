// 사용자가 직접 추가한 시간표 항목(DB에 없는 강의).
// 개인 일정이라 기기 로컬(localStorage)에 사용자별로 저장한다.
// 항목 형태: { id, title, day(1~7), startMin, endMin, room }

const keyFor = (uid) => `anytime:customClasses:${uid || 'anon'}`;

export function listCustomClasses(uid) {
  try {
    const raw = localStorage.getItem(keyFor(uid));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(uid, arr) {
  try { localStorage.setItem(keyFor(uid), JSON.stringify(arr)); } catch { /* ignore */ }
}

function newId() {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch { /* ignore */ }
  return `c${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export function addCustomClass(uid, entry) {
  const arr = listCustomClasses(uid);
  const item = { id: newId(), ...entry };
  arr.push(item);
  save(uid, arr);
  return item;
}

export function removeCustomClass(uid, id) {
  const arr = listCustomClasses(uid).filter((c) => c.id !== id);
  save(uid, arr);
  return arr;
}

// "09:00" / "09:00:00" -> 자정부터의 분. 빈값이면 null.
export function hmToMin(s) {
  if (s == null || s === '') return null;
  const [h, m] = String(s).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

// 분 -> "09:00"
export function minToHM(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
