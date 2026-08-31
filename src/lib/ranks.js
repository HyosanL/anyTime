// =====================================================================
//  학점계산기 — 학기별 등수 저장(서버 rank_entry)
//
//  학위교육과목·생활/훈련과목 두 갈래로 "내 등수/총원"을 학기당 한 행에 저장한다.
//  RLS: 본인 행만(cadet_id = auth.uid()). grade_entry 와 같은 패턴.
// =====================================================================
import { supabase } from '../supabase';

const COLS = 'id, year, term, academic_rank, academic_total, training_rank, training_total';

// 내 전 학기 등수 행(최신 학기 순).
export async function listRanks() {
  const { data, error } = await supabase
    .from('rank_entry')
    .select(COLS)
    .order('year', { ascending: false })
    .order('term', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// 학기 하나의 등수를 통째로 저장(없으면 새로 만들고, 있으면 갱신) — 입력칸 4개를 한 행으로 묶는다.
export async function upsertRank(cadetId, year, term, patch) {
  const { data, error } = await supabase
    .from('rank_entry')
    .upsert({ cadet_id: cadetId, year, term, ...patch }, { onConflict: 'cadet_id,year,term' })
    .select(COLS)
    .single();
  if (error) throw error;
  return data;
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
      academic: percentile(r.academic_rank, r.academic_total),
      training: percentile(r.training_rank, r.training_total),
    }))
    .filter((p) => p.academic != null || p.training != null);
}
