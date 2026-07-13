import { Component } from 'react';

// =====================================================================
//  에러 경계 — 페이지 렌더/청크 로딩 실패를 여기서 잡는다.
//
//  이게 없으면 지연 로드 청크(lazy) 하나가 못 받아지는 순간 React 가 트리를 통째로
//  버리고 화면이 새까맣게 남는다. 실제로 2026-07-13, 엣지 캐시가 청크 URL 자리에
//  index.html 을 물고 있어(1년 immutable) 강의검색이 검은 화면이 됐다.
//  청크는 배포·캐시·네트워크 어디서든 실패할 수 있으므로, 검은 화면 대신
//  '스스로 낫는 길'을 반드시 둔다.
// =====================================================================

// 청크(모듈·CSS) 로딩 실패인가. 브라우저마다 문구가 달라 넉넉히 잡는다.
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk .* failed/i;

// 자가 복구는 세션당 한 번만. (복구했는데 또 같은 실패면 = 서버가 정말 깨진 것.
//  그때 또 리로드하면 무한 새로고침 루프가 된다.)
const HEAL_KEY = 'anytime:chunk-heal';
const HEAL_COOLDOWN_MS = 60 * 1000;

function isChunkError(error) {
  return CHUNK_ERROR.test(String(error?.message ?? error ?? ''));
}

// 새로고침만으로는 안 낫는 경우가 있다: 서비스워커 프리캐시가 '오염된 응답'(예: JS 자리의
// HTML)을 정상 200 으로 저장해 두면, 리로드해도 같은 쓰레기를 캐시에서 다시 꺼내 준다.
// → 캐시를 비우고 SW 등록을 버린 뒤 리로드해서 네트워크에서 새로 받게 한다.
async function selfHeal() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* 캐시·SW 를 못 건드려도 리로드는 해 본다 (네트워크가 이미 나았을 수 있다) */
  }
  window.location.reload();
}

export default class ErrorBoundary extends Component {
  state = { error: null, healing: false };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (!isChunkError(error)) return;   // 진짜 코드 버그는 자동 리로드로 숨기지 않는다
    let last = 0;
    try { last = Number(sessionStorage.getItem(HEAL_KEY)) || 0; } catch { /* 사생활 보호 모드 */ }
    if (Date.now() - last < HEAL_COOLDOWN_MS) return;  // 방금 복구했는데 또 → 손으로 넘긴다
    try { sessionStorage.setItem(HEAL_KEY, String(Date.now())); } catch { /* 무시 */ }
    this.setState({ healing: true });
    selfHeal();
  }

  render() {
    const { error, healing } = this.state;
    if (!error) return this.props.children;

    if (healing) {
      return <div className="page-center">새 버전을 받는 중…</div>;
    }

    const chunk = isChunkError(error);
    return (
      <div className="page-center" style={{ flexDirection: 'column', gap: '1rem', padding: '2rem', textAlign: 'center' }}>
        <h2>{chunk ? '🔄 화면을 불러오지 못했어요' : '😵 문제가 발생했어요'}</h2>
        <p className="muted">
          {chunk
            ? '네트워크가 불안정하거나 앱이 업데이트 중일 수 있어요. 잠시 후 새로고침해 주세요.'
            : '이 화면을 여는 중에 오류가 났어요. 계속 이러면 알려 주세요.'}
        </p>
        <button className="btn-add" onClick={selfHeal}>새로고침</button>
      </div>
    );
  }
}
