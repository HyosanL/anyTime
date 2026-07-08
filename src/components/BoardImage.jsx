import { useEffect, useState } from 'react';
import { boardImageObjectUrl } from '../lib/board';

// 원본을 전체화면 오버레이로. 열릴 때만 원본을 로드(에그레스 절감). ESC·배경 탭으로 닫기.
function ImageLightbox({ imageKey, onClose, loader = boardImageObjectUrl }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let active = true; let made;
    loader(imageKey).then((u) => {
      if (active) { setUrl(u); made = u; } else if (u) URL.revokeObjectURL(u);
    });
    return () => { active = false; if (made) URL.revokeObjectURL(made); };
  }, [imageKey, loader]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // 배경 스크롤 잠금
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="img-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button type="button" className="img-lightbox-close" aria-label="닫기" onClick={onClose}>×</button>
      {url ? (
        <img
          src={url} className="img-lightbox-img" alt="" draggable={false}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        />
      ) : (
        <div className="img-lightbox-loading">원본 불러오는 중…</div>
      )}
    </div>
  );
}

// 게시판 이미지: 평소엔 저화질 썸네일, 탭하면 원본을 크게. 인증 blob 표시(다운로드 X).
// loader 로 로드 경로를 바꿀 수 있다(기본: 인증 /api/board-image, 공유 화면: 토큰 /api/share-image).
export default function BoardImage({ imageKey, className, loader = boardImageObjectUrl }) {
  const [thumb, setThumb] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true; let made;
    loader(imageKey, { thumb: true }).then((u) => {
      if (active) { setThumb(u); made = u; } else if (u) URL.revokeObjectURL(u);
    });
    return () => { active = false; if (made) URL.revokeObjectURL(made); };
  }, [imageKey, loader]);
  if (!thumb) return <div className="board-img-ph">이미지…</div>;
  return (
    <>
      <button type="button" className="board-img-btn" aria-label="원본 보기" onClick={() => setOpen(true)}>
        <img
          src={thumb}
          className={className || 'board-img'}
          alt=""
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
        />
        <span className="board-img-zoom" aria-hidden="true">⤢ 원본</span>
      </button>
      {open && <ImageLightbox imageKey={imageKey} onClose={() => setOpen(false)} loader={loader} />}
    </>
  );
}
