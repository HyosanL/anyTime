// =====================================================================
//  /assets/* 미스를 '진짜 404'로 만든다 (엣지 캐시 오염 차단)
//
//  Pages 는 없는 경로에 SPA 폴백(index.html, 200)을 내준다. 그런데 /assets/* 에는
//  _headers 가 immutable(1년) 을 붙인다 → 배포 시차에 청크 URL 요청이 한 번만 들어와도
//  그 자리에 HTML 이 1년간 눌러앉고, 그 청크를 쓰는 화면은 영구히 검은 화면이 된다
//  (2026-07-13 실제 장애: 강의검색). _redirects 는 404 상태를 지원하지 않아 여기서 막는다.
//
//  존재하는 파일은 next() 응답을 그대로 흘려보낸다 — 헤더·캐시 동작을 건드리지 않는다.
// =====================================================================
export async function onRequest(context) {
  const res = await context.next();

  // 해시 파일명 자리에 HTML 이 왔다 = 그 파일이 없다는 뜻(SPA 폴백).
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('text/html')) return res;

  return new Response('asset not found\n', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',   // 이 응답만은 절대 캐시되지 않게(오염의 핵심)
    },
  });
}
