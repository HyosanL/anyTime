// 강의 PDF에서 브라우저(pdf.js)가 뽑은 페이지 텍스트를 Gemini 로 구조화한다.
// 요청(JSON): { kind: 'courses'|'periods', text: string }
// 응답: { status:'OK', rows:[...] }  — 과목-분반 행 또는 교시 행
// _middleware.js 가 로그인 검증을 마쳤고(data.user), 여기서 추가로 is_admin 을 확인한다.
//
// ※ Workers AI(무료 뉴런 10,000/일)에서 옮겨왔다. 수강편람 1회 분석에 페이지당 1회씩
//   호출이 나가는데(이 PDF 기준 ~18회), 70B 모델로는 한 번 돌리면 하루치 무료 한도를
//   거의 다 써서 두 번째 실행부터 4006(한도초과)으로 죽었다.
// ※ PDF 원본을 그대로 Gemini 에 보내지 않는 이유: Worker 에서 수 MB PDF 를 base64 로
//   인코딩하면 무료 플랜의 요청당 CPU 10ms 제한(에러 1102)에 걸린다. 텍스트만 보낸다.
//
// 필요한 시크릿: GEMINI_API_KEY (Pages 대시보드 Secret 또는 `wrangler pages secret put`).
// 유료 등급(결제 활성화)에서 쓸 것 — 무료 등급은 제출 내용이 Google 학습에 사용된다.

const API = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// Flash-Lite(6배 저렴). 한 번 Flash 로 올렸다가 다시 내린다 — 근거가 생겼기 때문이다.
//
// 2026-2 편람을 정답지(사람이 격자와 대조해 교정한 CSV 291행)로 채점해 보니, Flash 의
// 시간 전사는 287/291 정확했고 틀린 4건은 '편람의 세부내용 표 자체가 틀린' 것이었다
// (신호및시스템 1분반: 표 '월12 목1', 격자 '화1 화2 목1'). 즉 모델을 올려서 얻을 것이
// 없었다. Flash 로 올린 이유였던 '교수를 한 사람에게 몰아 붙이는 실수'는 이제 두 겹으로
// 막는다: ① findProfConflicts(같은 교수·같은 교시 = 파싱 오류 신호)를 미리보기에서 경고
// ② 주간 격자 대조(lib/grid.js, AI 호출 0회)가 요일 오류를 잡는다. 관리자가 적용 전에 본다.
//
// 값(2026-07 확인, 1M 토큰당): flash-lite $0.25 in / $1.50 out · flash $1.50 in / $9.00 out
// → 입력·출력 모두 정확히 6배 싸다. 재분석은 페이지 캐시라 무과금.
// 코드 수정 없이 Pages 환경변수 GEMINI_MODEL 로 갈아끼울 수 있다(정확도가 의심되면 즉시 복귀).
//
// ⚠ 모델명은 반드시 지원 목록에서 확인할 것. 'gemini-3.5-flash-lite' 는 존재하지 않는다
//   (Flash-Lite 는 3.1 세대에만 있다). 이름을 패턴으로 추측했다가 404 로 파싱이 통째로 죽었다.
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

const DAY_HINT = '요일 숫자: 월=1, 화=2, 수=3, 목=4, 금=5, 토=6, 일=7.';

const COURSE_SYS = `너는 공군사관학교 수강편람(한국어) PDF에서 추출한 어수선한 페이지 텍스트를 표 데이터로 정리한다.
각 행 = 한 "과목-분반".
규칙:
- ${DAY_HINT}
- 분반마다 1개 객체. 한 과목에 분반 1,2,3 이 서로 다른 교수/시간이면 3개 객체로.
- sectionNo 는 분반 번호 숫자 ("1(3반)"이면 1, "2(2반)"이면 2).
- 교반 표기 "1(월12수1)" 은 분반 1 이 월1,월2,수1 교시라는 뜻이다 → times: [{day:1,period:1},{day:1,period:2},{day:3,period:1}].
- "3(목34금2)" 은 분반 3 이 목3,목4,금2 교시.
- 표의 맨 왼쪽 열은 **영역/학과**(교양필수·교양선택·군사학·일반학·컴퓨터·전자·기계·항공·우주·
  국관·경영·정책·인공지능·시스템 등)이고 **과목명이 아니다**. 절대 과목명 앞에 붙이지 마라.
  예: "컴퓨터 시스템보안 3 1( 목 34 금 3) 유승훈" → course "시스템보안", department "컴퓨터".
  ("컴퓨터시스템보안"이 아니다. 반대로 "컴퓨터구조"는 그 자체가 과목명이니 그대로 둔다.)
- 공백 제거는 **한 글자씩 떨어져 있을 때만**: "교 양 글 쓰 기" → "교양글쓰기", "프 로 그 래 밍" → "프로그래밍".
  낱말과 낱말 사이의 공백("컴퓨터 시스템보안")은 서로 다른 열일 수 있으니 함부로 붙이지 마라.
- 담당교수가 여러 명(팀티칭)이면 첫 번째 1명만.
- 한 교수는 같은 요일·교시에 두 분반을 동시에 가르칠 수 없다. 같은 시간에 여러 분반이 열려 있으면
  담당교수는 서로 다른 사람이다(예: 영어회화 4·5·6분반이 모두 목1교시면 교수는 3명이 각각 하나씩).
  표에서 분반 순서와 교수 이름 순서는 나란히 대응하니 순서대로 짝지어라.
  짝이 확실치 않으면 교수를 ""로 비워라 — 앞 분반의 교수를 그대로 복사하지 말 것.
- 다음은 강의가 아니므로 제외: 페이지 머리말, 생도 현황(이름 목록), 일과시간표, 요일 머리글,
  "전 생도 연구시간","공통연구","생도대","체육","군사훈련","점심식사","학과준비","자기주도적역량".
- 과목코드/교수코드는 절대 만들지 마라.
- 확실하지 않으면 그 행을 빼라(억지로 채우지 말 것).
- 모르는 값은 빈 문자열("")로 둔다.`;

const PERIOD_SYS = `너는 한국어 "생도 일과시간표"에서 교시별 시각을 추출한다.
- 실제 교시(1교시~8교시)만. "점심식사","학과준비" 등은 제외.
- "08:10 ~ 09:00" → { no:1, start:"08:10", end:"09:00" }.`;

const COURSE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          course: { type: 'string', description: '과목명(내부 공백 제거)' },
          sectionNo: { type: 'integer', description: '분반 번호' },
          professor: { type: 'string', description: '담당교수 성명. 모르면 ""' },
          department: { type: 'string', description: '교수 소속(학과/전공 머리말에서 유추). 모르면 ""' },
          room: { type: 'string', description: '강의실. 모르면 ""' },
          times: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                day: { type: 'integer', description: '월=1 … 일=7' },
                period: { type: 'integer', description: '교시 번호' },
              },
              required: ['day', 'period'],
            },
          },
        },
        required: ['course', 'sectionNo', 'times'],
      },
    },
  },
  required: ['rows'],
};

const PERIOD_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          no: { type: 'integer' },
          start: { type: 'string', description: 'HH:MM' },
          end: { type: 'string', description: 'HH:MM' },
        },
        required: ['no', 'start', 'end'],
      },
    },
  },
  required: ['rows'],
};

// Interactions API 응답에서 모델이 낸 텍스트를 꺼낸다.
// output_text 가 편의 필드지만 REST 원본에 늘 있다고 보장하지 않아 steps 순회로도 폴백한다.
function outputText(j) {
  if (typeof j?.output_text === 'string' && j.output_text) return j.output_text;
  const parts = [];
  for (const step of Array.isArray(j?.steps) ? j.steps : []) {
    for (const c of Array.isArray(step?.content) ? step.content : []) {
      if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  if (parts.length) return parts.join('');
  // 레거시 generateContent 형태 대비
  const legacy = j?.candidates?.[0]?.content?.parts?.map((p) => p?.text).filter(Boolean).join('');
  return legacy || '';
}

// 스키마를 강제해도 코드펜스/설명이 섞여 오는 경우가 있어 관대하게 파싱한다.
function extractRows(s) {
  if (!s) return null;
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  let v = tryParse(s);
  if (!v) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) v = tryParse(s.slice(a, b + 1));
  }
  if (!v) {
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a >= 0 && b > a) v = tryParse(s.slice(a, b + 1));
  }
  if (Array.isArray(v)) return v;
  if (Array.isArray(v?.rows)) return v.rows;
  return null;
}

// 업스트림(Gemini) 실패는 502 가 아니라 500 으로 올린다.
// Cloudflare 는 오리진이 502·504 를 반환하면 응답 본문을 자기 브랜드 에러 페이지(HTML)로
// 갈아치운다(Origin Error Page Pass-thru 는 Enterprise 전용). 그래서 502 로 보내면
// 아래 detail 이 통째로 버려지고 브라우저에는 "AI 파싱 실패 (HTTP 502)" 만 남아
// 정작 필요한 사유(키 무효·쿼터·결제 미활성)를 볼 수 없다. 500 은 그대로 통과한다.
// 브라우저뿐 아니라 Workers 로그(`wrangler pages deployment tail`)에도 남긴다 —
// 관리자가 화면을 안 보고 있을 때 터진 실패를 나중에 추적할 수 있어야 한다.
const fail = (detail) => {
  console.error('[parse-syllabus]', detail);
  return Response.json({ status: 'ERROR', detail }, { status: 500 });
};

// 현재 설정된 모델명만 알려준다. 클라이언트가 파싱 캐시 키에 넣으려고 묻는 것이라
// Gemini 는 부르지 않는다(과금 0). 로그인 검증은 _middleware.js 가 이미 마쳤다.
export function onRequestGet({ env }) {
  return Response.json({ status: 'OK', model: env.GEMINI_MODEL || DEFAULT_MODEL });
}

export async function onRequestPost(context) {
  const { request, env, data } = context;

  // 관리자만 (외부 API 남용·과금 방지)
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/is_admin`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: data.token,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const ok = await r.json().catch(() => false);
    if (ok !== true) return Response.json({ status: 'FORBIDDEN' }, { status: 403 });
  } catch {
    return Response.json({ status: 'FORBIDDEN' }, { status: 403 });
  }

  if (!env.GEMINI_API_KEY) return Response.json({ status: 'NO_GEMINI_KEY' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ status: 'BAD_REQUEST' }, { status: 400 }); }
  const kind = body.kind === 'periods' ? 'periods' : 'courses';
  const text = String(body.text || '').slice(0, 12000);
  if (!text.trim()) return Response.json({ status: 'OK', rows: [] });

  const sys = kind === 'periods' ? PERIOD_SYS : COURSE_SYS;
  const schema = kind === 'periods' ? PERIOD_SCHEMA : COURSE_SCHEMA;

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;

  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        model,
        input: `${sys}\n\n--- 페이지 텍스트 ---\n${text}`,
        response_format: { type: 'text', mime_type: 'application/json', schema },
      }),
    });
  } catch (e) {
    return fail(`Gemini 호출 실패: ${e?.message || e}`);
  }

  const raw = await res.text();
  if (!res.ok) {
    // Gemini 의 사유(모델명 오류·키 무효·결제 미활성·쿼터 등)를 그대로 올려보내 진단 가능하게 한다.
    let detail = raw.slice(0, 400);
    try { detail = JSON.parse(raw)?.error?.message || detail; } catch { /* 원문 유지 */ }
    return fail(`Gemini ${res.status}: ${detail}`);
  }

  let json;
  try { json = JSON.parse(raw); } catch {
    return fail('Gemini 응답이 JSON이 아닙니다.');
  }

  const rows = extractRows(outputText(json));
  if (!rows) {
    // 응답 형태가 예상과 다르면 조용히 0건으로 넘기지 말고 원문 일부를 보여준다.
    return fail(`Gemini 응답에서 rows를 찾지 못했습니다: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return Response.json({ status: 'OK', rows, model });
}
