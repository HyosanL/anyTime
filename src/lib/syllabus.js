// 강의 PDF/HWP → 구조화 → 기존 DB 대조 플랜 → 적용.
// 흐름: pdf.js·hwp.js(브라우저)로 페이지(또는 그에 준하는) 텍스트 추출 → /api/parse-syllabus(Gemini)로 구조화
//      → reconcile(기존 catalog와 대조: 과목 병합/교수 매칭·동명이인) → admin-action 으로 적용.
// 무거운 pdfjs 는 이 모듈을 동적 import 하는 관리자 화면에서만 로드된다.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from '../firebase';
import { parseGridsOnPage, toItems, universalBlocks, crossCheck, fixColumnBleed } from './grid';
import { profKey, isSubName, isPlaceholderProf } from './profname';
import { extractHwp } from './hwp';
import { isFillableSection } from './syllabusPlan';

export { isFillableSection };

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const DAY_KO = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7 };

// ---------- PDF → 페이지별 텍스트 + 주간 격자 ----------
// 같은 y좌표 아이템들을 x순으로 이어붙여 한 줄로 만든다(위→아래, 왼→오 순).
function itemsToLines(items) {
  const lines = {};
  for (const it of items) {
    const y = Math.round(it.y);
    (lines[y] ??= []).push(it);
  }
  return Object.keys(lines)
    .map(Number)
    .sort((a, b) => b - a)
    .map((y) => lines[y].sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// 편람의 '학년별 시간표'(세부 과목-분반 표) 페이지는 종종 서로 다른 반 묶음의 표 두 개를
// 나란히(좌/우) 인쇄한다("1학년 이·공학(5~8반)" 표와 "(9~12반)" 표가 한 페이지에 함께
// 실리는 식). pageToText 는 페이지 전체를 y좌표 하나로만 줄을 나누는데, 나란히 놓인 두
// 표의 행이 같은 y대에 있으면 서로 다른 표의 글자가 한 줄로 섞여 붙는다(실측: 26-2 학위
// 교육운영계획서 세부표 페이지에서 "담당교수" 머리글이 x≈288 과 x≈708 두 자리에 각각
// 찍혀 있었고 그 사이 여러 과목·교수·교시가 뒤섞여 있었다 — findProfConflicts 오탐과
// "이 파일에 없는 기존 분반" 오탐의 실제 원인이었다). 표 머리글 "담당교수"가 페이지에
// 몇 번, 어느 x에 찍혔는지로 표가 몇 개 나란히 있는지 찾아 그 사이 중점을 경계로 x구간을
// 나누고, 구간별로 따로 줄을 만든 뒤 왼쪽→오른쪽 순서로 이어붙인다. 표가 하나뿐인
// 페이지(대다수, 이 문서 기준 수강신청 안내자료 전 페이지 포함)는 경계가 하나도 안 생겨
// 기존 동작 그대로다.
// 표가 세로로 여러 개(국관 표 다음에 인공지능 표, 그다음 시스템 표…) 이어질 때도 "담당교수"가
// 페이지에 여러 번 찍힌다 — 이때는 다들 거의 같은 x(실측 10pt 안쪽 오차)라 나란한 게 아니라
// 같은 세로줄이 반복된 것뿐이다. 진짜 좌/우 분할(실측 ~420pt 간격)과 구분하려고 이 폭보다
// 가까운 x들은 한 다발로 묶는다 — 묶고 나서 다발이 하나뿐이면 분할하지 않는다(기존 동작 유지).
const MIN_COLUMN_GAP = 150;
function clusterXs(xs) {
  const clusters = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.last < MIN_COLUMN_GAP) last.last = x;
    else clusters.push({ first: x, last: x });
  }
  return clusters.map((c) => (c.first + c.last) / 2);
}

function pageToText(tc) {
  const items = tc.items.filter((it) => it.str).map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str }));
  const rawXs = items.filter((it) => it.s.includes('담당교수')).map((it) => it.x).sort((a, b) => a - b);
  const headerXs = clusterXs(rawXs);
  if (headerXs.length < 2) return itemsToLines(items);

  const bounds = [-Infinity];
  for (let i = 1; i < headerXs.length; i++) bounds.push((headerXs[i - 1] + headerXs[i]) / 2);
  bounds.push(Infinity);

  const bands = headerXs.map(() => []);
  for (const it of items) {
    let idx = bands.length - 1;
    for (let i = 0; i < bounds.length - 1; i++) {
      if (it.x >= bounds[i] && it.x < bounds[i + 1]) { idx = i; break; }
    }
    bands[idx].push(it);
  }
  return bands.map(itemsToLines).filter(Boolean).join('\n');
}

// 페이지 텍스트(AI 로 보낼 것)와 주간 격자(좌표로 직접 읽는 것)를 한 번의 순회로 모은다.
// 격자는 AI 를 부르지 않는다 — 전 생도 공통 비수업 시간과 교차검증의 근거가 공짜로 나온다.
export async function extractPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  const grids = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);            // eslint-disable-line no-await-in-loop
    const tc = await page.getTextContent();       // eslint-disable-line no-await-in-loop
    pages.push(pageToText(tc));
    grids.push(...parseGridsOnPage(toItems(tc))); // 격자가 아니면 아무것도 안 나온다
  }
  return { pages, grids };
}

export function isHwpFile(file) {
  return /\.hwp$/i.test(file?.name || '');
}

// HWP 는 PDF와 달리 페이지 경계가 없다(섹션 하나가 문서 전체만큼 길 수 있음). Gemini 호출을
// PDF 페이지만한 크기로 유지하려고(캐시 단위·문맥 길이 둘 다) 문단 줄바꿈 기준으로 다시 자른다.
// 서버가 12000자에서 텍스트를 자르므로(functions/api/parse-syllabus.js) 그보다 넉넉히 작게 잡는다.
function chunkText(text, maxLen = 6000) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > maxLen) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
    if (cur.length > maxLen) { chunks.push(cur); cur = ''; } // 한 줄 자체가 길면 그대로 끊는다
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// ---------- Gemini 파싱 호출 ----------
async function authHeader() {
  const user = auth.currentUser;
  return user ? `Bearer ${await user.getIdToken()}` : '';
}

// 실패해도 나머지 페이지는 계속 파싱하되, 사유는 버리지 않고 { rows, error } 로 돌려준다.
// (에러를 삼키면 "추출된 과목이 없습니다"처럼 PDF 탓으로 오인되는 메시지만 남는다.)
const PARSE_ERRORS = {
  NO_GEMINI_KEY: 'GEMINI_API_KEY 가 배포에 없습니다. Pages 프로젝트 Secret 에 추가하고 재배포하세요.',
  FORBIDDEN: '관리자 권한이 필요합니다.',
  UNAUTH: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
};

// ---------- 파싱 결과 캐시 ----------
// 같은 PDF 를 다시 올리면(실패 후 재시도·설정만 바꿔 재실행) 페이지 텍스트가 그대로라
// Gemini 를 다시 부를 이유가 없다. 캐시가 없던 탓에 재시도 몇 번으로 무료 한도를 태웠다.
// 키에 모델을 넣는다 — GEMINI_MODEL 을 바꿨는데 옛 모델의 결과를 물려받으면 안 된다.
// 프롬프트·스키마를 고치면 CACHE_V 를 올려 통째로 무효화한다.
//   3: 프롬프트 수정(영역/학과 열을 과목명에 붙이지 말 것) + 모델 교체(2026-07-13)
//   4: 프롬프트 수정(압축 교반 "1,2,3(수4) 4,5,6(목1)…" 펼치기 + 교수 이름 순환 대응) (2026-07-13)
//   5: 프롬프트 수정("제2외국어" 뒤 숫자는 분반이 아니라 과목명의 일부) (2026-09-01)
//   6: 프롬프트 수정(학년별 시간표 세부표 열형식 예시 + 세로글자 라벨 조각 무시 규칙 추가) (2026-09-01)
//   7: 프롬프트 수정(다글자 영역/구분 라벨 조각 "군사학"/"필수" 무시 + "과목명+숫자(괄호)"
//      규칙을 제2외국어 전용에서 일반 규칙으로 확장, 창의공학설계실습류 예시 추가) (2026-09-01)
//   8: 프롬프트 수정(숫자+괄호 규칙을 "괄호 없는 학점 숫자"와 구분 + 라벨 조각을 다른
//      과목명과 이어붙여 가짜 과목을 지어내지 말라는 규칙 추가) (2026-09-01)
const CACHE_V = 8;
const CACHE_PREFIX = 'syllabus-parse:';

async function cacheKey(model, kind, text) {
  const buf = new TextEncoder().encode(`${CACHE_V}|${model}|${kind}|${text}`);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return CACHE_PREFIX + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cacheGet = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };

// 용량 초과 시엔 낡은 항목(옛 모델·옛 CACHE_V)이 쌓인 것이므로 싹 비우고 한 번만 재시도한다.
// 그래도 안 되면 캐시를 포기할 뿐, 파싱 자체는 막지 않는다.
const cacheSet = (k, rows) => {
  const v = JSON.stringify(rows);
  try { localStorage.setItem(k, v); } catch {
    try { clearParseCache(); localStorage.setItem(k, v); } catch { /* 있으면 좋고 없어도 그만 */ }
  }
};

export function clearParseCache() {
  for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
}

// 서버에 설정된 모델명을 묻는다. 캐시 키에 넣기 위한 것이고, Gemini 는 부르지 않아 공짜다.
async function currentModel(token) {
  try {
    const res = await fetch('/api/parse-syllabus', { headers: { Authorization: token } });
    return (await res.json())?.model || 'unknown';
  } catch { return 'unknown'; }
}

async function callParse(model, kind, text, token, useCache) {
  const key = await cacheKey(model, kind, text);
  if (useCache) {
    const hit = cacheGet(key);
    if (hit) return { rows: hit, cached: true };
  }
  try {
    const res = await fetch('/api/parse-syllabus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ kind, text }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const known = PARSE_ERRORS[j.status];
      return { rows: [], error: known || j.detail || `AI 파싱 실패 (HTTP ${res.status})` };
    }
    const rows = Array.isArray(j.rows) ? j.rows : [];
    cacheSet(key, rows); // 성공만 캐시한다 — 에러를 캐시하면 영영 실패한 채로 굳는다.
    return { rows };
  } catch (e) {
    return { rows: [], error: `AI 파싱 요청 실패: ${e?.message || e}` };
  }
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- 정규화 ----------
const cleanName = (s) => String(s || '').replace(/\s+/g, '').trim();
const cleanProf = (s) => {
  const first = String(s || '').split(/[,，]/)[0]; // 팀티칭이면 대표 1명
  const n = first.replace(/\s+/g, ' ').trim(); // 공백 축약(제거 아님) — 영문 이름 "Dan Kingyens" 유지
  // "신임교수"·"미정" 은 사람이 아니라 '아직 없다'는 표시다. 교수로 만들면 가짜 교수가
  // 교수 검색·강의평에 사람처럼 나온다 — 교수 미정(NULL)으로 둔다.
  if (!n || isPlaceholderProf(n)) return null;
  return n;
};

function normRow(r) {
  const course = cleanName(r.course);
  const sectionNo = Number(r.sectionNo) || 1;
  if (!course) return null;
  const times = Array.isArray(r.times)
    ? r.times
        .map((t) => ({ day: Number(t.day) || DAY_KO[String(t.day)] || 0, period: Number(t.period) || 0 }))
        .filter((t) => t.day >= 1 && t.day <= 7 && t.period >= 1)
    : [];
  return {
    course,
    sectionNo,
    professor: cleanProf(r.professor),
    department: r.department ? String(r.department).trim() : null,
    times,
    room: r.room ? String(r.room).trim() : null,
  };
}

// 연속 교시를 한 블록으로 묶음: [{day,period}] → [{day,start,end}]
function groupTimes(slots) {
  const byDay = {};
  for (const s of slots) (byDay[s.day] ??= new Set()).add(s.period);
  const blocks = [];
  for (const day of Object.keys(byDay)) {
    const ps = [...byDay[day]].sort((a, b) => a - b);
    let start = ps[0];
    let prev = ps[0];
    for (let i = 1; i < ps.length; i++) {
      if (ps[i] === prev + 1) prev = ps[i];
      else { blocks.push({ day: Number(day), start, end: prev }); start = ps[i]; prev = ps[i]; }
    }
    blocks.push({ day: Number(day), start, end: prev });
  }
  return blocks;
}

// ---------- 메인: PDF/HWP → rows + periods ----------
export async function parseSyllabus(file, { onProgress, noCache = false } = {}) {
  const hwp = isHwpFile(file);
  const { pages: rawPages, grids } = hwp ? await extractHwp(file) : await extractPdf(file);
  // HWP 는 페이지가 아니라 섹션(문서 전체 분량일 수 있음) 단위라, PDF 페이지만한 크기로 재분할한다.
  // grids 는 HWP 에서 항상 비어 있다(좌표 정보 없음) — 격자 대조·컬럼 보정은 조용히 건너뛴다.
  const pages = hwp ? rawPages.flatMap((p) => chunkText(p)) : rawPages;
  // PDF는 인쇄 페이지마다 표 머리글("담당교수")이 다시 찍히니 그 글자로 '과목 페이지'를 골라낸다.
  // HWP는 그렇지 않다 — 표가 이어지는 문서 흐름이라 머리글이 표 전체에서 단 한 번만 나온다
  // (실측: 한 편람에서 표 본문 41000자 중 "담당교수" 14회뿐, 상당수 조각엔 아예 없었다).
  // 그 글자로 조각을 걸러내면 진짜 과목 행이 담긴 조각이 통째로 빠져 '기존에는 있는데 이번
  // 파일엔 없는 분반'이 대량으로 잘못 뜬다 — 그래서 HWP는 표지 정도로 보이는 아주 짧은
  // 조각만 빼고 나머지는 전부 과목 페이지로 본다(AI 프롬프트가 강의가 아닌 행은 알아서 뺀다).
  const HWP_MIN_CHUNK = 150;
  // 편람 뒤에는 같은 내용을 "학년별/강의실별 수업시간표"로 다시 늘어놓은 요일×반 격자 부록이
  // 붙기도 한다(1학년 반편성 과목은 학생이 고르는 게 아니라 반 전체가 같이 듣다 보니 편람 표
  // 자체를 이 격자로 대신하는 경우도 있다). 이 격자는 글자 좌표가 없어 어느 요일·교시 칸인지
  // 알 길이 없다 — AI가 교수만 읽고 시간 없는 반쪽짜리 행을 만들면, 그 행이 기존 분반과
  // 번호만 맞아 떨어져 '적용'했을 때 멀쩡한 기존 시간표를 지워 버릴 수 있다(강의시간 전체
  // 교체 모드에서). 세부표는 시간을 "목34금3"처럼 붙여 쓰지 "3교시"로 풀어 쓰지 않으므로
  // (실측 확인: 진짜 세부표 조각엔 "N교시"가 0회), "N교시"가 2번 이상 나오면 격자로 보고 뺀다.
  const looksLikeWeeklyGrid = (text) => (text.match(/[1-9]교시/g) || []).length >= 2;
  const coursePages = hwp
    ? pages.filter((p) => p.trim().length >= HWP_MIN_CHUNK && !looksLikeWeeklyGrid(p))
    : pages.filter((p) => p.includes('담당교수'));
  // 격자로 판정돼 건너뛴 조각 수 — 화면에서 "그 과목들이 왜 안 보이는지" 알려주는 데 쓴다.
  const gridPagesSkipped = hwp ? pages.filter((p) => p.trim().length >= HWP_MIN_CHUNK && looksLikeWeeklyGrid(p)).length : 0;
  const periodPages = pages.filter((p) => p.includes('일과시간표') || (p.includes('교시') && p.includes('점심식사')));
  const token = await authHeader();
  const model = await currentModel(token);
  const useCache = !noCache;
  const errors = [];
  let cachedPages = 0;

  let periods = [];
  if (periodPages.length) {
    const { rows: raw, error } = await callParse(model, 'periods', periodPages[0], token, useCache);
    if (error) errors.push(error);
    periods = raw
      .map((p) => ({ no: Number(p.no) || 0, start: String(p.start || '').slice(0, 5), end: String(p.end || '').slice(0, 5) }))
      .filter((p) => p.no >= 1 && /^\d\d:\d\d$/.test(p.start) && /^\d\d:\d\d$/.test(p.end))
      .sort((a, b) => a.no - b.no);
  }

  let done = 0;
  const perPage = await mapLimit(coursePages, 3, async (txt) => {
    const { rows, error, cached } = await callParse(model, 'courses', txt, token, useCache);
    if (error) errors.push(error);
    if (cached) cachedPages += 1;
    done += 1;
    onProgress?.(done, coursePages.length);
    return rows.map(normRow).filter(Boolean);
  });

  // 표의 '영역/학과' 열이 과목명에 달라붙은 것을 격자를 근거로 떼어낸다
  // ("컴퓨터 시스템보안" → 과목 '시스템보안', 학과 '컴퓨터'). 격자를 못 읽었으면 그대로 둔다.
  const { rows, fixed } = fixColumnBleed(dedupeSections(perPage.flat()), grids);

  return {
    rows, periods, errors, grids, renamed: fixed,
    pageCount: pages.length, coursePages: coursePages.length, gridPagesSkipped,
    model, cachedPages, // 관리자 화면에서 "몇 장이 공짜(캐시)였는지" 보여주기 위함
  };
}

// ---------- 같은 과목 안에서 분반 정리 ----------
// 지금까지는 `과목|분반번호`로 묶었다. 그런데 편람은 교반 번호를 중복 인쇄한다 —
// 알고리즘·데이터마이닝·분사추진기관은 서로 다른 두 분반이 둘 다 '교반 1'로 찍혀 있었고,
// 번호로만 묶는 바람에 뒤에 온 분반이 통째로 사라졌다(2026-2 적재에서 5개 분반 유실).
//
// 그래서 신원을 '번호'가 아니라 '내용(시간)'으로 본다:
//   · 번호도 같고 시간도 같다  → 같은 분반이 여러 페이지에 반복 게재된 것 → 합친다.
//   · 번호는 같은데 시간이 다르다 → 서로 다른 분반이다 → 둘 다 살리고 번호를 새로 준다.
//   · 시간이 비어 있는 행은, 그 번호에 시간 있는 행이 딱 하나면 거기에 흡수시킨다(정보 보강).
const slotsKey = (r) => (r.times ?? []).map((t) => `${t.day}:${t.period}`).sort().join(',');

// 과목명·교수·시간이 완전히 같은 행은 번호가 달라도 같은 분반이다. 학년별로 표를
// 나눠 적는 편람은 여러 학년이 함께 듣는 교양선택 같은 과목을 그 표마다 그대로 되풀이해
// 싣는데(실측: 2026-2 학위교육운영계획서에서 "수학과미래산업" 한 과목이 8개 표에 토씨 하나
// 안 틀리고 반복 인쇄돼 있었다), AI가 그 반복을 서로 다른 분반으로 세어 번호를 새로 매기는
// 일이 있다. 번호만 보고 묶는 아래 1)단계는 이 경우를 못 잡는다(번호 자체가 다르므로) —
// 그래서 번호 이전에 내용으로 먼저 합친다. 시간이 비어 있는 행은 병합 근거가 없어 그대로 둔다.
//
// 신원 키에 강의실은 넣지 않는다(2026-9 확인: "미디어영어"가 5개 표에 원문 그대로
// "3 1 목3 목4 금2 허선민 401" 반복 인쇄돼 있는데도 유령 2분반이 생겼다 — 같은 반복을
// 페이지마다 별도 Gemini 호출로 읽다 보니 자유서식 필드인 강의실 한 곳만 호출 간에
// 흔들려도 그 한 번이 키를 깨 병합을 놓친다). 같은 교수가 같은 요일·교시 조합으로 같은
// 과목을 두 번 열 수는 없으니 과목+교수+시간만으로 이미 신원이 정해진다 — 버려지는 중복
// 행도 room/department 처럼 대표 행엔 없는 정보를 들고 있을 수 있어 버리기 전에 옮겨 담는다
// (dedupeSections() 의 fill() 과 같은 모양이라 여기로 뽑아 함께 쓴다).
function fillMissing(dst, src) {
  if (!dst.professor && src.professor) dst.professor = src.professor;
  if (!dst.department && src.department) dst.department = src.department;
  if (!dst.room && src.room) dst.room = src.room;
}

function mergeContentDuplicates(rows) {
  const byKey = new Map();
  const out = [];
  for (const r of rows) {
    const tk = slotsKey(r);
    if (!tk) { out.push(r); continue; }
    const key = `${r.course}|${r.professor ?? ''}|${tk}`;
    const prev = byKey.get(key);
    if (prev) { fillMissing(prev, r); continue; } // 완전히 같은 내용 — 먼저 나온 분반 번호로 대표 행 하나만 남긴다
    const copy = { ...r };
    byKey.set(key, copy);
    out.push(copy);
  }
  return out;
}

export function dedupeSections(rows) {
  rows = mergeContentDuplicates(rows);
  const fill = fillMissing;

  // 1) 과목|번호 로 모으고, 그 안에서 시간별로 나눈다.
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.course}|${r.sectionNo}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }

  const out = [];
  for (const list of groups.values()) {
    const byTimes = new Map();
    for (const r of list) {
      const tk = slotsKey(r);
      const prev = byTimes.get(tk);
      if (!prev) byTimes.set(tk, { ...r });
      else fill(prev, r);
    }
    const timed = [...byTimes.keys()].filter((k) => k !== '');
    if (byTimes.has('') && timed.length === 1) {   // 시간 없는 행 → 유일한 시간 있는 행에 흡수
      fill(byTimes.get(timed[0]), byTimes.get(''));
      byTimes.delete('');
    }
    out.push(...byTimes.values());
  }

  // 2) 한 과목 안에서 번호가 겹치면 뒤엣것에 빈 번호를 준다(앞엣것은 편람 번호를 지킨다).
  //    새 번호를 고를 때 '다른 분반이 뒤에서 쓸 번호'는 피한다 — 1,1,2,3 에서 두 번째 1 에
  //    2 를 주면 진짜 2분반과 부딪힌다.
  const present = new Map();   // course → Set(편람에 등장한 모든 번호)
  for (const r of out) {
    (present.get(r.course) ?? present.set(r.course, new Set()).get(r.course)).add(r.sectionNo);
  }
  const used = new Map();      // course → Set(이번에 확정한 번호)
  for (const r of out) {
    const p = present.get(r.course);
    const u = used.get(r.course) ?? used.set(r.course, new Set()).get(r.course);
    if (!u.has(r.sectionNo)) { u.add(r.sectionNo); continue; }
    let n = 1;
    while (u.has(n) || p.has(n)) n++;
    r.sectionNo = n;
    u.add(n);
    p.add(n);
  }
  return out;
}

// ---------- CSV 소스: 표 CSV → rows (parseSyllabus 와 같은 rows 형태) ----------
// 헤더 인식(유연): 과목명/분반/담당교수/학과/강의시간/강의실. 그 외 열(학점·대상·비고 등)은 무시.
// 분반을 비우면 과목별 파일 등장 순서대로 1,2,3… 자동 부여(명시된 번호와 겹치지 않게).
// 강의시간은 "수1 수2 금1"(요일+교시), 연속은 "수1-2"/"수1~2" 허용. 팀티칭 교수는 첫 1명만 사용.
const CSV_ALIASES = {
  course: ['과목명', '과목', 'course', 'name'],
  sectionNo: ['분반', 'section', '섹션'],
  professor: ['담당교수', '교수', 'professor', 'prof'],
  department: ['학과', '소속', 'department', 'dept'],
  times: ['강의시간', '시간', 'times', 'time'],
  room: ['강의실', '장소', 'room'],
};

// RFC4180 유사: 따옴표/이스케이프("") 처리해 [행][열] 문자열 표를 만든다.
function parseCsvTable(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function mapCsvHeader(header) {
  const idx = { course: -1, sectionNo: -1, professor: -1, department: -1, times: -1, room: -1 };
  header.forEach((h, i) => {
    const key = String(h || '').replace(/\s+/g, '').toLowerCase();
    if (!key) return;
    for (const [field, aliases] of Object.entries(CSV_ALIASES)) {
      if (idx[field] === -1 && aliases.some((a) => key.includes(a))) idx[field] = i;
    }
  });
  return idx;
}

// "수1 수2 금1" / "수1-2" → [{day,period}]
export function parseTimeString(str) {
  const out = [];
  for (const tok of String(str || '').split(/[\s,]+/)) {
    const m = tok.match(/^([월화수목금토일])(\d+)(?:[-~](\d+))?$/);
    if (!m) continue;
    const day = DAY_KO[m[1]];
    const a = Number(m[2]);
    const b = m[3] ? Number(m[3]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) out.push({ day, period: p });
  }
  return out;
}

export function parseCsvRows(text) {
  const table = parseCsvTable(text).filter((r) => r.some((c) => String(c).trim()));
  if (!table.length) return { rows: [], periods: [] };
  let hi = table.findIndex((r) => r.some((c) => /과목|course/i.test(c)));
  if (hi < 0) hi = 0;
  const idx = mapCsvHeader(table[hi]);
  const hasHeader = idx.course >= 0;
  if (!hasHeader) { idx.course = 0; idx.sectionNo = 1; idx.professor = 2; idx.department = 3; idx.times = 4; idx.room = 5; }
  const get = (r, k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');

  const prelim = [];
  for (const r of table.slice(hasHeader ? hi + 1 : 0)) {
    if (/^\s*#/.test(r[0] ?? '')) continue; // 주석행
    const course = cleanName(get(r, 'course'));
    if (!course) continue;
    prelim.push({
      course,
      sectionRaw: get(r, 'sectionNo'),
      professor: get(r, 'professor'),
      department: get(r, 'department') || null,
      times: parseTimeString(get(r, 'times')),
      room: get(r, 'room') || null,
    });
  }

  // 분반 자동 부여: 명시된 번호를 먼저 예약한 뒤, 빈 칸에 과목별로 빈 최소 번호 채움.
  const used = new Map();
  const setOf = (c) => used.get(c) ?? used.set(c, new Set()).get(c);
  for (const p of prelim) { const n = Number(p.sectionRaw); if (p.sectionRaw && n > 0) setOf(p.course).add(n); }
  const nextFree = (c) => { const s = setOf(c); let n = 1; while (s.has(n)) n += 1; s.add(n); return n; };

  const rows = prelim
    .map((p) => normRow({
      course: p.course,
      sectionNo: (p.sectionRaw && Number(p.sectionRaw) > 0) ? Number(p.sectionRaw) : nextFree(p.course),
      professor: p.professor,
      department: p.department,
      times: p.times,
      room: p.room,
    }))
    .filter(Boolean);
  // CSV 도 같은 그물을 통과시킨다 — 사람이 분반 번호를 겹쳐 적어도 분반이 사라지지 않는다.
  return { rows: dedupeSections(rows), periods: [] };
}

export const CSV_TEMPLATE = [
  '과목명,분반,담당교수,학과,강의시간,강의실,대상',
  '# 분반을 비우면 과목별로 1,2,3… 자동 부여됩니다. 시간은 "요일+교시"(예: 수1 수2 금1), 연속교시는 수1-2 도 가능. 팀티칭은 대표교수 1명만.',
  '기초물리학및실험,,김득수,,수1 수2 금1,403,3반',
  '기초물리학및실험,,김득수,,수5 수6 금3,403,4반',
  '대학수학,,이용균,,화6 목3 목4,401,1반',
  '대학수학,,이용균,,화5 목1 목2,402,2반',
].join('\n');

// ---------- 기존 분반 대조 ----------
// 분반의 신원은 (과목, 연도, 학기, 분반번호)인데, 분반번호는 소스마다 다르게 매겨진다 —
// CSV 는 분반칸이 비면 등장순으로 1,2,3… 을 자동 부여하고, 편람 PDF 는 실제 교반 번호(3,4…)를 쓴다.
// 같은 학기를 두 소스로 적재하면 번호만 달라 PK 가 갈리고, 화면엔 똑같은 분반이 두 벌 남는다.
// 그래서 번호를 믿지 않고 내용(강의시간 + 담당교수)으로 기존 분반을 먼저 찾아 그 번호를 물려받는다.
const timesKey = (blocks) => [...(blocks ?? [])].map((b) => `${b.day}:${b.start}-${b.end}`).sort().join(',');

// 이 학기 기존 분반: courseCode → [{ sectionNo, professorCode, key(시간), times, room }]
// room 은 '빈 칸만 채우기' 필터·표시에만 쓴다(sectionTimes 항목 중 하나라도 강의실이 있으면 있음으로 본다).
// sectionTimes 는 section 문서에 배열로 임베드돼 있다(설계 §3) — 옛 section_time 별도
// 컬렉션 조인이 필요 없다.
function existingSections(catalog, year, term) {
  const byCourse = new Map();
  for (const s of catalog?.sections ?? []) {
    if (Number(s.year) !== year || Number(s.term) !== term) continue;
    const rawTimes = s.sectionTimes ?? [];
    const times = rawTimes.map((t) => ({ day: t.dayOfWeek, start: t.startPeriod, end: t.endPeriod }));
    const room = rawTimes.find((t) => t.room)?.room ?? null;
    const list = byCourse.get(s.courseCode) ?? byCourse.set(s.courseCode, []).get(s.courseCode);
    list.push({
      sectionNo: s.sectionNo, professorCode: s.professorCode ?? null,
      key: timesKey(times), times, room,
    });
  }
  return byCourse;
}

// 계획 분반에 최종 분반번호를 부여한다. 반환: { sections, claimed(이번 적용이 차지하는 기존 번호) }
function assignSectionNos(planned, pool, codeOfProf) {
  const taken = new Set();    // 이번 계획이 확정한 번호
  const claimed = new Set();  // 이번 적용이 차지(재사용/덮어쓰기)하는 기존 분반 번호
  const fixed = new Set();    // 1)에서 번호가 확정된 계획 분반(참조)
  const out = planned.map((s) => ({ ...s, planNo: s.sectionNo, reused: false }));

  // 1) 내용 매칭 — 시간이 같은 기존 분반의 번호를 물려받는다(교수까지 같으면 우선).
  //    번호가 이미 같으면 그대로 두는 것도 '매칭'이다 — 같은 파일을 두 번 적용해도 제자리에 덮어쓴다.
  for (const s of out) {
    const key = timesKey(s.times);
    if (!key) continue;
    const cands = pool.filter((e) => !claimed.has(e.sectionNo) && e.key === key);
    if (!cands.length) continue;
    const pc = s.professorName ? codeOfProf(s.professorName) : null;
    const hit = (pc && cands.find((e) => e.professorCode === pc)) || cands[0];
    s.sectionNo = hit.sectionNo;
    s.reused = true;
    // '빈 칸만 채우기' 필터·표시용 — 지금 DB 에 이미 값이 있는지(이 편람 내용과 무관하게).
    s.dbHasProfessor = !!hit.professorCode;
    s.dbHasRoom = !!hit.room;
    fixed.add(s);
    taken.add(hit.sectionNo);
    claimed.add(hit.sectionNo);
  }

  // 2) 나머지는 계획 번호 그대로 — 같은 번호의 기존 분반은 편람 기준으로 덮어쓴다.
  //    단 1)이 이미 가져간 번호와 부딪힐 때만, 살아남을 기존 분반까지 피해 빈 번호로 민다.
  const survivors = new Set(pool.filter((e) => !claimed.has(e.sectionNo)).map((e) => e.sectionNo));
  for (const s of out) {
    if (fixed.has(s)) continue;
    let n = s.planNo;
    if (taken.has(n)) { n = 1; while (taken.has(n) || survivors.has(n)) n += 1; }
    s.sectionNo = n;
    taken.add(n);
    claimed.add(n);
    survivors.delete(n);
  }
  return { sections: out, claimed };
}

// ---------- 대조(reconcile): 기존 catalog와 비교 ----------
// catalog: { course[], professor[], section[], section_time[] }
// 과목 이름 근접매칭 — 정규화된 '구간' 완전일치만 후보로 올린다. 편집거리(오타 유사도)는 쓰지 않는다:
//   체육(럭비) ↔ 럭비            → 매칭(괄호 안/앞이 기존 과목명과 통째로 일치)
//   항공체력관리론 ↔ 항공우주체력관리론 → 매칭 안 함(공유 구간 없음; 실제로 3학년/1학년 다른 과목)
// 안전을 위해 '한쪽의 구간(base/paren)이 다른쪽 전체(full)와 정확히 같을 때'만 후보로 본다.
// (base끼리 비교하면 체육(럭비)·체육(축구)가 서로 묶여 버린다 — 그래서 항상 상대의 full 과만 맞춘다.)
function courseNameKeys(name) {
  const norm = (s) => (s || '')
    .normalize('NFC')
    .replace(/[［【〔]/g, '(').replace(/[］】〕]/g, ')')   // 대괄호류 → 소괄호
    .replace(/\s+/g, '')
    .toLowerCase();
  const str = String(name ?? '');
  const parenRaw = (str.match(/\(([^()]+)\)/) || [])[1] || '';  // 첫 괄호 내용
  const baseRaw = str.split('(')[0];                            // 첫 괄호 앞
  return { full: norm(str), base: norm(baseRaw), paren: norm(parenRaw) };
}
function courseNamesRelated(a, b) {
  if (!a.full || !b.full) return false;
  if (a.full === b.full) return true;
  if (a.paren && a.paren === b.full) return true;
  if (a.base && a.base === b.full) return true;
  if (b.paren && b.paren === a.full) return true;
  if (b.base && b.base === a.full) return true;
  return false;
}

export function reconcile(rows, periods, catalog, year, term, grids = []) {
  const courses = catalog?.courses ?? [];
  const profs = catalog?.professors ?? [];
  const sections = catalog?.sections ?? [];

  const courseByName = new Map();
  for (const c of courses) if (!courseByName.has(c.name)) courseByName.set(c.name, c);
  // 교수는 이름 글자 그대로가 아니라 정규화 키(공백·대소문자 무시)로 찾는다 —
  // "유 훈"(편람) 과 "유훈"(DB) 은 같은 사람인데 문자열 비교로는 안 맞아 매번 새 교수가 생겼다.
  const profsByKey = new Map();
  for (const p of profs) {
    const k = profKey(p.name);
    (profsByKey.get(k) ?? profsByKey.set(k, []).get(k)).push(p);
  }

  // 파일에 적힌 이름 → 표준 이름(canonical). DB 에 있는 이름이 표준이다.
  //   1) 공백·대소문자만 다르면 DB 이름으로 통일          ("유 훈"     → "유훈")
  //   2) 기존 교수 이름의 '짧은 판'이고 후보가 하나뿐이면 그 DB 이름으로 ("Justin" → "Justin Bunting")
  //   3) DB 에 없고 파일 안에서만 길고 짧은 변형이 섞였으면 긴 쪽으로 통일(한 파일이 교수를 두 벌 만들지 않게)
  // 후보가 둘 이상이면 통일하지 않고 그대로 둔다 → 아래에서 'ambiguous' 로 사람이 고른다.
  const rawNames = [...new Set(rows.map((r) => r.professor).filter(Boolean))];
  const canonOf = new Map();
  const nearMatched = new Set();   // 짧은 이름으로 기존 교수를 찾아낸 표준 이름(관리자가 확인해야 함)
  for (const n of rawNames) {
    if (profsByKey.has(profKey(n))) { canonOf.set(n, profsByKey.get(profKey(n))[0].name); continue; }
    const near = profs.filter((p) => isSubName(n, p.name) || isSubName(p.name, n));
    if (near.length === 1) { canonOf.set(n, near[0].name); nearMatched.add(near[0].name); continue; }
    if (near.length > 1) { canonOf.set(n, n); continue; }
    const longer = rawNames.filter((m) => m !== n && isSubName(n, m)).sort((a, b) => b.length - a.length)[0];
    canonOf.set(n, longer ?? n);
  }
  const rws = rows.map((r) => (
    r.professor && canonOf.get(r.professor) !== r.professor
      ? { ...r, professor: canonOf.get(r.professor) }
      : r
  ));
  // 표준 이름 → 파일에 적혀 있던 다른 표기들. 화면에 "파일 표기: 유 훈" 으로 보여 준다
  // (아래 professors[].name 은 파일 글자가 아니라 DB 이름이므로, 이걸 안 보여주면 왜 매칭됐는지 알 수 없다).
  const aliasOf = new Map();
  for (const [raw, canon] of canonOf) {
    if (raw !== canon) (aliasOf.get(canon) ?? aliasOf.set(canon, []).get(canon)).push(raw);
  }

  // 과목별 그룹
  const courseGroups = new Map();
  for (const r of rws) {
    const g = courseGroups.get(r.course) ?? courseGroups.set(r.course, { name: r.course, sections: new Map() }).get(r.course);
    const sec = g.sections.get(r.sectionNo) ?? g.sections.set(r.sectionNo, { sectionNo: r.sectionNo, professor: r.professor, slots: [], room: r.room }).get(r.sectionNo);
    if (!sec.professor && r.professor) sec.professor = r.professor;
    if (!sec.room && r.room) sec.room = r.room;
    sec.slots.push(...r.times);
  }

  // 교수별 추정 학과 + 가르치는 과목코드 모으기
  const profDept = new Map(); // name -> dept(추정)
  const profCourseCodes = new Map(); // name -> Set(course_code) (기존에 있는 과목만)
  for (const r of rws) {
    if (!r.professor) continue;
    if (!profDept.has(r.professor) && r.department) profDept.set(r.professor, r.department);
    const existing = courseByName.get(r.course);
    if (existing) (profCourseCodes.get(r.professor) ?? profCourseCodes.set(r.professor, new Set()).get(r.professor)).add(existing.code);
  }

  // 교수 해석(매칭/신규/비슷한이름/동명이인)
  const profNames = [...new Set(rws.map((r) => r.professor).filter(Boolean))];
  const professors = profNames.map((name) => {
    const aliases = aliasOf.get(name) ?? [];
    const exact = profsByKey.get(profKey(name)) ?? [];
    // 정확히 같은 이름이 없을 때만 '비슷한 이름'을 후보로 올린다(성 누락·외자 띄어쓰기).
    const matches = exact.length ? exact : profs.filter((p) => isSubName(name, p.name) || isSubName(p.name, name));
    const candidates = matches.map((m) => ({ code: m.code, name: m.name, department: m.department }));
    if (matches.length === 0) {
      return { name, aliases, code: null, action: 'create', department: profDept.get(name) ?? null, candidates };
    }
    if (matches.length === 1) {
      return {
        name, aliases, code: matches[0].code,
        // 짧은 이름으로 찾아낸 것은 '확실'이 아니다 — 경고를 달아 사람이 보게 한다.
        action: nearMatched.has(name) ? 'similar' : 'match',
        department: matches[0].department ?? profDept.get(name) ?? null,
        candidates,
      };
    }
    // 동명이인(또는 비슷한 이름 여럿): 과목 이력으로 보정
    const myCodes = profCourseCodes.get(name) ?? new Set();
    const byHistory = matches.find((m) => sections.some((s) => s.professorCode === m.code && myCodes.has(s.courseCode)));
    const pick = byHistory ?? matches[0];
    return {
      name, aliases, code: pick.code, action: byHistory && exact.length ? 'match' : 'ambiguous',
      department: pick.department ?? null, candidates,
    };
  });

  // 과목 플랜 — 기존 분반과 내용 대조해 분반번호를 물려받는다(소스별 번호 차이로 인한 중복 방지).
  const codeOfProf = new Map(professors.map((p) => [p.name, p.code]));
  const existing = existingSections(catalog, year, term);
  const claimedByCourse = new Map(); // course_code → Set(이번 적용이 차지하는 기존 분반번호)

  // 파일 과목명 → 기존 과목 매칭. 이름이 정확히 같으면 'match', 정규화 구간이 통째로 맞으면 'similar'
  //  (후보 1개, 자동이지만 관리자가 확인) / 'ambiguous'(후보 여럿, 관리자가 고름) / 'create'(신규).
  const existingCourseKeys = courses.map((c) => ({ course: c, keys: courseNameKeys(c.name) }));
  function matchCourse(name) {
    const exact = courseByName.get(name);
    if (exact) return { code: exact.code, action: 'match', candidates: [] };
    const k = courseNameKeys(name);
    const near = existingCourseKeys.filter((e) => courseNamesRelated(k, e.keys));
    const candidates = near.map((e) => ({
      code: e.course.code, name: e.course.name, department: e.course.department ?? null,
      sectionCount: existing.get(e.course.code)?.length ?? 0,
    }));
    if (candidates.length === 1) return { code: candidates[0].code, action: 'similar', candidates };
    if (candidates.length > 1) return { code: null, action: 'ambiguous', candidates };
    return { code: null, action: 'create', candidates: [] };
  }

  const courseList = [...courseGroups.values()].map((g) => {
    const m = matchCourse(g.name);
    const planned = [...g.sections.values()]
      .sort((a, b) => a.sectionNo - b.sectionNo)
      .map((s) => ({ sectionNo: s.sectionNo, professorName: s.professor, times: groupTimes(s.slots), room: s.room }));
    const pool = m.code ? (existing.get(m.code) ?? []) : [];
    const { sections: assigned, claimed } = assignSectionNos(planned, pool, (n) => codeOfProf.get(n) ?? null);
    if (m.code) claimedByCourse.set(m.code, claimed);
    return {
      name: g.name,
      code: m.code,
      action: m.action,            // 'match' | 'similar' | 'ambiguous' | 'create'
      candidates: m.candidates,    // [{ code, name, department, sectionCount }]
      include: true,
      sections: assigned,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  // 편람에 없는 기존 분반(= 이번 적용이 건드리지 않는 이 학기 분반). 지난 적재의 찌꺼기·중복이 여기 잡힌다.
  const courseNameByCode = new Map(courses.map((c) => [c.code, c.name]));
  const profNameByCode = new Map(profs.map((p) => [p.code, p.name]));
  const stale = [];
  for (const [code, list] of existing) {
    const claimed = claimedByCourse.get(code) ?? new Set();
    for (const e of list) {
      if (claimed.has(e.sectionNo)) continue;
      stale.push({
        courseCode: code,
        courseName: courseNameByCode.get(code) ?? code,
        sectionNo: e.sectionNo,
        professorName: e.professorCode ? (profNameByCode.get(e.professorCode) ?? e.professorCode) : null,
        times: e.times,
      });
    }
  }
  stale.sort((a, b) => a.courseName.localeCompare(b.courseName, 'ko') || a.sectionNo - b.sectionNo);

  const conflicts = findProfConflicts({ courses: courseList });

  // 전 생도 공통 비수업 시간 — 이 편람에서 '어떤 분반도 열리지 않는' 요일×교시.
  // 이름(생도대·군사훈련·공통연구…)은 주간 격자에서 그대로 읽어 온다(AI 호출 0회).
  const periodNos = (periods.length ? periods.map((p) => p.no) : (catalog.periods ?? []).map((p) => p.no))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const gridBlocks = universalBlocks(grids);
  const commonBlocks = deriveCommonBlocks(courseList, periodNos, catalog, year, term, gridBlocks);

  // 세부내용 표 ↔ 주간 격자 대조. 표가 격자에 없는 '요일'을 주장하면 표가 틀린 것이다
  // (2026-2 신호및시스템 1분반: 표 '월1 월2 목1' / 격자 '화1 화2 목1').
  // 격자를 못 읽었거나(양식 변경) 격자가 그 과목을 다 적지 않았으면 조용히 건너뛴다.
  const grid = crossCheck(rows, grids);

  const reusedSections = courseList.reduce((n, c) => n + c.sections.filter((s) => s.reused).length, 0);
  // 이번 파일 이전에 그 학기에 이미 있던 분반 수의 근사치(재사용됨 + 이 파일에 없음).
  // 번호만 같아 편람 기준으로 덮어쓴 분반은 양쪽에 잡히지 않아 정확한 합은 아니지만,
  // '연도·학기를 잘못 입력했거나 파일 일부만 분석됐다'는 경고를 띄우기엔 충분하다.
  const existingApprox = reusedSections + stale.length;
  // 이미 등록된 분반 대부분이 이 파일에서 안 잡혔다 — 연도/학기 오타이거나 파싱이 일부만 됐다는 신호.
  const semesterLooksOff = existingApprox >= 10 && stale.length / existingApprox > 0.5;

  return {
    year, term,
    periods, includePeriods: periods.length > 0,
    professors: professors.sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    courses: courseList,
    conflicts,                   // 같은 교수·같은 교시 — 파싱 오류 신호. 적용은 막지 않고 보여만 준다.
    stale, removeStale: false,   // 삭제는 관리자가 켤 때만 (생도 시간표에 담긴 분반이 CASCADE 로 함께 사라짐)
    semesterLooksOff,             // 연도·학기 오입력 의심 — UI 가 눈에 띄는 경고를 띄운다.
    commonBlocks,                // [{ day, start, end, label }] — 이름은 격자에서 자동, 관리자가 고칠 수 있다
    periodNos,
    grid,                        // { checked, mismatches, coverage } — 격자 대조 결과
    gridCount: grids.length,
    stats: {
      courses: courseList.length,
      newCourses: courseList.filter((c) => c.action === 'create').length,
      similarCourses: courseList.filter((c) => c.action === 'similar').length,     // 비슷한 이름으로 기존 과목에 이어붙임 — 확인 필요
      ambiguousCourses: courseList.filter((c) => c.action === 'ambiguous').length, // 후보 여럿 — 관리자가 골라야 함
      professors: professors.length,
      newProfessors: professors.filter((p) => p.action === 'create').length,
      ambiguous: professors.filter((p) => p.action === 'ambiguous').length,
      similar: professors.filter((p) => p.action === 'similar').length,   // 짧은 이름으로 기존 교수와 이어붙임 — 확인 필요
      // 담당교수를 못 읽은 분반. AI 가 표에서 교수 칸을 통째로 놓쳐도 조용히 '교수 미정'으로
      // 들어가 버려 눈에 안 띄었다(2026-2 영어회화Ⅳ: 12분반 중 9개가 그렇게 비었다) — 세어서 경고한다.
      noProfessor: courseList.reduce((n, c) => n + c.sections.filter((s) => !s.professorName).length, 0),
      reusedSections,
      // 기존 분반 중 DB 엔 없던 값(교수/강의실)을 이번 편람이 채워 줄 수 있는 것 — '빈 칸만 채우기' 대상.
      fillableSections: courseList.reduce((n, c) => n + c.sections.filter(isFillableSection).length, 0),
      staleSections: stale.length,
      conflicts: conflicts.length,
      commonBlocks: commonBlocks.length,
      gridWarnings: grid.mismatches.length,
    },
  };
}

// ---------- 전 생도 공통 비수업 시간 ----------
// 편람에서 '어떤 분반도 열리지 않는' 요일×교시 = 생도대시간·군사훈련·자율선택형교과 …
// (2026-2 편람 기준: 화3·4, 화7·8, 목7·8, 금5~8 이 통째로 비어 있다)
// 시간표 마법사가 이 시간을 '빈 시간(공강교시)'으로 세지 않는 근거가 된다 — 원래 수업이
// 없는 시간이므로. 시각은 이렇게 자동으로 나오고, 이름만 관리자가 붙인다.
// 이미 붙여 둔 이름(catalog.commonBlocks)이 있으면 그대로 이어받는다(재적용해도 안 지워짐).
export function deriveCommonBlocks(courseList, periodNos, catalog, year, term, gridBlocks = []) {
  if (!periodNos.length) return [];
  const used = new Set();
  for (const c of courseList) {
    if (c.include === false) continue;
    for (const s of c.sections ?? []) {
      for (const b of s.times ?? []) {
        for (let p = b.start; p <= b.end; p++) used.add(`${b.day}-${p}`);
      }
    }
  }
  if (!used.size) return [];   // 파싱 결과가 비면 유도하지 않는다(전 시간이 '비수업'이 되어 버린다)

  // 이름은 두 곳에서 온다. 교시 단위로 펼쳐 두고 새 블록에 이어 붙인다.
  //   ① 주간 격자(생도대·군사훈련·공통연구…) — 편람이 직접 말해 주는 이름. AI 호출 0회.
  //   ② 이미 저장된 common_block — 관리자가 손으로 고친 것이니 격자보다 우선한다.
  const prev = {};
  for (const b of gridBlocks) {
    for (let p = b.start; p <= b.end; p++) prev[`${b.day}-${p}`] = b.label;
  }
  for (const b of catalog.commonBlocks ?? []) {
    if (b.year !== year || b.term !== term) continue;
    for (let p = b.startPeriod; p <= b.endPeriod; p++) prev[`${b.dayOfWeek}-${p}`] = b.label;
  }

  const out = [];
  const covered = new Set();
  for (let d = 1; d <= 5; d++) {          // 평일만 — 주말은 원래 수업이 없다
    let run = null;
    periodNos.forEach((p, i) => {
      if (used.has(`${d}-${p}`)) { run = null; return; }
      covered.add(`${d}-${p}`);
      const label = prev[`${d}-${p}`] ?? '';
      // 이어진 칸이라도 이름이 다르면 다른 블록으로 끊는다(생도대시간 ↔ 군사훈련).
      if (run && run.lastIdx === i - 1 && run.label === label) { run.end = p; run.lastIdx = i; return; }
      run = { day: d, start: p, end: p, label, lastIdx: i };
      out.push(run);
    });
  }

  // 관리자가 손으로 등록해 둔 블록은 그대로 이어받는다.
  // 자동 유도는 '개설 분반 0개'만 잡으므로, 월7·8·수7·8 처럼 자율선택형교과(체육)가 열려 있는
  // 시간은 절대 못 찾는다 — 관리자가 직접 넣은 것을 편람을 다시 올렸다고 날려서는 안 된다.
  for (const b of catalog.commonBlocks ?? []) {
    if (b.year !== year || b.term !== term) continue;
    if (covered.has(`${b.dayOfWeek}-${b.startPeriod}`)) continue;   // 자동 유도가 이미 덮음
    out.push({ day: b.dayOfWeek, start: b.startPeriod, end: b.endPeriod, label: b.label, manual: true });
  }

  return out
    .map(({ day, start, end, label, manual }) => ({ day, start, end, label, manual: !!manual }))
    .sort((a, b) => a.day - b.day || a.start - b.start);
}

// ---------- 검토: 같은 교수, 같은 시간 ----------
// 한 교수가 같은 요일·교시에 두 분반을 동시에 가르칠 수는 없다. 편람 표에서 같은 시간대에
// 나란히 열린 분반(영어회화 4·5·6분반이 모두 목1교시, 교수만 다름)의 교수 이름을 AI 가
// 한 사람에게 몰아 붙이는 실수를 저질렀다. 모델을 올려도 확률이 줄 뿐이라 여기서 결정적으로
// 잡아 관리자에게 보여준다. CSV 오타도 같은 그물에 걸린다.
// 적용을 막지는 않는다 — 두 분반이 실제로 합반 수업일 여지가 있어 판단은 사람이 한다.
export function findProfConflicts(plan) {
  const slots = new Map(); // "교수|요일|교시" → { professorName, day, period, sections[] }
  for (const c of plan?.courses ?? []) {
    if (c.include === false) continue;
    for (const s of c.sections ?? []) {
      if (!s.professorName) continue;
      for (const b of s.times ?? []) {
        for (let p = b.start; p <= b.end; p++) {
          const k = `${s.professorName}|${b.day}|${p}`;
          const slot = slots.get(k)
            ?? slots.set(k, { professorName: s.professorName, day: b.day, period: p, sections: [] }).get(k);
          slot.sections.push({ courseName: c.name, sectionNo: s.sectionNo });
        }
      }
    }
  }
  return [...slots.values()]
    .filter((s) => s.sections.length > 1)
    .sort((a, b) =>
      a.professorName.localeCompare(b.professorName, 'ko') || a.day - b.day || a.period - b.period);
}

// ---------- 적용 ----------
async function callAdmin(action, payload) {
  let data;
  try {
    ({ data } = await httpsCallable(functions, 'adminAction')({ action, payload }));
  } catch (e) {
    throw new Error(e.code || e.message || 'adminAction 실패');
  }
  if (data?.status && data.status !== 'OK') throw new Error(data.status);
  return data;
}

// partial=true(빈 칸만 채우기 모드): 이미 값이 있는 교수·분반·강의실·강의시간은 이 편람으로
// 덮어쓰지 않고, 비어 있는 칸만 채운다. 일부 분반만 미입력인 편람을 안심하고 통째로 올릴 수 있다.
export async function applyPlan(plan, { onProgress, partial = false } = {}) {
  // 1) 교수 + 교시
  const meta = await callAdmin('apply_syllabus_meta', {
    year: plan.year,
    term: plan.term,
    partial,
    periods: plan.includePeriods ? plan.periods : [],
    professors: plan.professors.map((p) => ({
      name: p.name, code: p.code, department: p.department || null,
      create: p.code == null, update: !!p.update && p.code != null,
    })),
  });
  const profCodes = meta.profCodes || {};

  // 2) 과목 배치 적용
  const courses = plan.courses.filter((c) => c.include !== false);
  let totalC = 0;
  let totalS = 0;
  let done = 0;
  const BATCH = 12;
  for (let i = 0; i < courses.length; i += BATCH) {
    const batch = courses.slice(i, i + BATCH).map((c) => ({
      name: c.name, code: c.code, create: c.code == null,
      sections: c.sections.map((s) => ({
        sectionNo: s.sectionNo,
        professorCode: s.professorName ? (profCodes[s.professorName] ?? null) : null,
        times: s.times,
        room: s.room,
      })),
    }));
    // eslint-disable-next-line no-await-in-loop
    const r = await callAdmin('apply_syllabus_courses', { year: plan.year, term: plan.term, partial, courses: batch });
    totalC += r.courses || 0;
    totalS += r.sections || 0;
    done += batch.length;
    onProgress?.(done, courses.length);
  }

  // 3) (선택) 편람에 없는 기존 분반 삭제 — 지난 적재의 중복·찌꺼기 청소.
  //    제외(체크 해제)한 과목의 분반은 이번에 다시 쓰이지도 않았으므로 건드리지 않는다.
  let removed = null;
  if (plan.removeStale && plan.stale?.length) {
    const excluded = new Set(plan.courses.filter((c) => c.include === false && c.code).map((c) => c.code));
    const list = plan.stale
      .filter((s) => !excluded.has(s.courseCode))
      .map((s) => ({ courseCode: s.courseCode, sectionNo: s.sectionNo }));
    if (list.length) {
      const r = await callAdmin('delete_sections', { year: plan.year, term: plan.term, sections: list });
      removed = { sections: r.removed || 0, entries: r.entries || 0 };
    }
  }

  // 4) 전 생도 공통 비수업 시간의 이름(생도대시간·군사훈련…). 이름을 붙인 것만 저장한다.
  //    그 학기 것을 통째로 교체하므로 재적용해도 중복되지 않는다.
  const blocks = (plan.commonBlocks ?? []).filter((b) => String(b.label ?? '').trim());
  const named = await callAdmin('apply_common_blocks', {
    year: plan.year, term: plan.term, blocks,
  });

  return { courses: totalC, sections: totalS, removed, blocks: named?.blocks ?? 0 };
}
