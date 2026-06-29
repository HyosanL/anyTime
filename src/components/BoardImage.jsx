import { useEffect, useState } from 'react';
import { boardImageObjectUrl } from '../lib/board';

// 게시판 이미지: 인증으로 받아 blob 으로 표시(다운로드 X). 우클릭/드래그 억제.
export default function BoardImage({ imageKey, className }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let active = true; let made;
    boardImageObjectUrl(imageKey).then((u) => { if (active) { setUrl(u); made = u; } });
    return () => { active = false; if (made) URL.revokeObjectURL(made); };
  }, [imageKey]);
  if (!url) return <div className="board-img-ph">이미지…</div>;
  return (
    <img
      src={url}
      className={className || 'board-img'}
      alt=""
      draggable={false}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
