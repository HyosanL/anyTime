// 강의 PDF에서 브라우저(pdf.js)가 뽑은 페이지 텍스트를 Gemini 로 구조화한다.
// 요청(JSON): { kind: 'courses'|'periods', text: string }
// 응답: { status:'OK', rows:[...] }  — 과목-분반 행 또는 교시 행
// _middleware.js 가 로그인 검증을 마쳤고(data.user), 여기서 추가로 관리자 여부를 확인한다.
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
- **여러 분반을 한 묶음으로 접어 적기도 한다**: "1,2,3(수4) 4,5,6(목1) 7,8,9(금1) 10,11,12(금2)".
  번호 하나하나가 각각 분반이다 → 이 경우 분반은 12개(1~12)이고, 1·2·3 은 수4교시,
  4·5·6 은 목1교시, 7·8·9 는 금1교시, 10·11·12 는 금2교시다. 절대 묶음 하나를 분반 하나로 합치지 마라.
- 그런 묶음의 담당교수가 "Dan, Timothy, Justin" 처럼 **한 묶음의 분반 수와 같은 수의 이름**이면,
  묶음 안에서 순서대로 1:1 로 짝짓고 그 짝을 **묶음마다 되풀이**한다:
  1=Dan, 2=Timothy, 3=Justin, 4=Dan, 5=Timothy, 6=Justin, 7=Dan, 8=Timothy, 9=Justin,
  10=Dan, 11=Timothy, 12=Justin. (이름을 앞쪽 분반에만 붙이고 나머지를 비우면 안 된다.)
- 표의 맨 왼쪽 열은 **영역/학과**(교양필수·교양선택·군사학·일반학·컴퓨터·전자·기계·항공·우주·
  국관·경영·정책·인공지능·시스템 등)이고 **과목명이 아니다**. 절대 과목명 앞에 붙이지 마라.
  예: "컴퓨터 시스템보안 3 1( 목 34 금 3) 유승훈" → course "시스템보안", department "컴퓨터".
  ("컴퓨터시스템보안"이 아니다. 반대로 "컴퓨터구조"는 그 자체가 과목명이니 그대로 둔다.)
- **과목명 바로 뒤에 숫자가 오고 그 숫자 바로 뒤에 여는 괄호"("가 붙어 있으면**(예:
  "N(...)") 그 숫자는 분반 번호가 아니라 그 과목의 하위 트랙(같은 과목명을 쓰는 서로
  다른 실습 주제·언어 등)을 가리키는 이름의 일부다 — 지우지 말고 과목명에 그대로
  포함시켜라. **뒤에 괄호가 붙지 않고 숫자만 있으면(그 열이 "학점" 열이면) 그건 학점이지
  이름이 아니니 절대 과목명에 붙이지 마라** — 예: "수학과미래산업 3 1 목2..."의 "3"은
  학점(3학점)이고 뒤에 분반번호 "1"이 이어지니 course 는 그냥 "수학과미래산업"이다
  ("수학과미래산업3"이 아니다).
  · "제 2 외국어 1( 러 )" → course "제2외국어1(러)" ("제 2 외국어 2( 독 )" 은 "제2외국어2(독)").
    언어 표기는 표에 적힌 축약형 그대로("러","독","일") 두고 "러시아어"처럼 풀어쓰지 마라 —
    기존 DB가 축약형으로 등록돼 있어 풀어쓰면 같은 과목이 새 과목으로 중복 등록된다.
  · "창의공학설계실습 1(mUA)" 과 "창의공학설계실습 2( 캔위성 )" 은 **서로 다른 과목**이다
    (하나는 mUA 무인기, 하나는 캔위성 실습) → course 는 각각 "창의공학설계실습1(mUA)",
    "창의공학설계실습2(캔위성)" 그대로 두고, "1"/"2( 캔위성 )"를 떼어내 "창의공학설계실습"
    하나로 뭉뚱그리지 마라 — 그러면 실제로는 다른 두 과목이 같은 과목으로 겹쳐 보인다.
- 라벨 조각("군사학","필수" 등)을 옆의 다른 과목 이름 일부("항공공학개론"의 "개론" 등)와
  이어 붙여 "군사학개론" 같은 그럴듯하지만 표에 없는 과목명을 지어내지 마라 — 라벨은
  그냥 버리는 것이지, 다른 글자와 합쳐 새 과목을 만드는 재료가 아니다.
  이 뒤에 진짜 분반 번호가 또 나오면(예: 위 "제2외국어1(러) 3 1 목2..."의 맨 뒤 "1") 그건
  별개로 sectionNo 에 넣는다 — 과목명의 숫자와 분반 번호를 혼동하지 마라.
- "영역 교과 학점 분반 강의시간 담당교수 강의실 인원 비고" 형식(학년별 시간표 세부표)은
  한 과목의 분반들이 여러 줄로 이어지는데, **과목명은 그 줄들 중 아무 한 줄에나(꼭 첫
  줄이 아니어도) 붙어 나온다.** 예:
  "1 목2 금3금4 이지원 457A" / "2 월3월4수2 황선호 414" / "전쟁사 3 3 수3수4금1 황선호 414"
  / "4 수3수4금1 이지원 301" / "5 목3목4금2 황선호 301"
  → 5줄 전부 "전쟁사"(학점 3)의 분반이다. 각 줄은 [분반번호] [요일+교시] [담당교수] [강의실]
  순서이고, **한 줄의 담당교수·강의실은 그 줄에만 속한다 — 앞뒤 줄의 값을 섞거나 옮겨
  붙이지 마라.** 사이에 낀 숫자를 다음 줄 분반번호와 이어 붙여 세 자리 숫자(예:
  "315")로 만들지 말 것 — 분반 번호는 항상 표에 실제로 적힌 한 자리~두 자리 숫자다.
- 이 세부표 페이지에는 "필","택","수","전","공","컴","퓨","터" 처럼 **한 글자씩 세로로
  줄이 갈라진 조각**도 섞여 나온다(영역/전공 이름을 세로로 인쇄한 게 글자 단위로 흩어진
  것) — 이런 한두 글자짜리 고립된 줄은 무시해라. "군사학" 홀로 한 줄, 그 몇 줄 뒤에
  "필수" 가 또 홀로 한 줄인 것도 마찬가지다("군사학필수"가 두 줄로 쪼개져 흩어진 것) —
  **"교양","교양필수","교양선택","군사학","일반학","필수","선택" 같은 영역/구분 낱말이
  숫자·시간·교수 없이 그 줄 하나에만 있으면 라벨이지 과목이 아니다.** 절대 course 로
  쓰지 말고, 그 줄만으로 새 행을 만들지 마라(실측: "군사학"/"필수" 라벨 조각이
  "항공공학개론"과 같은 담당교수·시간을 가진 가짜 "군사학" 과목으로 등록된 적이 있다).
  과목명 뒤로 분반·시간·교수 숫자가 하나도 안 붙어 있으면(같은 블록에 번호로 시작하는
  줄이 없으면) 그 과목은 이 페이지에 실제 개설 정보가 없는 것이니 행을 만들지 마라
  (분반을 지어내지 말 것).
- 공백 제거는 **한 글자씩 떨어져 있을 때만**: "교 양 글 쓰 기" → "교양글쓰기", "프 로 그 래 밍" → "프로그래밍".
  낱말과 낱말 사이의 공백("컴퓨터 시스템보안")은 서로 다른 열일 수 있으니 함부로 붙이지 마라.
- 한 분반을 여러 명이 함께 맡는 팀티칭("안은혜 등 2명")이면 첫 번째 1명만 적는다.
  반면 이름이 쉼표로 나열되고 그 수가 분반 수와 맞으면 팀티칭이 아니라 **분반별 담당**이다(위 규칙대로 짝지어라).
- 한 교수는 같은 요일·교시에 두 분반을 동시에 가르칠 수 없다. 같은 시간에 여러 분반이 열려 있으면
  담당교수는 서로 다른 사람이다(예: 영어회화 4·5·6분반이 모두 목1교시면 교수는 3명이 각각 하나씩).
  표에서 분반 순서와 교수 이름 순서는 나란히 대응하니 순서대로 짝지어라.
- 이름이 몇 명인지, 어느 분반의 것인지 **전혀** 가늠할 수 없을 때만 교수를 ""로 비운다.
  앞 분반의 교수를 근거 없이 복사하지도, 이름이 있는데 비워 두지도 말 것.
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

  // 관리자만 (외부 API 남용·과금 방지). _middleware.js 가 이미 Firebase ID 토큰의
  // admin 커스텀 클레임을 data.user.admin 에 실어 왔으므로 별도 왕복 조회가 필요 없다.
  if (data.user?.admin !== true) return Response.json({ status: 'FORBIDDEN' }, { status: 403 });

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
