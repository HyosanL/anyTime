// =====================================================================
//  학점계산기 — 학기별 등수 저장(users/{uid}/rankEntries/{year_term})
//
//  학위교육과목·생활/훈련과목 두 갈래로 "내 등수/총원"을 학기당 한 행에 저장한다.
//  Rules: 본인 서브컬렉션만(isOwner(uid)) — grades.js 와 같은 패턴(Cloud Function 없음).
//  문서ID 를 year_term 으로 고정해 그 자체가 유일성 제약(옛 UNIQUE(cadet_id,year,term))을 겸한다.
// =====================================================================
import { collection, doc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';

function col(uid) {
  return collection(db, 'users', uid, 'rankEntries');
}

// 옛 COLS 와 마찬가지로 created_at 은 화면에 실어 보내지 않는다.
function rowFromDoc(d) {
  const data = d.data();
  return {
    id: d.id,
    year: data.year,
    term: data.term,
    academicRank: data.academicRank ?? null,
    academicTotal: data.academicTotal ?? null,
    trainingRank: data.trainingRank ?? null,
    trainingTotal: data.trainingTotal ?? null,
  };
}

// 내 전 학기 등수 행(최신 학기 순). rankEntries 는 학기당 최대 1행이라 매우 작다 —
// 복합색인 없이 통째로 받아 클라이언트에서 정렬한다(gradeEntries 와 달리 색인이 없다).
export async function listRanks() {
  const uid = auth.currentUser?.uid;
  if (!uid) return [];
  const snap = await getDocs(col(uid));
  const rows = snap.docs.map(rowFromDoc);
  rows.sort((a, b) => b.year - a.year || b.term - a.term);
  return rows;
}

// 학기 하나의 등수를 통째로 저장(없으면 새로 만들고, 있으면 갱신) — 입력칸 4개를 한 행으로 묶는다.
// patch 는 늘 4개 필드를 모두 담아 온다(호출부가 기존 행과 병합해 넘긴다) — 그대로 덮어써
// 옛 upsert(ON CONFLICT DO UPDATE) 와 같은 효과를 낸다.
export async function upsertRank(cadetId, year, term, patch) {
  const uid = cadetId || auth.currentUser?.uid;
  if (!uid) throw new Error('로그인이 필요합니다.');
  const data = {
    year,
    term,
    academicRank: patch.academicRank ?? null,
    academicTotal: patch.academicTotal ?? null,
    trainingRank: patch.trainingRank ?? null,
    trainingTotal: patch.trainingTotal ?? null,
    updatedAt: serverTimestamp(),
  };
  await setDoc(doc(col(uid), `${year}_${term}`), data);
  return { id: `${year}_${term}`, year, term, ...patch };
}

// ── 순수 계산 ─────────────────────────────────────────────────────────
// 백분위(높을수록 좋음) = (총원 - 등수 + 1) / 총원 × 100. rank·total 둘 다 있어야 계산된다.
export function percentile(rank, total) {
  if (!(rank > 0) || !(total > 0) || rank > total) return null;
  return Math.round(((total - rank + 1) / total) * 1000) / 10;
}

// 등수 추이(오래된→최신). 두 갈래 중 하나라도 계산되는 학기만 포함.
export function rankTrendPoints(rows) {
  return [...(rows ?? [])]
    .sort((a, b) => a.year - b.year || a.term - b.term)
    .map((r) => ({
      label: `${String(r.year).slice(2)}-${r.term}`,
      academic: percentile(r.academicRank, r.academicTotal),
      training: percentile(r.trainingRank, r.trainingTotal),
    }))
    .filter((p) => p.academic != null || p.training != null);
}
