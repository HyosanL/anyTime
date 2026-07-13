// 교수 이름 동일인 판정 — 일괄등록(CSV·편람)과 관리자 '교수 통합'이 같은 기준을 쓴다.
//
// 왜 필요한가: 일괄등록은 이름 문자열만 보고 기존 교수를 찾는다. 그래서 같은 사람이
// 두 벌로 생긴다 — 실제로 겪은 것들:
//   · "Justin" / "Justin Bunting"  (파일에 성이 빠짐)
//   · "유 훈"  / "유훈"            (외자 이름이라 편람 PDF 가 성과 이름을 띄워 씀)
//   · 대소문자만 다른 영문 이름
// 이 셋을 '같은 사람일 수 있다'로 보고, 확실한 것(공백·대소문자 차이)은 자동으로 묶고
// 애매한 것(짧은 이름)은 사람이 확인하게 한다.

// 공백·대소문자를 지운 비교용 키. "유 훈" → "유훈", "Justin Bunting" → "justinbunting"
export const profKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

// 사람 이름이 아니라 '아직 정해지지 않았다'는 표시. 강의 파일의 담당교수 칸에 이렇게 적혀 오면
// 교수를 만들지 말고 '교수 미정'(professor_code = NULL)으로 두어야 한다 —
// 안 그러면 "신임교수" 같은 가짜 교수가 생겨 교수 검색·강의평에 사람처럼 나온다.
// 반드시 이름 '전체'가 일치할 때만 자리표시자로 본다 — 부분일치로 걸렀다간
// 김'미정' 교수님이 사라진다.
const PLACEHOLDERS = new Set([
  '미정', '교수미정', '담당미정', '담당교수미정', '미배정', '미상', '미지정',
  '추후', '추후공지', '추후지정', '신임', '신임교수', '신규임용', '초빙',
  '없음', '공란', '해당없음', 'tba', 'tbd', 'n/a', 'na', '-', '--', '.',
]);
export const isPlaceholderProf = (name) => {
  const k = profKey(name);
  return !k || PLACEHOLDERS.has(k);
};

const toks = (s) => String(s || '').toLowerCase().split(/\s+/).filter(Boolean);

// a 가 b 의 '짧은 판'인가 — 즉 a 를 보고 b 를 떠올릴 수 있는가.
// a 의 토큰 하나하나가 b 의 서로 다른 토큰의 '앞부분'이고, a 쪽이 어딘가 덜 적혀 있으면 참이다.
//   "Justin"      ⊂ "Justin Bunting"   (성이 빠짐)
//   "Bunting"     ⊂ "Justin Bunting"   (이름이 빠짐)
//   "Dan"         ⊂ "Daniel Kingyens"  (애칭 — 실제로 같은 교수였다)
//   "Dan Kingyens"⊂ "Daniel Kingyens"
//   "유훈"        ⊂ "유훈경"           (한글은 토큰이 하나뿐 → 앞자리 비교)
// 이름이 완전히 같으면 거짓이다 — 그건 profKey 가 판정한다.
// 판정이 아니라 '의심'이다. 애칭·앞자리는 남남일 수도 있으니(김민 / 김민수)
// 호출부에서 반드시 사람이 확인하게 할 것.
const isPrefixTok = (a, b) => a === b || (a.length >= 2 && b.startsWith(a));

export function isSubName(a, b) {
  const ta = toks(a);
  const tb = toks(b);
  if (!ta.length || !tb.length || ta.length > tb.length) return false;
  const used = new Set();
  let shorter = ta.length < tb.length;   // 토큰 수가 적으면 그것만으로 '짧은 판'
  for (const t of ta) {
    const j = tb.findIndex((u, i) => !used.has(i) && isPrefixTok(t, u));
    if (j < 0) return false;
    used.add(j);
    if (t !== tb[j]) shorter = true;     // 앞부분만 적힌 토큰이 있다
  }
  return shorter;
}

// 같은 사람으로 의심되는 교수 묶음. [{code,name,…}] → [[교수,교수,…], …] (2명 이상인 묶음만)
// 서로 이어지는 것끼리 한 묶음으로 합친다("유 훈"–"유훈"–"유훈 " 처럼 셋 이상도 한 번에).
// 자리표시자("신임교수" …)는 뺀다 — 합칠 대상이 아니라 지울 대상이라 따로 다룬다.
export function dupProfessorGroups(professors) {
  const list = (professors ?? []).filter((p) => !isPlaceholderProf(p.name));
  const parent = new Map(list.map((p) => [p.code, p.code]));
  const find = (c) => {
    let r = c;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(c) !== r) { const nx = parent.get(c); parent.set(c, r); c = nx; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (profKey(a.name) === profKey(b.name) || isSubName(a.name, b.name) || isSubName(b.name, a.name)) {
        union(a.code, b.code);
      }
    }
  }
  const groups = new Map();
  for (const p of list) {
    const r = find(p.code);
    (groups.get(r) ?? groups.set(r, []).get(r)).push(p);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    // 이름이 완전한(긴) 쪽을 앞에 — 보통 그게 남길 교수다
    .map((g) => [...g].sort((a, b) => (b.name || '').length - (a.name || '').length))
    .sort((a, b) => (a[0].name || '').localeCompare(b[0].name || '', 'ko'));
}
