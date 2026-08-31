/* 앱 소개(/about) — 로그인 화면의 '앱 소개' 버튼에서 들어온다.
   가드 없는 공개 라우트라 로그인 전에도, 설치 전에도 열린다(App.jsx·InstallGate 참고).
   화면 그림은 components/AboutMocks.jsx, 스타일은 styles/about.css. */
import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PALETTES } from '../lib/palettes';
import { SCREENS, Phone, MockGrid, DEFAULT_PAL } from '../components/AboutMocks';
import '../styles/about.css';

/* 설명 문구 안의 <b>…</b> 만 굵게 — HTML 을 그대로 심지 않으려고 직접 쪼갠다. */
function Rich({ text }) {
  return (
    <>
      {text.split(/<b>|<\/b>/).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}
    </>
  );
}

/* 스크롤해 들어오면 한 번만 나타난다. */
function Reveal({ children, className = '' }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return undefined;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } },
      { rootMargin: '0px 0px -12% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return (
    <div ref={ref} className={`ab-reveal${seen ? ' is-in' : ''} ${className}`.trim()}>
      {children}
    </div>
  );
}

function Section({ num, title, sub, children }) {
  return (
    <section className="ab-sec">
      <Reveal>
        <div className="ab-sec-num">{num}</div>
        <h2 className="ab-sec-title">{title}</h2>
        {sub && <p className="ab-sec-sub"><Rich text={sub} /></p>}
      </Reveal>
      {children}
    </section>
  );
}

/* 완전 익명 모델 — 이 앱의 핵심이라 맨 앞에 둔다. */
const ANON = [
  ['🕵️', '작성자 컬럼이 없습니다', '강의평·족보·메모·게시글에는 <b>누가 썼는지를 저장하는 칸 자체가 없습니다</b>. 수정·삭제는 글마다 정한 비밀번호로만 합니다.'],
  ['🚫', '기기·IP를 남기지 않습니다', '기기지문도, 접속 IP도, 작성자 매핑도 <b>어디에도 저장하지 않습니다</b>. 사후에 작성자를 특정할 기록이 남지 않아요.'],
  ['🚨', '신고는 글만 지웁니다', '신고가 임계치를 넘으면 <b>글이 자동 삭제될 뿐</b>입니다. 신고자를 추적하지도, 작성자를 차단하지도 않습니다.'],
  ['🔑', '계정과 글이 분리돼 있습니다', '시간표·레벨처럼 <b>계정에 딸린 것</b>만 내 것으로 잠기고, 남긴 글은 계정과 이어지지 않습니다.'],
];

/* 화면 목업으로 다 담기 어려운 기능들 */
const EXTRA = [
  ['📲', 'PWA 설치', '홈 화면 앱으로 설치해 씁니다. 앱 셸은 오프라인에서도 열려요.'],
  ['🔔', '웹 푸시', '내 글·댓글 단 글에 새 댓글이 달리면 알림. 기기에만 연결되고 계정과 잇지 않습니다.'],
  ['🌙', '방해금지', '기본 22:30~08:00. 그 시간엔 소리·진동 없이 조용히 도착합니다.'],
  ['🌓', '다크 모드', '시스템 설정을 따라가고, 라이트·시스템·다크로 직접 고를 수도 있어요.'],
  ['🎨', '시간표 테마 50종', '팔레트마다 통일 글자색을 설계해 어느 칸이든 읽힙니다. 직접설정도 가능.'],
  ['🖼️', '시간표 이미지', '캔버스로 직접 그려 아이폰 사진 저장·공유까지. 항상 밝게 뽑습니다.'],
  ['📴', '오프라인 캐시', '카탈로그·확정 시간표를 기기에 캐시해 통신 없이도 열립니다.'],
  ['🔻', '당겨서 새로고침', '앱처럼 인디케이터만 내려오는 방식. 관리자가 고친 강의 정보를 바로 당겨옵니다.'],
  ['📢', '공지 팝업', '읽은 공지는 다시 안 뜨고, 수정·재게시하면 다시 뜹니다.'],
  ['✨', '자동 업데이트', '새 버전이 나오면 토스트로 알리고 한 번에 갈아탑니다.'],
  ['🧼', '비속어 마스킹', 'korcen + 사전 정규식으로 변형·초성까지 부분 마스킹합니다.'],
  ['📍', '교내 인증', '가입은 가입코드 + 위치 확인. 이후 주기적으로 교내에서 재인증합니다.'],
];

const SPEC = [
  ['프론트', 'React 19 · Vite · react-router 7 — 정적 빌드'],
  ['호스팅', 'Cloudflare Pages (anytime.rokafa.app)'],
  ['DB · 인증', 'Firebase Firestore · Auth · Cloud Functions (asia-northeast3)'],
  ['파일', 'Cloudflare R2 — 족보·게시판 이미지, JWT 검증 중계'],
  ['캐시', 'IndexedDB + Workbox 프리캐시'],
  ['앱', 'PWA — 홈 화면 설치 · 웹 푸시 · 오프라인'],
];

export default function About() {
  const navigate = useNavigate();
  const [active, setActive] = useState(0);
  const [palette, setPalette] = useState(DEFAULT_PAL);
  const [theme, setTheme] = useState('light');
  const [wzStep, setWzStep] = useState(0);
  const [showAllPal, setShowAllPal] = useState(false);

  const screen = SCREENS[active];
  const Screen = screen.Screen;
  const HeroScreen = SCREENS[0].Screen;   // 히어로는 항상 홈 화면
  const palShown = showAllPal ? PALETTES : PALETTES.slice(0, 12);

  return (
    <div className="ab">
      <header className="ab-bar">
        <button
          type="button"
          className="ab-head-back"
          style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: '1.2rem', width: '1.4rem' }}
          aria-label="뒤로"
          onClick={() => navigate(-1)}
        >
          ‹
        </button>
        <span className="ab-bar-logo" aria-hidden="true">애</span>
        <span className="ab-bar-name">애타</span>
        <Link to="/login" className="ab-chip ab-chip-key ab-bar-cta">로그인 →</Link>
      </header>

      {/* ───────── 히어로 ───────── */}
      <div className="ab-hero">
        <div className="ab-hero-logo" aria-hidden="true">애</div>
        <h1 className="ab-hero-title">애타</h1>
        <p className="ab-hero-lead">
          공군사관학교 생도를 위한 <b>완전 익명</b> 강의정보 공유 앱.<br />
          강의평 · 시간표 · 족보 · 수업메모 · 익명게시판.
        </p>
        <div className="ab-hero-chips">
          <span className="ab-chip ab-chip-key">완전 익명</span>
          <span className="ab-chip">홈 화면 앱 (PWA)</span>
          <span className="ab-chip">오프라인 지원</span>
          <span className="ab-chip">교내 인증</span>
        </div>
        <div className="ab-hero-phone">
          <Phone theme={theme}>
            <HeroScreen palette={palette} />
          </Phone>
        </div>
        <div className="ab-hero-scroll">
          <span>아래로 내려 기능을 둘러보세요</span>
          <span aria-hidden="true">↓</span>
        </div>
      </div>

      {/* ───────── 익명 모델 ───────── */}
      <Section
        num="01 · 핵심"
        title="이름도, 기기도, 흔적도 남기지 않습니다"
        sub="익명을 표방하면서 뒤로는 작성자를 저장하는 앱이 많습니다. 애타는 <b>구조적으로</b> 그럴 수가 없게 만들었습니다."
      >
        <div className="ab-anon">
          {ANON.map(([ic, t, d], i) => (
            <Reveal key={t}>
              <div className="ab-anon-card" style={{ transitionDelay: `${i * 40}ms` }}>
                <span className="ab-anon-ic" aria-hidden="true">{ic}</span>
                <div>
                  <div className="ab-anon-t">{t}</div>
                  <div className="ab-anon-d"><Rich text={d} /></div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <p className="ab-warnbox">
            <b>다만 만능은 아닙니다.</b> 앱은 작성자를 저장하지 않지만, 통신사·기관 차원의 법적 절차까지
            막아 주지는 못합니다. 익명이라고 해서 무엇이든 써도 되는 것은 아니에요.
          </p>
        </Reveal>
      </Section>

      {/* ───────── 기능 탐색기 ───────── */}
      <Section
        num="02 · 둘러보기"
        title="모든 화면, 직접 눌러 보세요"
        sub="아래 탭을 누르면 그 기능의 실제 화면이 폰 안에서 바뀝니다."
      >
        <div className="ab-explorer">
          <div className="ab-tabs" role="tablist" aria-label="기능 둘러보기">
            {SCREENS.map((s, i) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={i === active}
                className={`ab-tab${i === active ? ' is-on' : ''}`}
                onClick={() => setActive(i)}
              >
                <span aria-hidden="true">{s.icon}</span>
                {s.tab}
              </button>
            ))}
          </div>

          <div className="ab-explorer-stage">
            {/* key 로 화면마다 새로 마운트 → .ab-phone-screen 의 등장 애니메이션이 매번 다시 돈다
                (목업은 Head + body 형제 구조라 안쪽을 div 로 감싸면 폰의 세로 flex 가 깨진다) */}
            <Phone key={screen.key} theme={theme}>
              <Screen palette={palette} step={wzStep} onStep={setWzStep} />
            </Phone>
          </div>

          <div className="ab-phone-ctl">
            <button
              type="button"
              className={`ab-ctl${theme === 'dark' ? ' is-on' : ''}`}
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? '🌙 다크 모드' : '☀️ 라이트 모드'}
            </button>
            {screen.interactive && <span className="ab-ctl" style={{ cursor: 'default' }}>👆 {screen.interactive}</span>}
          </div>

          <div className="ab-explorer-info">
            <div className="ab-explorer-name">{screen.name}</div>
            <p className="ab-explorer-desc">{screen.desc}</p>
            <div className="ab-explorer-points">
              {screen.points.map(([ic, d]) => (
                <div className="ab-point" key={d}>
                  <span className="ab-point-ic" aria-hidden="true">{ic}</span>
                  <span><Rich text={d} /></span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* ───────── 팔레트 ───────── */}
      <Section
        num="03 · 취향"
        title="시간표 색, 50가지 테마"
        sub="팔레트마다 <b>통일된 글자색</b>을 함께 설계했습니다 — 어떤 칸에 어떤 색이 걸려도 글씨가 읽힙니다. 색을 골라 보세요, 위 폰의 시간표가 바로 바뀝니다."
      >
        <Reveal>
          <div className="ab-card" style={{ marginTop: '1rem', padding: '0.7rem' }}>
            <MockGrid palette={palette} rows={4} />
          </div>
          <div className="ab-pal-grid">
            {palShown.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`ab-pal${p.key === palette.key ? ' is-on' : ''}`}
                aria-pressed={p.key === palette.key}
                onClick={() => setPalette(p)}
              >
                <span className="ab-mosaic" aria-hidden="true">
                  {[0, 1, 2, 3, 4].map((c) => (
                    <span className="ab-mos-col" key={c}>
                      {[0, 1, 2, 3].map((r) => (
                        <span
                          className="ab-mos-block"
                          key={r}
                          style={{ flex: (r % 3) + 1, background: p.colors[(c * 4 + r) % p.colors.length] }}
                        />
                      ))}
                    </span>
                  ))}
                </span>
                <span className="ab-pal-name">{p.label}</span>
              </button>
            ))}
          </div>
          {!showAllPal && (
            <div className="ab-pal-more">
              <button type="button" className="ab-ctl" onClick={() => setShowAllPal(true)}>
                테마 {PALETTES.length}종 모두 보기 ↓
              </button>
            </div>
          )}
          <p className="ab-sec-sub">
            마음에 드는 게 없으면 <b>직접설정</b>으로 색을 자유롭게 고르고 글씨색까지 정할 수 있어요.
            고른 테마는 <b>이 기기에만</b> 저장됩니다.
          </p>
        </Reveal>
      </Section>

      {/* ───────── 그 밖의 기능 ───────── */}
      <Section num="04 · 그 밖에" title="화면 뒤에서 돌아가는 것들">
        <div className="ab-grid">
          {EXTRA.map(([ic, t, d], i) => (
            <Reveal key={t}>
              <div className="ab-gcard" style={{ transitionDelay: `${(i % 4) * 40}ms` }}>
                <div className="ab-gcard-ic" aria-hidden="true">{ic}</div>
                <div className="ab-gcard-t">{t}</div>
                <div className="ab-gcard-s">{d}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ───────── 만듦새 ───────── */}
      <Section num="05 · 만듦새" title="무엇으로 만들었나">
        <Reveal>
          <div className="ab-spec">
            {SPEC.map(([k, v]) => (
              <div className="ab-spec-row" key={k}>
                <span className="ab-spec-k">{k}</span>
                <span className="ab-spec-v"><Rich text={v} /></span>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* ───────── CTA ───────── */}
      <Reveal>
        <div className="ab-cta">
          <div className="ab-cta-t">지금 시작하기</div>
          <p className="ab-cta-s">
            가입에는 <b>가입코드</b>와 <b>교내 위치 확인</b>이 필요합니다.<br />
            홈 화면에 설치하면 알림까지 받을 수 있어요.
          </p>
          <div className="ab-cta-btns">
            <Link to="/signup" className="ab-cta-btn">가입하기</Link>
            <Link to="/login" className="ab-cta-btn ab-cta-btn-line">이미 계정이 있어요</Link>
          </div>
        </div>
      </Reveal>

      <p className="ab-foot">
        애타 (AnyTime) · 공군사관학교 생도 강의정보 공유<br />
        이 소개의 화면은 실제 앱 화면을 재현한 예시이며, 표시된 강의·글은 모두 가상입니다.
      </p>
    </div>
  );
}
