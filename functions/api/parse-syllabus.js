// 강의 PDF에서 브라우저(pdf.js)가 뽑은 페이지 텍스트를 Workers AI로 구조화한다.
// 요청(JSON): { kind: 'courses'|'periods', text: string }
// 응답: { status:'OK', rows:[...] }  — 과목-분반 행 또는 교시 행
// _middleware.js 가 로그인 검증을 마쳤고(data.user), 여기서 추가로 is_admin 을 확인한다.

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const DAY_HINT = '요일 숫자: 월=1, 화=2, 수=3, 목=4, 금=5, 토=6, 일=7.';

const COURSE_SYS = `너는 공군사관학교 수강편람(한국어)에서 OCR로 뽑은 어수선한 페이지 텍스트를 표 데이터로 정리한다.
오직 JSON 배열만 출력한다. 각 원소 = 한 "과목-분반":
{
 "course": "과목명(내부 공백 제거)",
 "sectionNo": 분반 번호 숫자 ("1(3반)"이면 1, "2(2반)"이면 2),
 "professor": "담당교수 성명" 또는 null (계급 모르면 이름만, '강사'/'수탁' 등은 그대로),
 "department": "교수 소속(전공/학과 머리말에서 유추)" 또는 null,
 "times": [{ "day": 1~7, "period": 교시숫자 }]  ("월1 월2 금3" → [{"day":1,"period":1},{"day":1,"period":2},{"day":5,"period":3}]),
 "room": "강의실" 또는 null,
 "area": "교양필수/교양선택/전공필수/전공선택/군사학 등" 또는 null
}
규칙:
- ${DAY_HINT}
- 분반마다 1개 객체. 한 과목에 분반 1,2,3 이 서로 다른 교수/시간이면 3개 객체로.
- 과목명 안의 공백 제거: "교 양 글 쓰 기" → "교양글쓰기", "프 로 그 래 밍" → "프로그래밍".
- 다음은 강의가 아니므로 제외: 페이지 머리말, 생도 현황(이름 목록), 일과시간표, 요일 머리글, "전 생도 연구시간","생도대시간","체육","군사훈련","점심식사","학과준비".
- 코드는 절대 만들지 마라(과목코드/교수코드 출력 금지).
- 확실하지 않으면 그 행을 빼라(억지로 채우지 말 것).
출력은 JSON 배열 하나뿐. 설명/문장 금지.`;

const PERIOD_SYS = `너는 한국어 "생도 일과시간표"에서 교시별 시각을 추출한다.
오직 JSON 배열만 출력: [{ "no": 교시숫자, "start": "HH:MM", "end": "HH:MM" }]
- 실제 교시(1교시~8교시)만. "점심식사","학과준비" 등은 제외.
- "08:10 ~ 09:00" → {"no":1,"start":"08:10","end":"09:00"}.
출력은 JSON 배열 하나뿐.`;

function extractJsonArray(s) {
  if (!s) return [];
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b < 0 || b < a) return [];
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function onRequestPost(context) {
  const { request, env, data } = context;

  // 관리자만 (Workers AI 남용 방지)
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
    if (!ok) return Response.json({ status: 'FORBIDDEN' }, { status: 403 });
  } catch {
    return Response.json({ status: 'FORBIDDEN' }, { status: 403 });
  }

  let body;
  try { body = await request.json(); } catch { return Response.json({ status: 'BAD_REQUEST' }, { status: 400 }); }
  const kind = body.kind === 'periods' ? 'periods' : 'courses';
  const text = String(body.text || '').slice(0, 12000);
  if (!text.trim()) return Response.json({ status: 'OK', rows: [] });

  const sys = kind === 'periods' ? PERIOD_SYS : COURSE_SYS;
  try {
    const out = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: text },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    });
    const raw = typeof out === 'string' ? out : (out.response ?? '');
    return Response.json({ status: 'OK', rows: extractJsonArray(raw) });
  } catch (e) {
    return Response.json({ status: 'ERROR', detail: String(e?.message || e) }, { status: 500 });
  }
}
