// 테마: 시스템 설정을 기본으로, 사용자가 라이트/다크로 고정할 수 있다.
// 첫 페인트 전 적용은 index.html 의 인라인 스크립트가 담당하고,
// 여기서는 토글 + 시스템 변경 구독을 처리한다.
import { useEffect, useState } from 'react';

const KEY = 'theme'; // 'system' | 'light' | 'dark'
const META = { light: '#f5f6f8', dark: '#0b0f16' };

const mql = () => window.matchMedia('(prefers-color-scheme: dark)');

export function getPref() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

export function resolve(pref = getPref()) {
  if (pref === 'light' || pref === 'dark') return pref;
  return mql().matches ? 'dark' : 'light';
}

export function apply(pref = getPref()) {
  const mode = resolve(pref);
  document.documentElement.setAttribute('data-theme', mode);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META[mode]);
}

export function setPref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
  apply(pref);
  window.dispatchEvent(new CustomEvent('themechange', { detail: pref }));
}

// 시스템 테마가 바뀌면(사용자가 'system' 모드일 때) 즉시 반영.
export function initTheme() {
  apply();
  const m = mql();
  const onChange = () => { if (getPref() === 'system') apply('system'); };
  m.addEventListener?.('change', onChange);
}

// React 훅: [pref, setPref]
export function useTheme() {
  const [pref, setLocal] = useState(getPref);
  useEffect(() => {
    const onChange = (e) => setLocal(e.detail || getPref());
    window.addEventListener('themechange', onChange);
    return () => window.removeEventListener('themechange', onChange);
  }, []);
  return [pref, setPref];
}
