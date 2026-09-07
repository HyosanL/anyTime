import { useEffect, useRef } from 'react';

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// Cloudflare Turnstile 위젯. 사이트 키가 없으면 아무것도 렌더하지 않는다 — 그 경우 가입은
// 그대로 진행되고(signup CF 는 토큰이 없으면 검증을 건너뛴다), 키가 생기면 자동으로 붙는다.
// 토큰이 나오면 onToken(t), 만료·에러 시 onToken('').
export default function Turnstile({ onToken, onError }) {
  const boxRef = useRef(null);
  const idRef = useRef(null);
  const cbRef = useRef(onToken);
  cbRef.current = onToken;
  const errRef = useRef(onError);
  errRef.current = onError;

  useEffect(() => {
    if (!SITE_KEY) return undefined;
    let dead = false;

    function render() {
      if (dead || idRef.current != null || !window.turnstile || !boxRef.current) return;
      idRef.current = window.turnstile.render(boxRef.current, {
        sitekey: SITE_KEY,
        callback: (t) => { cbRef.current(t); errRef.current?.(false); },
        'error-callback': () => { cbRef.current(''); errRef.current?.(true); },
        'expired-callback': () => cbRef.current(''),
        'timeout-callback': () => { cbRef.current(''); errRef.current?.(true); },
      });
    }

    if (window.turnstile) {
      render();
    } else if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.addEventListener('load', render);
      document.head.appendChild(s);
    } else {
      const poll = setInterval(() => {
        if (window.turnstile) { clearInterval(poll); render(); }
      }, 200);
      setTimeout(() => { clearInterval(poll); if (!window.turnstile) errRef.current?.(true); }, 12000);
    }

    return () => {
      dead = true;
      if (idRef.current != null && window.turnstile) {
        try { window.turnstile.remove(idRef.current); } catch { /* already gone */ }
        idRef.current = null;
      }
    };
  }, []);

  if (!SITE_KEY) return null;
  return <div ref={boxRef} style={{ marginTop: 4, minHeight: 65 }} />;
}
