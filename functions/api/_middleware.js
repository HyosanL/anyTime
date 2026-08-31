// 모든 /api/* 요청에 대해 Firebase ID 토큰(RS256)을 검증(로그인 사용자만 R2 접근).
// - Firebase ID 토큰은 Google 이 주기적으로 회전시키는 공개키(JWKS)로 서명되므로,
//   과거 Supabase HS256 처럼 정적 시크릿으로 로컬 검증할 수 없다. jose 의
//   createRemoteJWKSet 이 JWKS 를 가져와 캐싱(+ 키 회전 시 자동 재조회)하고, jwtVerify 가
//   서명(RS256) + 발급자(iss) + 대상(aud) + 만료(exp)/시계 오차를 한 번에 검사한다
//   (직접 구현하면 캐시 무효화·시계 오차 같은 부분에서 미묘하게 틀리기 쉬운 영역이라
//   손으로 짜지 않고 라이브러리를 쓴다).
// - /api/board-sweep 는 유저 토큰 대신 X-Sweep-Secret 으로 게이트(크론 전용, 그대로 유지).
// - /api/push-fanout 는 유저 토큰 대신 X-Push-Secret 으로 게이트(웹훅 전용, 그대로 유지).
// - /api/share-image 는 무인증 통과(핸들러가 공유 토큰을 자체 검증) — 그대로 유지.
// context.data.user 에 { id, email, admin } 을 싣는다. admin 은 Firebase 커스텀 클레임
// (`admin: true`)이 ID 토큰 payload 에 그대로 실려 오므로 별도 왕복 조회가 필요 없다.
// context.data.token 에는 원본 Authorization 헤더 값을 그대로 실어 다음 핸들러로 전달한다
// (다른 핸들러가 이 원문 베어러 토큰을 그대로 다시 쓸 수 있어야 하므로).

import { createRemoteJWKSet, jwtVerify } from 'jose';

const PROJECT_ID = 'anytime-rokafa';

// Firebase ID 토큰 전용 JWKS(공식 문서 상 "third-party JWT 라이브러리로 직접 검증할 때"
// 쓰라고 안내하는 바로 그 엔드포인트). 모듈 스코프에서 한 번만 생성해 격리(isolate)가
// 재사용되는 동안 키 캐시를 그대로 유지한다(요청마다 새로 만들면 캐싱 효과가 없어짐).
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

function unauth() {
  return new Response(JSON.stringify({ status: 'UNAUTH' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env, next, data } = context;
  if (request.method === 'OPTIONS') return next();

  // 크론 전용 고아 스윕: 유저 토큰 대신 공유 시크릿.
  const path = new URL(request.url).pathname;
  if (path === '/api/board-sweep') {
    if (env.SWEEP_SECRET && request.headers.get('X-Sweep-Secret') === env.SWEEP_SECRET) return next();
    return unauth();
  }

  // 웹푸시 팬아웃: 새 댓글·HOT 승격 웹훅 전용(공유 시크릿 게이트).
  if (path === '/api/push-fanout') {
    if (env.PUSH_SECRET && request.headers.get('X-Push-Secret') === env.PUSH_SECRET) return next();
    return unauth();
  }

  // 공유 링크 이미지(비회원 열람용): 접근 검증은 핸들러가 공유 토큰으로 자체 수행
  // (토큰이 가리키는 글의 이미지 + 공개 허용 상태일 때만 스트리밍).
  if (path === '/api/share-image') return next();

  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return unauth();
  const token = auth.slice(7);

  let payload;
  try {
    ({ payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${PROJECT_ID}`,
      audience: PROJECT_ID,
    }));
  } catch {
    // 서명 불일치·만료·발급자/대상 불일치 등 사유를 가리지 않고 전부 401.
    return unauth();
  }

  data.user = { id: payload.sub, email: payload.email, admin: payload.admin === true };
  data.token = auth;
  return next();
}
