import { useMemo, useState } from 'react';
import { supabase } from '../supabase';
import '../styles/correction.css';

// 정보 수정 제안 모달 (익명). options: [{label, target, targetKey, field, placeholder, current, kind?, periods?, professors?}]
//  - kind:'time'       → 요일·교시 빌더(사용자가 양식을 못 맞춰도 정규 문자열 "수3-4 금1" 생성)
//  - kind:'professor'  → 교수 검색·선택(동명이인은 코드로 확정, val="이름 (코드)")
//  - kind:'sectionAdd' → 없는 분반 추가 제안(분반번호·교수·시간·강의실 → 정규화 JSON 한 벌로 제출)
//  - kind 없음         → 기존 자유 텍스트 입력
// 제출은 submit_correction RPC(SECURITY DEFINER) — 작성자 미저장.
const DAYS = [[1, '월'], [2, '화'], [3, '수'], [4, '목'], [5, '금']];
const DAY_KO = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };

// 빌더 행들 → 서버 파서가 이해하는 정규 문자열("수3-4 금1")
function blocksToStr(rows) {
  return rows
    .filter((r) => r.day && r.start && r.end)
    .map((r) => {
      const a = Math.min(r.start, r.end);
      const b = Math.max(r.start, r.end);
      return a === b ? `${DAY_KO[r.day]}${a}` : `${DAY_KO[r.day]}${a}-${b}`;
    })
    .join(' ');
}

function defaultRow(o) {
  const ps = o?.periods?.length ? o.periods : [1];
  return { day: 1, start: ps[0], end: ps[0] };
}

// 지금 등록된 시간(section_time 원본, currentBlocks)이 있으면 빌더를 그걸로 채운다 —
// 빈 칸에서 매번 새로 적게 하면, 사람들이 '틀린 한 줄'만 고치려다가 맞던 나머지 요일까지
// 빠뜨린 제안을 보낸다(수정이 아니라 사실상 '전체 교체'가 돼 버림). 등록된 시간이 없으면
// (신규 분반 제안 등) 빈 기본 행 한 개로 시작한다.
function rowsFromOption(o) {
  const blocks = o?.currentBlocks;
  if (blocks?.length) {
    return blocks.map((b) => ({ day: b.day_of_week, start: b.start_period, end: b.end_period }));
  }
  return [defaultRow(o)];
}

// 분반추가에서 고를 수 있는 분반번호 = 이미 있는 번호를 뺀 목록(1..최대+여유).
function availableNos(existingNos) {
  const ex = new Set(existingNos || []);
  const maxNo = (existingNos && existingNos.length) ? Math.max(...existingNos) : 0;
  const cap = Math.max(maxNo + 5, 15);
  const out = [];
  for (let n = 1; n <= cap; n++) if (!ex.has(n)) out.push(n);
  return out;
}

export default function CorrectionModal({ subject, options, onClose }) {
  const [idx, setIdx] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  // 빌더 상태 — 첫 항목이 '시간'이고 현재 등록된 시간이 있으면 그걸로 미리 채운다.
  const [rows, setRows] = useState(rowsFromOption(options[0])); // 요일·교시
  const [val, setVal] = useState(options[0]?.kind === 'time' ? blocksToStr(rowsFromOption(options[0])) : '');
  const [pq, setPq] = useState('');       // 교수 검색어
  const [picked, setPicked] = useState(null); // 선택된 교수 {code,name,department}
  const [saNo, setSaNo] = useState(1);    // 분반추가: 분반번호
  const [saRoom, setSaRoom] = useState(''); // 분반추가: 강의실
  const opt = options[idx] || {};

  const periods = opt.periods?.length ? opt.periods : [1, 2, 3, 4, 5, 6, 7, 8];

  function selectOption(i) {
    setIdx(i);
    setErr('');
    // '시간' 항목은 현재 등록된 시간으로 미리 채운다(val 도 같이 채워야 손 안 대고 그대로
    // 제출해도 값이 비지 않는다). 다른 항목(교수·자유입력 등)은 그대로 빈 값에서 시작.
    const initRows = rowsFromOption(options[i]);
    setRows(initRows);
    setVal(options[i]?.kind === 'time' ? blocksToStr(initRows) : '');
    setPq('');
    setPicked(null);
    // 분반추가: 이미 있는 번호를 뺀 첫 번째 사용가능 번호를 기본값으로.
    setSaNo(options[i]?.kind === 'sectionAdd' ? (availableNos(options[i].existingNos)[0] ?? 1) : 1);
    setSaRoom('');
  }

  // ── 요일·교시 빌더 핸들러 ──
  function commitRows(next) {
    setRows(next);
    setVal(blocksToStr(next));
  }
  function changeRow(i, key, v) {
    commitRows(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  }
  function addRow() {
    commitRows([...rows, defaultRow(opt)]);
  }
  function removeRow(i) {
    commitRows(rows.filter((_, j) => j !== i));
  }

  // ── 교수 검색 ──
  const profResults = useMemo(() => {
    if (opt.kind !== 'professor' && opt.kind !== 'sectionAdd') return [];
    const q = pq.trim().toLowerCase();
    if (!q) return [];
    return (opt.professors ?? [])
      .filter((p) => p.name.toLowerCase().includes(q) || (p.department ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      .slice(0, 20);
  }, [opt, pq]);

  function pickProf(p) {
    setPicked(p);
    setVal(`${p.name} (${p.code})`);
    setPq('');
  }
  // 검색에 없는(미등록) 교수: 신규 제안. 관리자가 적용하면 새 교수로 등록됨.
  function pickNewProf(name) {
    setPicked({ code: null, name, isNew: true });
    setVal(`${name} (신규)`);
    setPq('');
  }

  async function submit() {
    let suggested = val.trim();
    if (opt.kind === 'sectionAdd') {
      const no = Math.round(Number(saNo));
      // 번호·교수·시간은 필수. 번호는 이미 있는 분반이면 막는다(목록에서도 제외되지만 이중 방어).
      if (!Number.isFinite(no) || no < 1) return setErr('분반 번호를 선택하세요.');
      if ((opt.existingNos || []).includes(no)) return setErr('이미 있는 분반 번호입니다. 다른 번호를 고르세요.');
      if (!picked) return setErr('담당 교수를 지정하세요.');
      const timesStr = blocksToStr(rows);
      if (!timesStr) return setErr('요일·교시를 한 개 이상 지정하세요.');
      const profVal = picked.isNew ? `${picked.name} (신규)` : `${picked.name} (${picked.code})`;
      // 정규화 JSON(키 순서 고정 no→prof→room→times) — 동일 제안 3건↑ 자동반영이
      // '문자열 완전일치'로 묶기 때문에 순서·공백이 일정해야 한 분반으로 뭉친다.
      suggested = JSON.stringify({ no, prof: profVal, room: saRoom.trim(), times: timesStr });
    } else if (!suggested && !note.trim()) {
      return setErr('올바른 값이나 설명 중 하나는 입력하세요.');
    }
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('submit_correction', {
      p_target: opt.target,
      p_target_key: opt.targetKey,
      p_label: subject,
      p_field: opt.field,
      p_suggested: suggested,
      p_note: note.trim(),
    });
    setBusy(false);
    if (error) return setErr(error.message || '제출에 실패했습니다.');
    setDone(true);
  }

  // 교수 검색·선택 UI — '담당교수' 항목과 '분반추가' 항목이 함께 쓴다.
  const profPickerUI = picked ? (
    <div className="cor-prof-picked">
      <span><b>{picked.name}</b> · {picked.isNew ? '신규 등록 예정' : (picked.department || '학과 미정')}</span>
      <button type="button" className="cor-row-del" onClick={() => { setPicked(null); setVal(''); }}>변경</button>
    </div>
  ) : (
    <>
      <input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="교수명 · 학과로 검색" />
      {pq.trim() && (
        <ul className="cor-prof-list">
          {profResults.map((p) => (
            <li key={p.code}>
              <button type="button" onClick={() => pickProf(p)}>
                <b>{p.name}</b> <span className="muted">{p.department || '학과 미정'}</span>
              </button>
            </li>
          ))}
          {/* 미등록 교수: 검색한 이름으로 신규 제안(관리자 승인/자동반영 시 생성) */}
          <li>
            <button type="button" className="cor-prof-new" onClick={() => pickNewProf(pq.trim())}>
              ＋ ‘<b>{pq.trim()}</b>’ 이름으로 <b>신규 교수</b> 제안
            </button>
          </li>
        </ul>
      )}
    </>
  );

  // 요일·교시 빌더 — '시간' 항목과 '분반추가' 항목이 함께 쓴다.
  // 분반추가에선 시간이 선택이라 마지막 한 줄도 지울 수 있게 한다(줄이 0개면 시간 미정).
  const timeBuilderUI = (
    <div className="cor-time-builder">
      {rows.map((r, i) => (
        <div className="cor-time-row" key={i}>
          <select value={r.day} onChange={(e) => changeRow(i, 'day', +e.target.value)} aria-label="요일">
            {DAYS.map(([n, l]) => <option key={n} value={n}>{l}</option>)}
          </select>
          <select value={r.start} onChange={(e) => changeRow(i, 'start', +e.target.value)} aria-label="시작교시">
            {periods.map((p) => <option key={p} value={p}>{p}교시</option>)}
          </select>
          <span className="cor-time-tilde">~</span>
          <select value={r.end} onChange={(e) => changeRow(i, 'end', +e.target.value)} aria-label="종료교시">
            {periods.map((p) => <option key={p} value={p}>{p}교시</option>)}
          </select>
          {rows.length > 1 && (
            <button type="button" className="cor-row-del" onClick={() => removeRow(i)} aria-label="이 시간 삭제">✕</button>
          )}
        </div>
      ))}
      <button type="button" className="cor-row-add" onClick={addRow}>＋ 요일 추가</button>
    </div>
  );

  return (
    <div className="cor-overlay" onClick={onClose}>
      <div className="cor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cor-head">
          <b>🚩 정보 수정 제안</b>
          <button className="cor-x" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <p className="cor-subject">{subject}</p>

        {done ? (
          <div className="cor-done">
            <p>✅ 제안이 접수되었습니다. 관리자 검토 후 반영됩니다. 감사합니다!</p>
            <button className="btn-add btn-block" onClick={onClose}>닫기</button>
          </div>
        ) : (
          <>
            <label className="field"><span className="field-label">무엇이 잘못됐나요?</span>
              <select value={idx} onChange={(e) => selectOption(+e.target.value)}>
                {options.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
              </select>
            </label>
            {opt.current != null && String(opt.current) !== '' && (
              <p className="cor-current">현재: <b>{String(opt.current)}</b></p>
            )}

            {opt.kind === 'time' ? (
              <div className="field">
                <span className="field-label">올바른 요일·교시</span>
                {timeBuilderUI}
                <p className="cor-preview">입력값: <b>{val || '—'}</b></p>
              </div>
            ) : opt.kind === 'professor' ? (
              <div className="field">
                <span className="field-label">올바른 담당교수</span>
                {profPickerUI}
                {!picked && <p className="cor-hint">동명이인은 학과로 구분해 선택하세요. 목록에 없으면 위 ‘신규 교수 제안’.</p>}
              </div>
            ) : opt.kind === 'sectionAdd' ? (
              <div className="field cor-sa">
                <p className="cor-hint cor-sa-hint">수강편람에 있는데 목록에 <b>없는 분반</b>을 알려 주세요(분반번호·교수·시간 <b>필수</b>). 승인되면(또는 같은 제안 3건↑) 자동으로 분반이 추가됩니다.</p>
                <div className="cor-sa-grid">
                  <label className="cor-sa-field"><span>분반 번호</span>
                    <select value={saNo} onChange={(e) => setSaNo(+e.target.value)}>
                      {availableNos(opt.existingNos).map((n) => <option key={n} value={n}>{n}분반</option>)}
                    </select>
                  </label>
                  <label className="cor-sa-field"><span>강의실 (선택)</span>
                    <input value={saRoom} onChange={(e) => setSaRoom(e.target.value)} placeholder="예: 302" />
                  </label>
                </div>
                <span className="field-label">담당교수</span>
                {profPickerUI}
                <span className="field-label cor-sa-time-label">요일·교시</span>
                {timeBuilderUI}
                <p className="cor-preview">
                  {saNo || '?'}분반 · {picked ? picked.name : '교수 미정'} · {blocksToStr(rows) || '시간 미정'}{saRoom.trim() ? ` · ${saRoom.trim()}` : ''}
                </p>
              </div>
            ) : (
              <label className="field"><span className="field-label">올바른 값</span>
                <input value={val} onChange={(e) => setVal(e.target.value)} placeholder={opt.placeholder || '올바른 값'} />
              </label>
            )}

            <label className="field"><span className="field-label">설명(선택)</span>
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="무엇이 어떻게 잘못됐는지 알려주세요." />
            </label>
            {err && <p className="error-msg">{err}</p>}
            <button className="btn-add btn-block" disabled={busy} onClick={submit}>{busy ? '제출 중…' : '제안 보내기'}</button>
            <p className="cor-hint">익명으로 접수됩니다(작성자 정보 미저장).</p>
          </>
        )}
      </div>
    </div>
  );
}
