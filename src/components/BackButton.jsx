import { useNavigate } from 'react-router-dom';

// 헤더 좌측 뒤로가기 버튼 — 스와이프 제스처가 불편한 사용자를 위한 보조 수단.
// 딥링크·새로고침 직후처럼 앱 내 히스토리가 없으면 fallback 경로로 이동한다.
export default function BackButton({ fallback = '/' }) {
  const navigate = useNavigate();

  function goBack() {
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  }

  return (
    <button type="button" className="icon-btn back-btn" onClick={goBack} aria-label="뒤로가기">
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  );
}
