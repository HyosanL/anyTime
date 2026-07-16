// 모달·바텀시트가 열린 동안 뒤 페이지(홈) 스크롤을 확실히 잠근다.
// iOS Safari 는 body{overflow:hidden} 을 무시하므로(딤 배경을 드래그하면 뒤가 밀림)
// 스크롤 위치를 저장하고 body 를 position:fixed 로 '얼려' 둔다 — 확실히 안 움직인다.
// 시트 위에 편집기가 겹쳐 뜨는 중첩을 위해 참조 카운트로 관리한다(둘 다 닫혀야 해제).
let count = 0;
let savedY = 0;

export function lockScroll() {
  if (count === 0) {
    savedY = window.scrollY || window.pageYOffset || 0;
    const b = document.body.style;
    b.position = 'fixed';
    b.top = `-${savedY}px`;
    b.left = '0';
    b.right = '0';
    b.width = '100%';
    b.overflow = 'hidden';
  }
  count += 1;
}

export function unlockScroll() {
  count = Math.max(0, count - 1);
  if (count === 0) {
    const b = document.body.style;
    b.position = '';
    b.top = '';
    b.left = '';
    b.right = '';
    b.width = '';
    b.overflow = '';
    window.scrollTo(0, savedY);   // 얼리기 전 스크롤 위치로 복귀
  }
}
