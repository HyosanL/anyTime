import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import BackButton from '../components/BackButton';
import CorrectionModal from '../components/CorrectionModal';
import { correctionMeta, sectionCorrectionOptions, sectionSubject } from '../lib/correction';
import { getCatalog, buildSections, currentSemester, semesterList, formatTimes, dayLabel } from '../lib/cache';
import {
  listTimetables, createTimetable, renameTimetable, setPrimaryTimetable, deleteTimetable,
  addSections, findEmptyTimetables, selectTimetable, isOverlapError,
} from '../lib/timetable';
import { generateCombos, pickDiverse, groupByTime, deriveNoClass, timeKey, SORTS, DEFAULT_SORT } from '../lib/wizard';
import { readDraft, writeDraft, clearDraft } from '../lib/wizardDraft';
import { paletteByKey, usePalette } from '../lib/palettes';
import '../styles/wizard.css';
import '../styles/course.css';

const MAX_PER_SEM = 5;                 // DB 트리거와 같은 값(학기당 시간표 상한)
const SHOW_LIMIT = 20;                 // 한 번에 보여줄 후보 수 — 사람이 훑어보고 고를 수 있는 양
const BUSY_HINT = 400;                 // 이 정도 경우의 수부터는 '분반을 좁히라'고 권한다
const NAME_MAX = 20;                   // timetable.name CHECK
const CAND_NAME = (i) => `후보 ${String.fromCharCode(65 + i)}`;   // 후보 A, B, C…

const STEPS = ['과목', '분반', '조건', '후보'];

// 한 시간 묶음(같은 시간·교수만 다른 분반들)에서 사용자가 고른 분반 — 기본은 첫 분반.
const pickKey = (courseCode, groupKey) => `${courseCode}@${groupKey}`;

// 후보 미리보기(교시 × 요일) — 홈 격자의 축소판. 링크 없이 보기만 한다.
// 비수업 시간(생도대·군사훈련…)은 회색으로 깔아 '수업이 없는 시간'임을 드러낸다.
function MiniGrid({ groups, picked, periodNos, days, colorOf, fg, noClass, blockLabel }) {
  const cells = {};
  for (const g of groups) {
    const s = picked(g);
    for (const t of g.times ?? []) {
      const ps = periodNos.filter((p) => p >= t.startPeriod && p <= t.endPeriod);
      ps.forEach((p, i) => {
        cells[`${t.dayOfWeek}-${p}`] = {
          title: s.courseName,
          no: s.sectionNo,
          color: colorOf(s.courseCode),
          fg,
          span: i === 0 ? ps.length : 0,
          skip: i > 0,
        };
      });
    }
  }
  return (
    <table className="wz-mini">
      <thead>
        <tr>
          <th className="wz-mini-corner" />
          {days.map((d) => <th key={d}>{dayLabel(d)}</th>)}
        </tr>
      </thead>
      <tbody>
        {periodNos.map((p) => (
          <tr key={p}>
            <th className="wz-mini-p">{p}</th>
            {days.map((d) => {
              const c = cells[`${d}-${p}`];
              if (c?.skip) return null;
              const off = !c && noClass.has(`${d}-${p}`);
              return (
                <td
                  key={d}
                  className={off ? 'is-noclass' : undefined}
                  title={off ? (blockLabel[`${d}-${p}`] ?? '수업 없는 시간') : undefined}
                  rowSpan={c && c.span > 1 ? c.span : undefined}
                  style={c ? { background: c.color, '--cell-fg': c.fg } : undefined}
                >
                  {c && (
                    <span className="wz-mini-cell">
                      <b>{c.title}</b>
                      <i>{c.no}</i>
                    </span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 후보의 성격을 한눈에 — 문장으로 늘어놓으면 좁은 화면에서 두세 줄로 접혀 카드가 길어진다.
function CandChips({ stats }) {
  const none = stats.freeDays.length === 0 && stats.amFree.length === 0 && stats.pmFree.length === 0;
  return (
    <span className="wz-chips">
      {stats.freeDays.length > 0 && (
        <span className="wz-chip is-good">공강 {stats.freeDays.map(dayLabel).join('·')}</span>
      )}
      {stats.amFree.length > 0 && <span className="wz-chip">오전 {stats.amFree.map(dayLabel).join('·')}</span>}
      {stats.pmFree.length > 0 && <span className="wz-chip">오후 {stats.pmFree.map(dayLabel).join('·')}</span>}
      {none && <span className="wz-chip">공강 없음</span>}
      {stats.early > 0 && <span className="wz-chip">1교시 {stats.early}</span>}
      {stats.gaps > 0 && <span className="wz-chip">낀시간 {stats.gaps}</span>}
    </span>
  );
}

// 시간표 마법사: 들어야 하는 과목을 담고 → 과목마다 '가능한 시간·교수'만 켜고 → 조건을 주면
// 겹치지 않는 조합을 만들어 서로 다른 20개를 보여준다. 그중 최대 5개를 저장하고 하나를 확정한다.
//
// ★ 켠 것만 후보에 들어간다. 항공기상 1분반만 켰다면 2·3분반은 어떤 후보에도 등장하지 않는다.
// ★ 같은 과목·같은 시간에 교수만 다른 분반은 한 후보로 합친다(후보 폭발 방지). 교수는 4단계에서 고른다.
// ★ 조합이 수백 개 나와도 화면에는 '성격이 서로 다른' 20개만 올린다(pickDiverse) — 분반 하나만
//    다른 쌍둥이 20개를 늘어놓으면 고를 것이 없는 것과 같다.
// ★ 조합 계산은 전부 브라우저에서(카탈로그는 이미 IndexedDB 캐시) — 서버는 '저장'에서만 쓴다.
export default function Wizard() {
  const { session } = useAuthContext();
  const navigate = useNavigate();
  const uid = session?.uid;

  const [catalog, setCatalog] = useState(null);
  const [timetables, setTimetables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [step, setStep] = useState(1);
  const [semKey, setSemKey] = useState('');           // "2026-2"
  const [picked, setPicked] = useState([]);           // [{ code, offKeys:[시간묶음], offSecs:[분반id] }]
  const [query, setQuery] = useState('');
  const [blocked, setBlocked] = useState(() => new Set());   // 기피 시간 "요일-교시"
  const [sortMode, setSortMode] = useState(DEFAULT_SORT);
  const [profPick, setProfPick] = useState({});       // "과목@시간묶음" → 고른 분반 id
  const [corr, setCorr] = useState(null);             // 🚩 수정 제안 모달 { subject, options }
  const [savedSigs, setSavedSigs] = useState([]);     // 이미 저장한 후보 서명 — '이미 저장함' 배지(중복 저장 방지)
  const [resumeNote, setResumeNote] = useState(null); // { dropped:[과목코드] } — 되살릴 때 폐강되어 뺀 과목 안내

  const [slots, setSlots] = useState(null);           // { existing, empty[] } — 저장 가능 슬롯
  const [chosen, setChosen] = useState([]);           // 저장할 후보의 sig 목록
  const [names, setNames] = useState({});             // sig → 시간표 이름
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);           // 저장 결과 [{ id, name, reused }]
  const [primaryId, setPrimaryId] = useState(null);   // null = 기존 확정을 그대로 둔다
  const [keepPrimary, setKeepPrimary] = useState(null);  // 후보가 아닌, 강의가 담긴 기존 확정

  const [resumed, setResumed] = useState(false);      // 초안을 되살렸다 — 그 사실을 한 번 알린다
  const hydrated = useRef(false);                     // 복원 전에는 임시저장하지 않는다(빈 값 덮어쓰기 방지)

  // ── 카탈로그·시간표 목록 ────────────────────────────────────────────
  useEffect(() => {
    let active = true;

    // 지난번에 짜다 만 것을 되살린다. 카탈로그가 온 뒤라야 한다 — 그 사이 폐강된 과목이나
    // 사라진 학기를 되살려 놓으면, 화면에는 뜨지도 않는 것이 목록에만 남는다.
    const restoreDraft = (cat) => {
      const draft = readDraft(uid);
      const known = new Set(semesterList(cat).map((s) => `${s.year}-${s.term}`));
      if (draft && known.has(draft.semKey)) {
        const [y, t] = draft.semKey.split('-').map(Number);
        const secs = buildSections(cat, { year: y, term: t }).sections;
        const codeSet = new Set(secs.map((s) => s.courseCode));
        const idSet = new Set(secs.map((s) => s.id));
        // 과목별 현재 시간 묶음 키 — 시간이 바뀐 옛 offKey 는 여기 없으니 버려진다(그 묶음은 다시 켜진다).
        const keysByCode = new Map();
        for (const c of secs) {
          const set = keysByCode.get(c.courseCode) ?? keysByCode.set(c.courseCode, new Set()).get(c.courseCode);
          set.add(timeKey(c.times));
        }

        // 폐강·삭제되어 사라진 과목은 뺀다(그 사실은 아래에서 알린다). 남은 과목의 껐던 분반·시간 묶음도
        // 지금 카탈로그에 남은 것만 유지한다 — 사라진 id 를 붙들면 화면엔 없는 것을 끈 채로 두는 셈이다.
        const dropped = draft.picked.filter((p) => !codeSet.has(p.code)).map((p) => p.code);
        const picked = draft.picked
          .filter((p) => codeSet.has(p.code))
          .map((p) => ({
            code: p.code,
            offKeys: (p.offKeys ?? []).filter((k) => keysByCode.get(p.code)?.has(k)),
            offSecs: (p.offSecs ?? []).filter((id) => idSet.has(id)),
          }));
        if (picked.length > 0) {
          const profPick = {};
          for (const [k, id] of Object.entries(draft.profPick ?? {})) if (idSet.has(id)) profPick[k] = id;
          setSemKey(draft.semKey);
          setPicked(picked);
          setBlocked(draft.blocked);
          setSortMode(SORTS[draft.sortMode] ? draft.sortMode : DEFAULT_SORT);  // 옛 'free'·'half'는 기본값으로
          setProfPick(profPick);
          setSavedSigs(draft.savedSigs ?? []);
          setStep(draft.step);
          setResumed(true);
          if (dropped.length) setResumeNote({ dropped });
          return;
        }
      }
      if (draft) clearDraft();                  // 되살릴 수 없는 초안은 붙들고 있어 봐야 소용없다
      const cur = currentSemester(cat);
      if (cur) setSemKey(`${cur.year}-${cur.term}`);
    };

    (async () => {
      try {
        const [cat, list] = await Promise.all([getCatalog(), listTimetables().catch(() => [])]);
        if (!active) return;
        setCatalog(cat);
        setTimetables(list);
        restoreDraft(cat);
        hydrated.current = true;      // 이 뒤로 오는 변경만 초안이다
      } catch {
        // 카탈로그를 못 읽었으면 hydrated 는 false 로 둔다 — 빈 화면이 초안을 덮어쓰면
        // 오프라인으로 한 번 들어온 것만으로 짜 두었던 것이 날아간다.
        if (active) setErr('강의 정보를 불러오지 못했습니다. (오프라인이고 캐시도 없음)');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [uid]);

  // 자동 임시저장 — 담을 때마다 로컬에 적어 둔다. 서버 요청은 늘지 않는다(저장은 마지막에 한 번).
  // 저장을 끝낸 뒤(saved)에는 적지 않는다 — 이미 시간표가 된 것을 초안으로 다시 남길 이유가 없다.
  useEffect(() => {
    if (!hydrated.current || saved) return;
    writeDraft(uid, { step, semKey, picked, blocked, sortMode, profPick, savedSigs });
  }, [uid, step, semKey, picked, blocked, sortMode, profPick, savedSigs, saved]);

  // 단계를 넘길 때마다 맨 위로 — 아래쪽 버튼을 누른 자리에서 다음 화면 중간이 열리면 길을 잃는다.
  useEffect(() => { window.scrollTo({ top: 0 }); }, [step]);

  const semesters = useMemo(() => (catalog ? semesterList(catalog) : []), [catalog]);
  const sem = useMemo(() => {
    const [y, t] = semKey.split('-').map(Number);
    return y && t ? { year: y, term: t } : null;
  }, [semKey]);

  const sections = useMemo(
    () => (catalog && sem ? buildSections(catalog, sem).sections : []),
    [catalog, sem]
  );

  const periodNos = useMemo(
    () => [...(catalog?.periods ?? [])].map((p) => p.no).sort((a, b) => a - b),
    [catalog]
  );

  // 🚩 수정 제안 — 2단계에서 시간·교수가 틀린 분반을 본 자리에서 바로 알린다(강의 검색과 같은 양식).
  const corrMeta = useMemo(() => correctionMeta(catalog), [catalog]);
  const openCorr = (s) => setCorr({ subject: sectionSubject(s), options: sectionCorrectionOptions(s, corrMeta) });

  // 관리자가 이름 붙인 비수업 시간(commonBlocks). 자동 유도로는 잡히지 않는 것도 여기 들어온다 —
  // 예: 월7·8, 수7·8 은 '자율선택형교과' 시간이라 일반 강의는 없지만 체육(무도·체력단련)이
  // 열려 있어서 '개설 0개' 규칙에 걸리지 않는다. 그래서 관리자가 직접 등록한다.
  const blockLabel = useMemo(() => {
    const map = {};
    for (const b of catalog?.commonBlocks ?? []) {
      if (!sem || b.year !== sem.year || b.term !== sem.term) continue;
      for (let p = b.startPeriod; p <= b.endPeriod; p++) map[`${b.dayOfWeek}-${p}`] = b.label;
    }
    return map;
  }, [catalog, sem]);

  // 전 생도 비수업 시간 = 자동 유도(어떤 분반도 열리지 않는 칸) ∪ 관리자가 이름 붙인 칸.
  const noClass = useMemo(() => {
    const s = deriveNoClass(sections, periodNos);
    for (const k of Object.keys(blockLabel)) s.add(k);
    return s;
  }, [sections, periodNos, blockLabel]);

  // 과목 단위로 묶고, 그 안에서 다시 '같은 시간'끼리 묶는다.
  const courses = useMemo(() => {
    const m = new Map();
    for (const s of sections) {
      if (!m.has(s.courseCode)) {
        m.set(s.courseCode, { code: s.courseCode, name: s.courseName, sections: [] });
      }
      m.get(s.courseCode).sections.push(s);
    }
    for (const c of m.values()) {
      c.sections.sort((a, b) => a.sectionNo - b.sectionNo);
      c.groups = groupByTime(c.sections);        // [{ key, times, sections:[교수별 분반] }]
    }
    return m;
  }, [sections]);

  // 담은 과목 = { course, offKeys, offSecs, options }
  // options = 켜 둔 시간 묶음(그 안의 분반도 켜 둔 것만). 이게 생성기의 유일한 입력이다.
  const items = useMemo(
    () => picked
      .map((p) => {
        const c = courses.get(p.code);
        if (!c) return null;
        const offKeys = new Set(p.offKeys);
        const offSecs = new Set(p.offSecs);
        const options = c.groups
          .filter((g) => !offKeys.has(g.key))
          .map((g) => ({ ...g, sections: g.sections.filter((s) => !offSecs.has(s.id)) }))
          .filter((g) => g.sections.length > 0);
        return { course: c, offKeys, offSecs, options };
      })
      .filter(Boolean),
    [picked, courses]
  );

  // 겹침을 따지기 전의 '켠 시간 묶음의 곱' — 후보가 얼마나 쏟아질지 미리 가늠하는 값.
  const roughCount = useMemo(
    () => items.reduce((n, it) => n * Math.max(1, it.options.length), 1),
    [items]
  );

  // 표시 요일: 평일 + 실제로 쓰이는 토·일
  const days = useMemo(() => {
    const set = new Set([1, 2, 3, 4, 5]);
    for (const it of items) for (const s of it.course.sections) for (const t of s.times ?? []) set.add(t.dayOfWeek);
    return [...set].sort((a, b) => a - b);
  }, [items]);

  // 미리보기 색은 사용자가 고른 팔레트(홈과 동일). 바뀌면 이벤트로 재렌더.
  const [pkey] = usePalette();
  const pal = paletteByKey(pkey);
  const palette = pal.colors;
  const colorOf = useCallback(
    (code) => {
      const i = picked.findIndex((p) => p.code === code);
      return palette[(i < 0 ? 0 : i) % palette.length];
    },
    [picked, palette]
  );

  // 한 시간 묶음에서 실제로 담을 분반(교수). 고르지 않았으면 첫 분반.
  const pickedSection = useCallback(
    (g) => {
      const code = g.sections[0].courseCode;
      const id = profPick[pickKey(code, g.key)];
      return g.sections.find((s) => s.id === id) ?? g.sections[0];
    },
    [profPick]
  );

  // ── 조합 생성(순수 계산 — 서버 요청 없음) ───────────────────────────
  // 탐색(무거움)과 추림·정렬(가벼움)을 나눈다 — 정렬 기준만 바꿨다고 조합을 다시 만들지 않는다.
  const raw = useMemo(() => {
    if (step < 4 || items.length === 0) return null;
    return generateCombos({
      courses: items.map((it) => ({ code: it.course.code, name: it.course.name, options: it.options })),
      blocked,
      periodNos,
      noClass,
    });
  }, [step, items, blocked, periodNos, noClass]);

  // 화면에 올릴 후보 — 성격이 서로 다른 것부터 SHOW_LIMIT 개.
  const view = useMemo(
    () => (raw ? pickDiverse(raw.combos, sortMode, SHOW_LIMIT) : null),
    [raw, sortMode]
  );

  // ── 저장 슬롯: 학기당 5개 상한. 비어 있는 시간표는 후보로 재사용한다. ──
  useEffect(() => {
    if (step !== 4 || !sem || slots) return;
    let active = true;
    (async () => {
      const inSem = timetables.filter((t) => t.year === sem.year && t.term === sem.term);
      try {
        const empty = await findEmptyTimetables(inSem.map((t) => t.id));
        if (!active) return;
        setSlots({ existing: inSem.length, empty: inSem.filter((t) => empty.has(t.id)) });
      } catch {
        if (active) setSlots({ existing: inSem.length, empty: [] });   // 못 세면 재사용 안 함(보수적)
      }
    })();
    return () => { active = false; };
  }, [step, sem, slots, timetables]);

  const maxSave = slots
    ? Math.min(MAX_PER_SEM, slots.empty.length + Math.max(0, MAX_PER_SEM - slots.existing))
    : MAX_PER_SEM;

  // ── 과목 담기 ────────────────────────────────────────────────────────
  const q = query.trim().toLowerCase();
  const found = useMemo(() => {
    if (!q) return [];
    const has = new Set(picked.map((p) => p.code));
    return [...courses.values()]
      .filter((c) => !has.has(c.code))
      .filter((c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.sections.some((s) => (s.professorName ?? '').toLowerCase().includes(q))
      )
      .slice(0, 20);
  }, [q, courses, picked]);

  // 입력이 바뀌면 이전 선택은 무효 — 조합이 달라진다.
  function resetResults() {
    setChosen([]);
    setNames({});
    setConfirming(false);
    setResumed(false);       // 이어서 손을 대기 시작했으면 '불러왔다'는 안내는 할 일을 다했다
  }

  const goStep = (n) => { setResumed(false); setStep(n); };

  // 지난 초안을 버리고 처음부터. 되살리기가 반가운 만큼, 버리는 길도 한 번에 보여야 한다.
  function startOver() {
    clearDraft();
    setResumed(false);
    setResumeNote(null);
    setSavedSigs([]);
    setPicked([]);
    setBlocked(new Set());
    setProfPick({});
    setSlots(null);
    setStep(1);
    const cur = currentSemester(catalog);
    if (cur) setSemKey(`${cur.year}-${cur.term}`);
    resetResults();
  }

  // 저장을 마친 뒤(saved) 같은 조합의 다른 후보를 더 담으러 4단계로 되돌아간다.
  // 방금 채운 슬롯을 다시 세도록 slots 를 비운다(afterSave 가 timetables 목록은 이미 갱신했다).
  function backToCandidates() {
    setSaved(null);
    setChosen([]);
    setNames({});
    setConfirming(false);
    setSlots(null);
    setResumed(false);
    setStep(4);
  }

  function addCourse(c) {
    // 기본은 '전부 가능' — 못 듣는 시간·교수는 다음 단계에서 사용자가 끈다.
    setPicked((prev) => [...prev, { code: c.code, offKeys: [], offSecs: [] }]);
    setQuery('');
    resetResults();
  }
  function dropCourse(code) {
    setPicked((prev) => prev.filter((p) => p.code !== code));
    resetResults();
  }
  // 시간 묶음(그 시간 자체) 켜기/끄기
  function toggleGroup(code, key) {
    setPicked((prev) => prev.map((p) => {
      if (p.code !== code) return p;
      const off = p.offKeys.includes(key);
      return { ...p, offKeys: off ? p.offKeys.filter((k) => k !== key) : [...p.offKeys, key] };
    }));
    resetResults();
  }
  // 그 시간 안의 분반(교수) 켜기/끄기
  function toggleSection(code, id) {
    setPicked((prev) => prev.map((p) => {
      if (p.code !== code) return p;
      const off = p.offSecs.includes(id);
      return { ...p, offSecs: off ? p.offSecs.filter((x) => x !== id) : [...p.offSecs, id] };
    }));
    resetResults();
  }
  function setAllGroups(code, on) {
    setPicked((prev) => prev.map((p) => {
      if (p.code !== code) return p;
      const keys = (courses.get(code)?.groups ?? []).map((g) => g.key);
      return { ...p, offKeys: on ? [] : keys, offSecs: on ? [] : p.offSecs };
    }));
    resetResults();
  }

  // 기피 시간 칠하기. 칸 하나씩도 되고, 요일·교시 머리를 누르면 한 줄이 통째로 칠해진다 —
  // 좁은 화면에서 '수요일을 통째로 비우고 싶다'를 여덟 번 두드리게 하면 안 된다.
  function paint(keys) {
    const open = keys.filter((k) => !noClass.has(k));      // 원래 수업이 없는 칸은 칠할 것이 없다
    if (open.length === 0) return;
    setBlocked((prev) => {
      const next = new Set(prev);
      const allOn = open.every((k) => next.has(k));        // 이미 다 칠해져 있으면 지운다
      for (const k of open) { if (allOn) next.delete(k); else next.add(k); }
      return next;
    });
    resetResults();
  }
  const toggleCell = (d, p) => paint([`${d}-${p}`]);
  const toggleDay = (d) => paint(periodNos.map((p) => `${d}-${p}`));
  const togglePeriod = (p) => paint(days.map((d) => `${d}-${p}`));

  function changeSem(v) {
    setSemKey(v);
    setPicked([]);
    setBlocked(new Set());
    setProfPick({});
    setSlots(null);
    setSavedSigs([]);
    setResumeNote(null);
    resetResults();
  }

  const emptyCourses = items.filter((it) => it.options.length === 0);
  const canStep3 = items.length > 0 && emptyCourses.length === 0;

  // ── 후보 고르기 ──────────────────────────────────────────────────────
  // 이름(후보 A·B…)은 고를 때 한 번 붙이고 그대로 둔다. 인덱스로 그때그때 매기면
  // 중간 후보를 빼는 순간 뒤 후보들의 이름이 밀려, 사용자가 고쳐 둔 이름과 순번이 어긋난다.
  function toggleChoose(sig) {
    if (chosen.includes(sig)) {
      setChosen(chosen.filter((s) => s !== sig));
      return;
    }
    if (chosen.length >= maxSave) return;
    setChosen([...chosen, sig]);
    if (!names[sig]) {
      const used = new Set(chosen.map((s) => names[s]).filter(Boolean));
      let i = 0;
      while (used.has(CAND_NAME(i))) i++;
      setNames({ ...names, [sig]: CAND_NAME(i) });
    }
  }

  // ── 저장 → 확정 ──────────────────────────────────────────────────────
  const plan = useMemo(() => {
    const reuse = [...(slots?.empty ?? [])];   // 빈 시간표를 먼저 채우고, 모자라면 새로 만든다
    return chosen.map((sig, i) => {
      const t = reuse.shift();
      return { sig, name: names[sig] ?? CAND_NAME(i), reuse: t ?? null };
    });
  }, [chosen, names, slots]);

  async function save() {
    if (!uid || !sem || plan.length === 0) return;
    setSaving(true);
    setErr('');
    const done = [];
    try {
      for (const p of plan) {
        const combo = view.list.find((c) => c.sig === p.sig);
        if (!combo) continue;
        const name = (p.name || '').trim().slice(0, NAME_MAX) || '내 시간표';
        const chosenSections = combo.groups.map((g) => pickedSection(g));   // 고른 교수의 분반(전체 객체 — 대리키 없음)
        let id = null;
        let created = false;
        try {
          if (p.reuse) {
            // eslint-disable-next-line no-await-in-loop
            await renameTimetable(p.reuse.id, name);
            id = p.reuse.id;
          } else {
            // eslint-disable-next-line no-await-in-loop
            const made = await createTimetable({ uid, year: sem.year, term: sem.term, name });
            id = made.id;
            created = true;
          }
          // eslint-disable-next-line no-await-in-loop
          await addSections(id, chosenSections);
        } catch (e) {
          // 만들기는 됐는데 강의를 못 담았다면 껍데기 시간표를 남기지 않는다 —
          // 남기면 학기당 5칸을 갉아먹고, 재시도할 때마다 빈 시간표가 하나씩 더 쌓인다.
          // eslint-disable-next-line no-await-in-loop
          if (created && id) await deleteTimetable(id).catch(() => {});
          throw e;
        }
        done.push({ id, name, reused: !!p.reuse, sig: p.sig });
      }
      await afterSave(done);
    } catch (e) {
      setErr(
        isOverlapError(e)
          ? '저장 중 겹침이 발생했습니다. 강의 시간이 방금 바뀐 것 같아요 — 새로고침 후 다시 시도하세요.'
          : (e?.message || '저장하지 못했습니다.')
      );
      if (done.length) await afterSave(done);
      else await refreshSlots();
    } finally {
      setSaving(false);
    }
  }

  // 저장 결과를 확정 단계로 넘긴다. 이 학기에 '강의가 담긴 기존 확정'이 있으면
  // 그것을 유지하는 선택지를 함께 준다 — 마법사가 남의 확정을 말없이 끌어내리면
  // 그 시간표로 얻은 강의평·수업메모 자격이 끊긴다.
  async function afterSave(done) {
    // 다 짠 뒤에도 초안은 남긴다(로컬만) — 같은 조합에서 다른 후보를 더 담으러 돌아올 수 있게.
    // 방금 저장한 후보 서명을 적어 두면, 다시 들어왔을 때 '이미 저장함' 배지로 중복 저장을 막는다.
    const sigs = [...new Set([...savedSigs, ...done.map((d) => d.sig).filter(Boolean)])];
    setSavedSigs(sigs);
    writeDraft(uid, { step: 4, semKey, picked, blocked, sortMode, profPick, savedSigs: sigs });
    const list = await listTimetables().catch(() => timetables);
    setTimetables(list);
    const cur = list.find((t) => t.year === sem.year && t.term === sem.term && t.isPrimary);
    const curIsCandidate = cur ? done.some((d) => d.id === cur.id) : false;
    setKeepPrimary(cur && !curIsCandidate ? cur : null);
    setPrimaryId(curIsCandidate ? cur.id : (cur ? null : done[0]?.id ?? null));
    setConfirming(false);
    setSaved(done);
  }

  async function refreshSlots() {
    try {
      const list = await listTimetables();
      setTimetables(list);
      const inSem = list.filter((t) => t.year === sem.year && t.term === sem.term);
      const empty = await findEmptyTimetables(inSem.map((t) => t.id));
      setSlots({ existing: inSem.length, empty: inSem.filter((t) => empty.has(t.id)) });
    } catch { /* 오프라인 — 다음 시도에서 다시 센다 */ }
  }

  async function finish() {
    setSaving(true);
    setErr('');
    try {
      if (primaryId) {
        await setPrimaryTimetable(primaryId);
        selectTimetable(primaryId);   // 방금 마법사로 짠 학기로 이동(명시적)
      }
      // primaryId 가 없으면 기존 확정을 그대로 둔다(아무것도 건드리지 않는다).
      navigate('/');
    } catch (e) {
      setErr(e?.message || '확정 지정에 실패했습니다.');
      setSaving(false);
    }
  }

  // ── 화면 ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="page wizard">
        <header className="page-header row"><BackButton /><h2>시간표 마법사</h2></header>
        <p className="muted center">불러오는 중…</p>
      </div>
    );
  }

  if (saved) {
    return (
      <div className="page wizard">
        <header className="page-header row"><BackButton /><h2>확정 시간표 지정</h2></header>
        <div className="wz-body">
          {err && <p className="error-msg">{err}</p>}
          <p className="wz-lead">
            {saved.length}개를 저장했습니다. 이 학기의 <strong>확정 시간표</strong>를 고르세요.
            <span className="muted"> 강의평·수업메모는 확정 시간표에 담긴 강의만 열립니다.</span>
          </p>
          <ul className="wz-saved">
            {/* 강의가 담긴 기존 확정이 있으면 '그대로 두기'가 기본 — 말없이 끌어내리면
                그 시간표로 얻은 강의평·수업메모 자격이 끊긴다. */}
            {keepPrimary && (
              <li>
                <label className={`wz-saved-row${primaryId === null ? ' is-on' : ''}`}>
                  <input type="radio" name="primary" checked={primaryId === null} onChange={() => setPrimaryId(null)} />
                  <span className="wz-saved-name">기존 확정 유지 — ‘{keepPrimary.name}’</span>
                  <span className="muted">그대로 둠</span>
                </label>
              </li>
            )}
            {saved.map((s) => (
              <li key={s.id}>
                <label className={`wz-saved-row${primaryId === s.id ? ' is-on' : ''}`}>
                  <input type="radio" name="primary" checked={primaryId === s.id} onChange={() => setPrimaryId(s.id)} />
                  <span className="wz-saved-name">{s.name}</span>
                  <span className="muted">{sem?.year}-{sem?.term}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="account-note">확정은 나중에 홈의 시간표 드롭다운에서 언제든 바꿀 수 있습니다.</p>
        </div>

        <div className="wz-bar">
          <div className="wz-bar-row">
            <button className="btn-add btn-block" disabled={saving || (!primaryId && !keepPrimary)} onClick={finish}>
              {saving ? '지정 중…' : primaryId ? '★ 확정하고 홈으로' : '확정은 그대로 두고 홈으로'}
            </button>
          </div>
          {/* 같은 조합에서 후보를 더 담고 싶을 때 — 홈에 나갔다 오지 않고 4단계로 되돌아간다(초안은 남아 있다) */}
          <div className="wz-bar-row">
            <button className="btn-ghost btn-block" disabled={saving} onClick={backToCandidates}>
              ↩ 다른 후보 더 보기
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page wizard">
      <header className="page-header row">
        <BackButton />
        <h2>시간표 마법사</h2>
      </header>

      <ol className="wz-steps">
        {STEPS.map((s, i) => (
          <li key={s} className={`wz-step${step === i + 1 ? ' is-on' : ''}${step > i + 1 ? ' is-done' : ''}`}>
            <span className="wz-step-n">{i + 1}</span>
            <span className="wz-step-t">{s}</span>
          </li>
        ))}
      </ol>

      <div className="wz-body">
        {err && <p className="error-msg">{err}</p>}

        {/* 되살렸다는 사실은 알려야 한다 — 말없이 채워 두면 '내가 언제 이걸 담았지?' 가 된다.
            손을 대는 순간(단계 이동·과목 추가…) 사라진다. */}
        {resumed && (
          <>
            <div className="wz-resume">
              <p className="wz-resume-t">
                💾 {savedSigs.length > 0
                  ? '이전에 저장한 조합을 불러왔습니다 — 같은 조합에서 다른 후보를 더 담을 수 있어요.'
                  : '짜다 만 것을 불러왔습니다 — 담은 과목·분반·기피 시간이 그대로입니다.'}
              </p>
              <button className="btn-ghost btn-sm" onClick={startOver}>새로 시작</button>
            </div>
            {resumeNote?.dropped?.length > 0 && (
              <p className="wz-warn wz-resume-warn">
                ⚠️ 수업정보가 바뀌어 뺀 과목: {resumeNote.dropped.join(', ')} — 남은 과목으로 후보를 다시 만듭니다.
              </p>
            )}
          </>
        )}

        {/* ── 1. 과목 담기 ─────────────────────────────────────────────── */}
        {step === 1 && (
          <>
            <label className="field wz-sem">
              <span className="field-label">학기</span>
              <select value={semKey} onChange={(e) => changeSem(e.target.value)}>
                {semesters.map((s) => (
                  <option key={`${s.year}-${s.term}`} value={`${s.year}-${s.term}`}>
                    {s.year}-{s.term}학기{s.isCurrent ? ' (이번)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <p className="wz-lead">들어야 하는 과목을 모두 담으세요. 분반은 다음 단계에서 고릅니다.</p>

            <div className="search-bar">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="과목명 · 과목코드 · 교수명 검색"
              />
            </div>

            {q && (
              found.length === 0 ? (
                <div className="empty"><span className="empty-emoji">🔍</span>검색 결과가 없습니다.</div>
              ) : (
                <ul className="wz-find">
                  {found.map((c) => (
                    <li key={c.code} className="wz-find-row">
                      <div className="wz-find-body">
                        <p className="wz-find-name">{c.name}</p>
                        <p className="wz-find-sub">
                          {c.code} · 분반 {c.sections.length}개
                          {c.sections.length > c.groups.length && ` (시간 ${c.groups.length}가지)`}
                        </p>
                      </div>
                      <button className="btn-add btn-sm" onClick={() => addCourse(c)}>＋ 담기</button>
                    </li>
                  ))}
                </ul>
              )
            )}

            <h3 className="section-label">담은 과목 {items.length > 0 && `(${items.length})`}</h3>
            {items.length === 0 ? (
              <div className="empty">
                <span className="empty-emoji">📚</span>
                아직 담은 과목이 없습니다. 위에서 검색해 담으세요.
              </div>
            ) : (
              <ul className="wz-picked">
                {items.map((it) => (
                  <li key={it.course.code} className="wz-picked-row">
                    <span className="wz-dot" style={{ background: colorOf(it.course.code) }} aria-hidden="true" />
                    <div className="wz-find-body">
                      <p className="wz-find-name">{it.course.name}</p>
                      <p className="wz-find-sub">{it.course.code} · 분반 {it.course.sections.length}개</p>
                    </div>
                    <button className="btn-remove btn-sm" onClick={() => dropCourse(it.course.code)}>제거</button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {/* ── 2. 분반(시간·교수) 고르기 ─────────────────────────────────── */}
        {step === 2 && (
          <>
            <p className="wz-lead">
              <strong>들을 수 있는 것만 켜세요.</strong> 켠 것만 후보에 들어갑니다 —
              끈 분반은 어떤 시간표에도 임의로 들어가지 않습니다.
              <span className="muted"> 같은 시간에 교수만 다른 분반은 한 줄로 묶었습니다(시간표가 똑같으니까).
                교수는 후보를 고른 뒤 4단계에서 정합니다.</span>
            </p>

            {/* 카탈로그는 학교 공지를 옮겨 담은 것이라 실제와 다를 수 있다 — 고치는 길을 함께 알려 준다 */}
            <p className="cor-notice">
              ⚠️ 강의 정보(시간·강의실·교수)가 실제와 다를 수 있습니다.
              틀린 곳이 보이면 그 분반의 <b>🚩</b> 를 눌러 알려 주세요.
            </p>

            {roughCount > BUSY_HINT && (
              <p className="wz-hint">
                지금 켠 분반으로는 경우의 수가 <strong>{roughCount.toLocaleString()}가지</strong>입니다.
                못 듣는 분반을 꺼 둘수록 더 나은 후보가 위로 올라옵니다.
              </p>
            )}

            <ul className="wz-courses">
              {items.map((it) => {
                const all = it.course.groups;
                const n = it.options.length;                                  // 켠 시간 묶음 수
                const allSecs = it.course.sections.length;                    // 이 과목의 분반 총수
                const onSecs = it.options.reduce((k, g) => k + g.sections.length, 0);   // 켠 분반 수
                return (
                  <li key={it.course.code} className={`wz-course${n === 0 ? ' is-bad' : ''}`}>
                    <div className="wz-course-head">
                      <span className="wz-dot" style={{ background: colorOf(it.course.code) }} aria-hidden="true" />
                      <span className="wz-course-name">{it.course.name}</span>
                      <span className={`wz-count${onSecs < allSecs ? ' is-narrow' : ''}`}>
                        분반 {onSecs}/{allSecs}
                      </span>
                      <span className="wz-course-ops">
                        <button className="link-btn" onClick={() => setAllGroups(it.course.code, true)}>모두</button>
                        <button className="link-btn" onClick={() => setAllGroups(it.course.code, false)}>해제</button>
                      </span>
                    </div>

                    <ul className="wz-secs">
                      {all.map((g) => {
                        const on = !it.offKeys.has(g.key);
                        const many = g.sections.length > 1;
                        // 분반 번호가 먼저다 — 사람은 '몇 분반'으로 강의를 고른다.
                        // 같은 시간에 교수만 다르면 그 분반들을 함께 적는다(1·2·3분반).
                        const nos = g.sections.map((s) => s.sectionNo).join('·');
                        return (
                          <li key={g.key}>
                            <div className="wz-sec-row">
                              <label className={`wz-sec${on ? ' is-on' : ''}`}>
                                <input type="checkbox" checked={on} onChange={() => toggleGroup(it.course.code, g.key)} />
                                <span className="wz-sec-body">
                                  <span className="wz-sec-top">
                                    <span className="wz-sec-no">{nos}분반</span>
                                    <span className="wz-sec-prof">
                                      {many
                                        ? `교수 ${g.sections.length}명`
                                        : (g.sections[0].professorName ?? '교수 미정')}
                                    </span>
                                  </span>
                                  <span className="wz-sec-time">{formatTimes(g.times)}</span>
                                </span>
                              </label>
                              {/* 제안 대상은 분반 하나다 — 교수가 여럿인 묶음은 아래 교수 줄마다 🚩 를 둔다.
                                  버튼은 라벨 밖에 둔다(안에 두면 누를 때 체크박스가 같이 토글된다). */}
                              {!many && (
                                <button
                                  type="button"
                                  className="cor-flag-btn wz-flag"
                                  aria-label={`${nos}분반 정보 수정 제안`}
                                  onClick={() => openCorr(g.sections[0])}
                                >
                                  🚩
                                </button>
                              )}
                            </div>

                            {/* 같은 시간에 교수가 여럿이면, 못 듣는 교수를 여기서 끈다.
                                (기본은 전부 켜짐 — 후보에는 교수와 무관하게 이 시간이 한 번만 나온다) */}
                            {on && many && (
                              <ul className="wz-profs">
                                {g.sections.map((s) => {
                                  const pon = !it.offSecs.has(s.id);
                                  return (
                                    <li key={s.id}>
                                      <label className={`wz-prof${pon ? ' is-on' : ''}`}>
                                        <input
                                          type="checkbox"
                                          checked={pon}
                                          onChange={() => toggleSection(it.course.code, s.id)}
                                        />
                                        <span>{s.sectionNo}분반 {s.professorName ?? '교수 미정'}</span>
                                      </label>
                                      <button
                                        type="button"
                                        className="cor-flag-btn wz-flag"
                                        aria-label={`${s.sectionNo}분반 정보 수정 제안`}
                                        onClick={() => openCorr(s)}
                                      >
                                        🚩
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>

                    {n === 0 && <p className="wz-warn">분반을 하나 이상 켜거나, 이 과목을 빼세요.</p>}
                    {onSecs > 0 && onSecs < allSecs && (
                      <p className="wz-note">
                        {it.options.flatMap((g) => g.sections.map((s) => s.sectionNo)).sort((a, b) => a - b).join('·')}분반만 사용합니다.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {/* ── 3. 조건(기피 시간 · 정렬) ─────────────────────────────────── */}
        {step === 3 && (
          <>
            <p className="wz-lead">
              비우고 싶은 시간을 칠하세요(선택). 그 시간을 쓰는 분반은 후보에서 빠집니다.
              <span className="muted"> 요일·교시 머리를 누르면 그 줄이 통째로 칠해집니다.</span>
            </p>

            <div className="wz-block-wrap">
              <table className="wz-block">
                <thead>
                  <tr>
                    <th className="wz-mini-corner" />
                    {days.map((d) => (
                      <th key={d}>
                        <button type="button" className="wz-block-head" onClick={() => toggleDay(d)}>
                          {dayLabel(d)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {periodNos.map((p) => (
                    <tr key={p}>
                      <th className="wz-mini-p">
                        <button type="button" className="wz-block-head" onClick={() => togglePeriod(p)}>{p}</button>
                      </th>
                      {days.map((d) => {
                        const free = noClass.has(`${d}-${p}`);
                        const on = blocked.has(`${d}-${p}`);
                        const label = blockLabel[`${d}-${p}`];
                        return (
                          <td key={d}>
                            <button
                              type="button"
                              className={`wz-block-cell${on ? ' is-on' : ''}${free ? ' is-noclass' : ''}`}
                              disabled={free}
                              aria-pressed={on}
                              title={free ? (label ?? '수업 없는 시간') : undefined}
                              aria-label={
                                free
                                  ? `${dayLabel(d)}요일 ${p}교시 ${label ?? '수업 없는 시간'}`
                                  : `${dayLabel(d)}요일 ${p}교시 ${on ? '피함' : '가능'}`
                              }
                              onClick={() => toggleCell(d, p)}
                            >
                              {free && label && <span className="wz-block-label">{label}</span>}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="wz-block-legend">
              <span><i className="wz-key is-on" />피할 시간</span>
              <span><i className="wz-key is-noclass" />수업 없는 시간</span>
              {blocked.size > 0 && (
                <button className="link-btn wz-clear" onClick={() => { setBlocked(new Set()); resetResults(); }}>
                  모두 지우기
                </button>
              )}
            </div>

            {noClass.size > 0 && (
              <p className="wz-note">
                빗금 친 칸은 이 학기에 개설된 강의가 하나도 없는 시간입니다(생도대·군사훈련·자율선택형교과 등).
                칠할 것이 없어 누를 수 없고, 빈 시간으로도 세지 않습니다.
              </p>
            )}

            <div className="wz-sortbox">
              <p className="wz-sort-label">어떤 시간표를 위로 올릴까요?</p>
              <div className="wz-sorts">
                {Object.entries(SORTS).map(([k, v]) => (
                  <label key={k} className={`wz-sort${sortMode === k ? ' is-on' : ''}`}>
                    <input type="radio" name="sort" checked={sortMode === k} onChange={() => setSortMode(k)} />
                    <span>{v.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── 4. 후보 → 저장 ───────────────────────────────────────────── */}
        {step === 4 && view && (
          <>
            {raw.impossible.length > 0 ? (
              <div className="empty">
                <span className="empty-emoji">🚫</span>
                <p><strong>{raw.impossible.join(', ')}</strong> — 칠한 기피 시간 때문에 쓸 수 있는 시간이 남지 않았습니다.</p>
                <span className="muted">기피 시간을 줄이거나 분반을 더 켜세요.</span>
              </div>
            ) : view.list.length === 0 ? (
              <div className="empty">
                <span className="empty-emoji">🧩</span>
                <p>고른 분반으로는 <strong>겹치지 않는 조합이 없습니다.</strong></p>
                {raw.pairs.length > 0 && (
                  <ul className="wz-pairs">
                    {raw.pairs.map(([a, b]) => (
                      <li key={`${a}-${b}`}>‘{a}’ 와 ‘{b}’ 는 지금 켠 분반으로는 함께 들을 수 없습니다.</li>
                    ))}
                  </ul>
                )}
                <span className="muted">분반을 더 켜거나, 과목을 하나 빼 보세요.</span>
              </div>
            ) : (
              <>
                <p className="wz-lead">
                  겹치지 않는 조합 <strong>{raw.combos.length.toLocaleString()}개</strong>
                  {raw.truncated && '+'} 중에서, <strong>서로 성격이 다른 {view.list.length}개</strong>를 골랐습니다.
                  <span className="muted"> ({SORTS[sortMode].label}) 마음에 드는 것을 눌러 저장 목록에 담으세요.</span>
                </p>

                {raw.blockedOut.length > 0 && (
                  <p className="wz-note">
                    기피 시간 때문에 제외된 분반: {raw.blockedOut.map((b) => `${b.name} ${b.n}개`).join(', ')}
                  </p>
                )}
                {slots && slots.existing >= MAX_PER_SEM && slots.empty.length === 0 && (
                  <p className="wz-warn">
                    이 학기 시간표가 이미 {MAX_PER_SEM}개입니다(상한). 홈에서 쓰지 않는 시간표를 지우고 다시 오세요.
                  </p>
                )}

                <ul className="wz-cands">
                  {view.list.map((c, i) => {
                    const on = chosen.includes(c.sig);
                    const full = !on && chosen.length >= maxSave;
                    const manyProf = c.groups.some((g) => g.sections.length > 1);
                    const already = savedSigs.includes(c.sig);   // 이 조합은 이미 저장한 적이 있다
                    return (
                      <li key={c.sig} className={`wz-cand${on ? ' is-on' : ''}`}>
                        <button
                          type="button"
                          className="wz-cand-head"
                          aria-pressed={on}
                          disabled={full || maxSave === 0}
                          onClick={() => toggleChoose(c.sig)}
                        >
                          <span className="wz-cand-rank">#{i + 1}</span>
                          {already && <span className="wz-cand-saved">이미 저장함</span>}
                          <CandChips stats={c.stats} />
                          <span className={`wz-cand-box${on ? ' is-on' : ''}`} aria-hidden="true">
                            {on ? '✓' : '＋'}
                          </span>
                        </button>

                        <MiniGrid
                          groups={c.groups}
                          picked={pickedSection}
                          periodNos={periodNos}
                          days={days}
                          colorOf={colorOf}
                          fg={pal.fg}
                          noClass={noClass}
                          blockLabel={blockLabel}
                        />

                        {on && <p className="wz-cand-tag">저장 목록에 담김 — ‘{names[c.sig]}’</p>}

                        {/* 담을 분반 — 접어 둔다. 카드마다 펼쳐 두면 20개가 끝없이 길어진다.
                            같은 시간에 교수가 여럿이면 여기서 고른다(시간표 그림은 그대로). */}
                        <details className="wz-cand-more">
                          <summary>
                            담긴 분반 {c.groups.length}개{manyProf ? ' · 교수 고르기' : ''}
                          </summary>
                          <ul className="wz-cand-secs">
                            {c.groups.map((g) => {
                              const code = g.sections[0].courseCode;
                              const cur = pickedSection(g);
                              return (
                                <li key={g.key}>
                                  <span className="wz-dot" style={{ background: colorOf(code) }} aria-hidden="true" />
                                  <span className="wz-cand-course">{g.sections[0].courseName}</span>
                                  <span className="wz-cand-time">{formatTimes(g.times)}</span>
                                  {g.sections.length > 1 ? (
                                    <select
                                      className="wz-prof-pick"
                                      value={cur.id}
                                      onChange={(e) =>
                                        setProfPick((prev) => ({ ...prev, [pickKey(code, g.key)]: e.target.value }))
                                      }
                                    >
                                      {g.sections.map((s) => (
                                        <option key={s.id} value={s.id}>
                                          {s.sectionNo}분반 · {s.professorName ?? '교수 미정'}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span className="muted">
                                      {cur.sectionNo}분반 · {cur.professorName ?? '교수 미정'}
                                    </span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                          {c.stats.unscheduled > 0 && (
                            <p className="wz-note">강의시간이 없는 분반 {c.stats.unscheduled}개 — 격자에 표시되지 않습니다.</p>
                          )}
                        </details>
                      </li>
                    );
                  })}
                </ul>

                <p className="account-note">
                  <strong>낀시간</strong> = 수업과 수업 사이에 뜨는 교시. 하루의 맨 앞·맨 뒤가 비는 것은
                  오전·오후 공강으로 따로 셉니다. 다른 후보를 보려면 3단계에서 조건을 바꾸세요.
                </p>
              </>
            )}
          </>
        )}
      </div>

      {/* 하단 조작부 — 화면에 붙어 따라온다. 후보 20장 밑까지 스크롤해야 '다음'을 누를 수 있으면
          단계를 넘길 때마다 손가락이 화면을 두 번 훑어야 한다. */}
      <div className="wz-bar">
        {step === 4 && view && view.list.length > 0 && (
          <p className="wz-bar-note">
            {chosen.length > 0
              ? `${chosen.length}개 선택됨 · 최대 ${maxSave}개`
              : `저장할 후보를 고르세요 · 최대 ${maxSave}개`}
          </p>
        )}
        <div className="wz-bar-row">
          {step > 1 && (
            <button className="btn-ghost wz-bar-back" onClick={() => goStep(step - 1)}>이전</button>
          )}
          {step === 1 && (
            <button className="btn-add" disabled={items.length === 0} onClick={() => goStep(2)}>
              다음 — 분반 고르기
            </button>
          )}
          {step === 2 && (
            <button className="btn-add" disabled={!canStep3} onClick={() => goStep(3)}>다음 — 조건</button>
          )}
          {step === 3 && (
            <button className="btn-add" onClick={() => goStep(4)}>후보 만들기</button>
          )}
          {step === 4 && (
            <button className="btn-add" disabled={chosen.length === 0} onClick={() => setConfirming(true)}>
              {chosen.length > 0 ? `${chosen.length}개 저장하기` : '저장하기'}
            </button>
          )}
        </div>
      </div>

      {/* 저장 확인 — 앱의 다른 대화상자와 같은 관례(가운데 오버레이, z-index 200) */}
      {confirming && (
        <div className="wz-overlay" onClick={() => { if (!saving) setConfirming(false); }}>
          <div className="wz-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3>이렇게 저장합니다</h3>
            <ul className="wz-plan">
              {plan.map((p) => (
                <li key={p.sig}>
                  <input
                    className="wz-plan-name"
                    maxLength={NAME_MAX}
                    value={p.name}
                    onChange={(e) => setNames((prev) => ({ ...prev, [p.sig]: e.target.value }))}
                  />
                  <span className="wz-plan-how">
                    {p.reuse ? `비어 있던 ‘${p.reuse.name}’ 을 채웁니다` : '새 시간표를 만듭니다'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="account-note">
              강의가 담긴 기존 시간표는 건드리지 않습니다. 저장한 뒤 확정 시간표를 고릅니다.
            </p>
            {err && <p className="error-msg">{err}</p>}
            <div className="wz-nav-row">
              <button className="btn-ghost" disabled={saving} onClick={() => setConfirming(false)}>취소</button>
              <button className="btn-add" disabled={saving} onClick={save}>
                {saving ? '저장 중…' : '저장하고 확정 고르기'}
              </button>
            </div>
          </div>
        </div>
      )}

      {corr && (
        <CorrectionModal subject={corr.subject} options={corr.options} onClose={() => setCorr(null)} />
      )}
    </div>
  );
}
