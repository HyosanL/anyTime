/* 앱 소개(/about) 전용 화면 목업.
   실제 화면을 CSS 로 재현한 '그림'이다 — 데이터를 부르지 않으므로 로그인 전에도 그대로 뜬다.
   문구·구조는 실제 화면(src/pages/*)에서 그대로 가져왔다. 화면을 고치면 여기도 같이 고칠 것.
   과목 색만은 lib/palettes 단일 원본을 import 해서 쓴다(50종 테마를 진짜로 미리 보여주려고). */
import { useState } from 'react';
import { PALETTES } from '../lib/palettes';

export const DEFAULT_PAL = PALETTES[0];

/* ────────── 시간표 표본 ────────── */
const HOURS = ['08', '09', '10', '11', '13', '14']; // 행 = 교시 1~6
const DAYS = ['월', '화', '수', '목', '금'];

// d=요일(0~4), r=시작행, s=칸수
const BLOCKS = [
  { d: 0, r: 0, s: 2, c: '항공기상학', m: '302 · 김민수' },
  { d: 2, r: 0, s: 2, c: '항공기상학', m: '302 · 김민수' },
  { d: 4, r: 0, s: 2, c: '군사학', m: '대강당 · 박성호' },
  { d: 1, r: 2, s: 2, c: '전자공학', m: '401 · 이정훈' },
  { d: 3, r: 2, s: 2, c: '전자공학', m: '401 · 이정훈' },
  { d: 2, r: 3, s: 1, c: '영어회화', m: '207 · Bunting' },
  { d: 0, r: 4, s: 2, c: '체력단련', m: '체육관' },
  { d: 4, r: 3, s: 1, c: '자율학습', m: '', custom: true },
];
// 그 학기에 아무 강의도 열리지 않는 칸 — 회색으로 깔고 공강으로 세지 않는다
const NOCLASS = [{ d: 1, r: 4, s: 2 }, { d: 3, r: 4, s: 2 }];

// 과목 등장 순서대로 팔레트 색을 배정한다(실제 lib/timetableLayout 과 같은 규칙)
const COURSE_ORDER = ['항공기상학', '군사학', '전자공학', '영어회화', '체력단련', '자율학습'];

function buildCells() {
  const cells = Array.from({ length: HOURS.length }, () => Array(DAYS.length).fill(null));
  for (const b of BLOCKS) {
    cells[b.r][b.d] = { ...b, kind: 'class' };
    for (let i = 1; i < b.s; i++) cells[b.r + i][b.d] = 'skip';
  }
  for (const b of NOCLASS) {
    cells[b.r][b.d] = { ...b, kind: 'block' };
    for (let i = 1; i < b.s; i++) cells[b.r + i][b.d] = 'skip';
  }
  return cells;
}
const CELLS = buildCells();

/** 홈 화면의 주간 시간표 격자. palette 를 바꾸면 색이 즉시 바뀐다. */
export function MockGrid({ palette = DEFAULT_PAL, rows = HOURS.length }) {
  const colorOf = (name) => palette.colors[COURSE_ORDER.indexOf(name) % palette.colors.length];
  return (
    <table className="ab-tt">
      <thead>
        <tr>
          <th className="ab-tt-corner" />
          {DAYS.map((d) => <th key={d}>{d}</th>)}
        </tr>
      </thead>
      <tbody>
        {HOURS.slice(0, rows).map((h, r) => (
          <tr key={h}>
            <th className="ab-tt-hour">
              <span className="ab-tt-p">{r + 1}</span>
              <span className="ab-tt-h">{h}</span>
            </th>
            {DAYS.map((_, d) => {
              const cell = CELLS[r][d];
              if (cell === 'skip') return null;
              if (!cell) return <td key={d} />;
              if (cell.kind === 'block') {
                return (
                  <td key={d} className="ab-tt-block" rowSpan={cell.s}>
                    <span className="ab-tt-cell">
                      <span className="ab-tt-course">자율선택형교과</span>
                    </span>
                  </td>
                );
              }
              return (
                <td
                  key={d}
                  className="ab-tt-on"
                  rowSpan={cell.s}
                  style={{ background: colorOf(cell.c), '--ab-cell-fg': palette.fg }}
                >
                  <span className={`ab-tt-cell${cell.custom ? ' ab-tt-custom' : ''}`}>
                    {cell.custom && <span className="ab-tt-custom-tag">직접</span>}
                    <span className="ab-tt-course">{cell.c}</span>
                    {cell.m && <span className="ab-tt-meta">{cell.m}</span>}
                  </span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ────────── 폰 프레임 ────────── */
export function Phone({ theme = 'light', children }) {
  return (
    <div className="ab-phone-wrap">
      <div className="ab-phone" data-ab-theme={theme}>
        <div className="ab-phone-screen">
          <div className="ab-status">
            <span>9:41</span>
            <span className="ab-status-dots">▮▮▮ ⌁ 100%</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** 목업 안의 앱 헤더. back 이 있으면 뒤로가기 화살표를 그린다. */
function Head({ title, back, left, right }) {
  return (
    <div className="ab-head">
      {back ? <span className="ab-head-back">‹</span> : left || <span className="ab-head-back" />}
      <span className="ab-head-title">{title}</span>
      {right || <span className="ab-head-right" />}
    </div>
  );
}

function Stars({ value }) {
  return (
    <span className="ab-stars">
      <span className="ab-stars-off">★★★★★</span>
      <span className="ab-stars-on" style={{ width: `${(value / 5) * 100}%` }}>★★★★★</span>
      <span className="ab-stars-val">{value.toFixed(1)}</span>
    </span>
  );
}

/* ══════════════════════════ 화면들 ══════════════════════════ */

function ScreenHome({ palette }) {
  return (
    <>
      <div className="ab-head">
        <span className="ab-m-row" style={{ gap: '0.25rem' }}>
          <span className="ab-badge ab-badge-silver" style={{ width: 16, height: 16, fontSize: '0.45rem', borderRadius: 4 }}>42</span>
          <b style={{ fontSize: '0.7rem' }}>cadet26</b>
        </span>
        <span className="ab-head-title" />
        <span className="ab-head-act">로그아웃</span>
      </div>
      <div className="ab-body">
        <div className="ab-card">
          <div className="ab-tt-head">
            <span className="ab-tt-name">
              2026-1 내 시간표
              <span className="ab-tt-star">★</span>
              <span className="ab-tt-caret">▾</span>
            </span>
            <span className="ab-tt-acts">
              <span className="ab-tt-icon">🖼️</span>
              <span className="ab-tt-icon">👥</span>
              <span className="ab-tt-icon">⚙️</span>
              <span className="ab-tt-icon">＋</span>
            </span>
          </div>
          <MockGrid palette={palette} />
        </div>
        <div className="ab-nav">
          <div className="ab-nav-tile">
            <span className="ab-nav-ic" style={{ background: 'var(--primary-weak)', color: 'var(--primary)' }}>🔍</span>
            <div className="ab-nav-t">강의 검색</div>
            <div className="ab-nav-s">과목·강의평 찾기</div>
          </div>
          <div className="ab-nav-tile">
            <span className="ab-nav-ic" style={{ background: 'var(--warn-weak)', color: 'var(--warn)' }}>🎓</span>
            <div className="ab-nav-t">교수 검색</div>
            <div className="ab-nav-s">교수별 강의평·시간표</div>
          </div>
          <div className="ab-nav-tile">
            <span className="ab-nav-ic" style={{ background: 'var(--success-weak)', color: 'var(--success)' }}>🚪</span>
            <div className="ab-nav-t">빈 강의실</div>
            <div className="ab-nav-s">요일·교시로 찾기</div>
          </div>
          <div className="ab-nav-tile">
            <span className="ab-nav-ic" style={{ background: 'var(--accent-weak)', color: 'var(--accent)' }}>💬</span>
            <div className="ab-nav-t">익명게시판</div>
            <div className="ab-nav-s">자유롭게 이야기</div>
          </div>
        </div>
      </div>
    </>
  );
}

/* 마법사 — 4단계를 눌러 넘겨볼 수 있다 */
const WZ_STEPS = ['과목', '분반', '조건', '후보'];

function ScreenWizard({ palette, step, onStep }) {
  return (
    <>
      <Head title="시간표 마법사" back />
      <div className="ab-body">
        <ol className="ab-wz-steps">
          {WZ_STEPS.map((s, i) => (
            <li
              key={s}
              className={`ab-wz-step${i === step ? ' is-on' : ''}${i < step ? ' is-done' : ''}`}
              onClick={() => onStep(i)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStep(i); } }}
            >
              <span className="ab-wz-n">{i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <p className="ab-m-lead">들어야 하는 과목을 모두 담으세요. 분반은 다음 단계에서 고릅니다.</p>
            <div className="ab-m-input" style={{ marginTop: '0.45rem' }}>과목명 · 과목코드 · 교수명 검색</div>
            <div className="ab-m-label">담은 과목 (4)</div>
            <div className="ab-list">
              {[['항공기상학', 'AER201'], ['전자공학', 'ELE104'], ['군사학', 'MIL110'], ['영어회화', 'ENG205']].map(([n, c], i) => (
                <div className="ab-li" key={c}>
                  <span className="ab-wz-dot" style={{ background: palette.colors[i % palette.colors.length] }} />
                  <span className="ab-li-body">
                    <span className="ab-li-t">{n}</span>
                    <span className="ab-li-s">{c}</span>
                  </span>
                  <span className="ab-m-btn ab-m-btn-chip" style={{ padding: '0.22rem 0.4rem', fontSize: '0.55rem' }}>제거</span>
                </div>
              ))}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <p className="ab-m-lead"><b>들을 수 있는 것만 켜세요.</b> 켠 것만 후보에 들어갑니다.</p>
            <div className="ab-card" style={{ marginTop: '0.45rem' }}>
              <div className="ab-m-row" style={{ marginBottom: '0.3rem' }}>
                <span className="ab-wz-dot" style={{ background: palette.colors[0] }} />
                <span className="ab-m-title">항공기상학</span>
                <span className="ab-m-pill ab-m-pill-pri" style={{ marginLeft: 'auto' }}>분반 2/3</span>
              </div>
              {[
                { on: true, no: '1분반', prof: '김민수', t: '월1~2, 수1~2' },
                { on: true, no: '2분반', prof: '이서준', t: '화3~4, 목3' },
                { on: false, no: '3분반', prof: '교수 미정', t: '금5~6' },
              ].map((s) => (
                <div className={`ab-wz-sec${s.on ? ' is-on' : ''}`} key={s.no}>
                  <span className="ab-wz-box">✓</span>
                  <span className="ab-m-col" style={{ flex: 1, minWidth: 0 }}>
                    <span className="ab-m-row" style={{ gap: '0.25rem' }}>
                      <span className="ab-wz-sec-no">{s.no}</span>
                      <span className="ab-wz-sec-prof">{s.prof}</span>
                    </span>
                    <span className="ab-wz-sec-time">{s.t}</span>
                  </span>
                  <span className="ab-sec-flag">🚩</span>
                </div>
              ))}
            </div>
            <p className="ab-m-note">같은 시간에 교수만 다른 분반은 한 줄로 묶었습니다(시간표가 똑같으니까).</p>
          </>
        )}

        {step === 2 && (
          <>
            <p className="ab-m-lead">비우고 싶은 시간을 칠하세요(선택). 그 시간을 쓰는 분반은 후보에서 빠집니다.</p>
            <table className="ab-wz-block" style={{ marginTop: '0.45rem' }}>
              <thead>
                <tr><th style={{ width: 12 }} />{DAYS.map((d) => <th key={d}>{d}</th>)}</tr>
              </thead>
              <tbody>
                {[1, 2, 3, 4, 5, 6].map((p, r) => (
                  <tr key={p}>
                    <th>{p}</th>
                    {DAYS.map((_, d) => {
                      const noclass = (d === 1 || d === 3) && r >= 4;
                      const avoid = r === 0 || (d === 4 && r >= 4);
                      return (
                        <td key={d}>
                          <div className={`ab-wz-bcell${noclass ? ' is-noclass' : avoid ? ' is-on' : ''}`} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ab-wz-legend">
              <span><i className="ab-wz-key is-on" /> 피할 시간</span>
              <span><i className="ab-wz-key is-noclass" /> 수업 없는 시간</span>
            </div>
            <div className="ab-m-label">어떤 시간표를 위로 올릴까요?</div>
            <div className="ab-wz-sorts">
              <span className="ab-wz-sort is-on">오후 공강 많은 순</span>
              <span className="ab-wz-sort">오전 공강 많은 순</span>
              <span className="ab-wz-sort">1교시 적은 순</span>
              <span className="ab-wz-sort">낀 시간 적은 순</span>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <p className="ab-m-lead">겹치지 않는 조합 <b>312개</b> 중에서, 서로 성격이 다른 20개를 골랐습니다.</p>
            {[
              { rank: '#1', on: true, chips: [['공강 수·금', true], ['1교시 0', false]] },
              { rank: '#2', on: false, chips: [['오후 화', false], ['낀시간 1', false]] },
            ].map((c) => (
              <div className={`ab-cand${c.on ? ' is-on' : ''}`} key={c.rank} style={{ marginTop: '0.4rem' }}>
                <div className="ab-cand-head">
                  <span className="ab-cand-rank">{c.rank}</span>
                  {c.chips.map(([t, good]) => (
                    <span key={t} className={`ab-m-pill${good ? ' ab-m-pill-ok' : ''}`}>{t}</span>
                  ))}
                  <span className="ab-cand-box">{c.on ? '✓' : '＋'}</span>
                </div>
                <table className="ab-mini">
                  <thead>
                    <tr><th className="ab-mini-p" />{DAYS.map((d) => <th key={d}>{d}</th>)}</tr>
                  </thead>
                  <tbody>
                    {[0, 1, 2, 3, 4, 5].map((r) => (
                      <tr key={r}>
                        <th className="ab-mini-p">{r + 1}</th>
                        {DAYS.map((_, d) => {
                          const cell = CELLS[r][d];
                          if (cell === 'skip') return null;
                          if (!cell) return <td key={d} />;
                          if (cell.kind === 'block') return <td key={d} className="is-noclass" rowSpan={cell.s} />;
                          const bg = palette.colors[COURSE_ORDER.indexOf(cell.c) % palette.colors.length];
                          return (
                            <td key={d} className="is-on" rowSpan={cell.s} style={{ background: bg, '--ab-cell-fg': palette.fg }}>
                              <span className="ab-mini-c">{cell.c.slice(0, 2)}</span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <div className="ab-m-btn ab-m-btn-block" style={{ marginTop: '0.5rem' }}>1개 저장하기</div>
          </>
        )}
      </div>
    </>
  );
}

function ScreenSearch() {
  return (
    <>
      <Head title="강의 검색" back />
      <div className="ab-body">
        <div className="ab-m-input">과목명 · 과목코드 · 교수명 검색</div>
        <div className="ab-m-row" style={{ marginTop: '0.4rem', gap: '0.3rem' }}>
          <span className="ab-m-sub">담을 시간표</span>
          <span className="ab-m-input" style={{ flex: 1, padding: '0.24rem 0.4rem', fontSize: '0.58rem' }}>2026-1 내 시간표 ★확정</span>
        </div>
        <div className="ab-m-warnbox" style={{ marginTop: '0.4rem' }}>
          ⚠️ 강의 정보가 실제와 다를 수 있습니다. 틀린 곳은 <b>🚩 수정 제안</b>으로 알려 주세요.
        </div>
        <div className="ab-m-label">검색 결과</div>
        {[
          { n: '항공기상학', c: 'AER201-01', p: '김민수', t: '월1~2, 수1~2', on: true },
          { n: '항공기상학', c: 'AER201-02', p: '이서준', t: '화3~4, 목3', on: false },
          { n: '항공역학', c: 'AER310-01', p: '교수 미정', t: '금1~2', on: false },
        ].map((s) => (
          <div className={`ab-sec-card${s.on ? ' is-on' : ''}`} key={s.c}>
            <span className="ab-m-col" style={{ flex: 1, minWidth: 0 }}>
              <span className="ab-m-row" style={{ gap: '0.25rem' }}>
                <span className="ab-sec-name">{s.n}</span>
                <span className="ab-sec-code">{s.c}</span>
              </span>
              <span className="ab-m-sub">{s.p}</span>
              <span className="ab-sec-time">🕒 {s.t}</span>
              <span className="ab-sec-links">
                <span className="ab-sec-link">강의평 →</span>
                <span className="ab-sec-link">족보 →</span>
                <span className="ab-sec-flag">🚩 수정 제안</span>
              </span>
            </span>
            <span className={`ab-m-btn ${s.on ? 'ab-m-btn-chip' : ''}`} style={{ padding: '0.28rem 0.45rem', fontSize: '0.58rem' }}>
              {s.on ? '제거' : '＋ 추가'}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function ScreenReviews() {
  return (
    <>
      <Head title="항공기상학 강의평" back />
      <div className="ab-body">
        <div className="ab-card">
          <div className="ab-m-row">
            <b style={{ fontSize: '0.7rem' }}>김민수</b>
            <span className="ab-m-pill ab-m-pill-pri">12개</span>
          </div>
          <div style={{ marginTop: '0.28rem' }}><Stars value={4.3} /></div>
          <div className="ab-metrics">
            <span className="ab-metric"><span className="ab-metric-l">과제량</span><span className="ab-metric-v">3.5</span></span>
            <span className="ab-metric"><span className="ab-metric-l">진도</span><span className="ab-metric-v">4.0</span></span>
            <span className="ab-metric"><span className="ab-metric-l">난이도</span><span className="ab-metric-v">3.2</span></span>
            <span className="ab-metric"><span className="ab-metric-l">수업시간</span><span className="ab-metric-v">4.4</span></span>
            <span className="ab-metric ab-metric-fail"><span>과락률</span><span className="ab-metric-v">8%</span></span>
          </div>
        </div>
        <div className="ab-m-label">강의평</div>
        {[
          { p: '김민수', v: 4.5, tags: [['팀플', ''], ['발표', '']], c: '설명이 차분하고 진도가 일정해요.', s: '시험은 필기 위주. 정리본 있으면 수월합니다.', l: 7 },
          { p: '김민수', v: 3.0, tags: [['과락', 'warn']], c: '과제가 매주 있어요.', s: '', l: 2 },
        ].map((r, i) => (
          <div className="ab-rev-card" key={i}>
            <div className="ab-m-row">
              <b style={{ fontSize: '0.66rem' }}>{r.p}</b>
              <span style={{ marginLeft: 'auto' }}><Stars value={r.v} /></span>
            </div>
            <div className="ab-m-row" style={{ gap: '0.2rem', marginTop: '0.2rem' }}>
              {r.tags.map(([t, kind]) => (
                <span key={t} className={`ab-m-pill${kind === 'warn' ? ' ab-m-pill-danger' : ''}`}>{t}</span>
              ))}
            </div>
            <div className="ab-rev-com">👤 {r.c}</div>
            {r.s && <div className="ab-rev-com">📘 {r.s}</div>}
            <div className="ab-rev-bot">
              <span className="ab-m-pill ab-m-pill-danger">♥ {r.l}</span>
              <span>🚨 신고</span>
              <span style={{ marginLeft: 'auto' }}>삭제</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ScreenReviewWrite() {
  const SCORES = [['종합 *', 4], ['과제량', 3], ['진도', 4], ['난이도', 3], ['수업시간', 5]];
  return (
    <>
      <Head title="항공기상학 강의평 쓰기" back />
      <div className="ab-body">
        <div className="ab-card">
          <div className="ab-m-sub">교수</div>
          <div className="ab-m-input" style={{ marginTop: '0.2rem' }}>김민수</div>
          <div style={{ background: 'var(--surface)', borderRadius: 'var(--r-sm)', padding: '0.4rem 0.45rem', marginTop: '0.45rem' }}>
            <div className="ab-score-legend"><span>← 부정적</span><span>긍정적 →</span></div>
            {SCORES.map(([label, v]) => (
              <div className="ab-score-row" key={label}>
                <span className="ab-score-l">{label}</span>
                <span className="ab-score-s"><b>{'★'.repeat(v)}</b>{'★'.repeat(5 - v)}</span>
              </div>
            ))}
          </div>
          <div className="ab-m-row" style={{ gap: '0.5rem', marginTop: '0.45rem', fontSize: '0.58rem', color: 'var(--text-2)' }}>
            <span>☐ 나는 과락이다.</span><span>☑ 팀플 있음</span><span>☐ 발표 있음</span>
          </div>
          <div className="ab-m-input" style={{ marginTop: '0.4rem', height: '2rem' }}>수업 스타일, 성적 등</div>
          <div className="ab-m-input" style={{ marginTop: '0.3rem' }}>비우면 누구나 삭제 가능</div>
          <div className="ab-m-btn ab-m-btn-block" style={{ marginTop: '0.45rem' }}>강의평 등록</div>
        </div>
        <p className="ab-m-note">
          강의평은 <b>확정 시간표에 30일 이상 담은 강의</b>만 쓸 수 있습니다 — 안 들은 수업에 평을 남길 수 없게.
        </p>
      </div>
    </>
  );
}

function ScreenExams() {
  return (
    <>
      <Head title="항공기상학 족보" back />
      <div className="ab-body">
        <div className="ab-m-btn ab-m-btn-block">＋ 족보 올리기</div>
        <div className="ab-m-label">족보</div>
        {[
          { t: '2025-2 중간 정리', k: '중간고사', y: '2025-2학기 출처', d: '기출 위주로 정리했습니다.', f: [['항기_중간.pdf', '1.2MB'], ['요약본.hwp', '820KB']] },
          { t: '기말 기출 모음', k: '기말고사', y: '2024-2학기 출처', d: '', f: [['기말기출.zip', '14.6MB']] },
        ].map((e) => (
          <div className="ab-rev-card" key={e.t}>
            <div className="ab-m-row">
              <b style={{ fontSize: '0.66rem' }}>{e.t}</b>
              <span className="ab-m-pill ab-m-pill-accent" style={{ marginLeft: 'auto' }}>{e.k}</span>
            </div>
            <div className="ab-m-sub" style={{ marginTop: '0.15rem' }}>📅 {e.y}</div>
            {e.d && <div className="ab-rev-com">{e.d}</div>}
            {e.f.map(([n, s]) => (
              <div className="ab-m-row" key={n} style={{ marginTop: '0.28rem' }}>
                <span style={{ fontSize: '0.58rem' }}>📎</span>
                <span className="ab-li-t" style={{ flex: 1, fontSize: '0.6rem', fontWeight: 600 }}>{n}</span>
                <span className="ab-m-sub">{s}</span>
                <span className="ab-m-btn" style={{ padding: '0.18rem 0.35rem', fontSize: '0.55rem' }}>⬇</span>
              </div>
            ))}
            <div className="ab-m-sub" style={{ marginTop: '0.28rem' }}>⏳ 만료 2028.03.14</div>
          </div>
        ))}
      </div>
    </>
  );
}

function ScreenMemo() {
  return (
    <>
      <Head title="항공기상학 메모" back />
      <div className="ab-body">
        <div className="ab-m-sub">김민수 · 월1~2, 수1~2 · 1분반</div>
        <div className="ab-m-col ab-m-gap" style={{ marginTop: '0.45rem' }}>
          <span className="ab-m-btn ab-m-btn-block">✍️ 강의평 쓰기</span>
          <span className="ab-m-btn ab-m-btn-ghost ab-m-btn-block">📄 족보 보기</span>
        </div>
        <div className="ab-card" style={{ marginTop: '0.5rem' }}>
          <div className="ab-m-input" style={{ height: '1.9rem' }}>이번 수업 공지·과제·시험범위 등을 공유하세요</div>
          <div className="ab-m-row" style={{ marginTop: '0.3rem', gap: '0.3rem' }}>
            <span className="ab-m-input" style={{ flex: 1 }}>삭제용 비번 (선택)</span>
            <span className="ab-m-btn" style={{ padding: '0.3rem 0.5rem', fontSize: '0.6rem' }}>메모 등록</span>
          </div>
        </div>
        <div className="ab-m-label">메모</div>
        {[
          { c: '다음 주 화요일 휴강이래요. 대신 금요일 5교시 보강입니다.', d: '2026. 3. 12. 오후 4:20' },
          { c: '중간 범위: 1~5장. 구름 분류표는 꼭 외우라고 하셨음', d: '2026. 3. 10. 오전 9:05' },
        ].map((m) => (
          <div className="ab-rev-card" key={m.d}>
            <div style={{ fontSize: '0.62rem', lineHeight: 1.5 }}>{m.c}</div>
            <div className="ab-rev-bot">
              <span>{m.d}</span>
              <span style={{ marginLeft: 'auto' }}>🚨 신고</span>
              <span>삭제</span>
            </div>
          </div>
        ))}
        <p className="ab-m-note">이 분반을 <b>확정 시간표에 담은 생도만</b> 열 수 있습니다.</p>
      </div>
    </>
  );
}

function ScreenBoards() {
  return (
    <>
      <Head title="익명게시판" back />
      <div className="ab-body">
        <div className="ab-m-input">게시판 검색 후 Enter</div>
        <div className="ab-hot" style={{ marginTop: '0.45rem' }}>
          <span className="ab-hot-ic">🔥</span>
          <span className="ab-m-col" style={{ flex: 1 }}>
            <span className="ab-hot-t">HOT 게시판</span>
            <span className="ab-hot-s">지금 가장 화제인 글 모아보기</span>
          </span>
          <span className="ab-li-chev">›</span>
        </div>
        <div className="ab-m-label">게시판 목록</div>
        <div className="ab-list">
          {['자유', '우주공학과', '운동', '중대별', '질문', '취미'].map((b, i) => (
            <div className="ab-li" key={b}>
              <span className="ab-li-lead">{b[0]}</span>
              <span className="ab-li-body"><span className="ab-li-t">{b}</span></span>
              <span style={{ color: i < 2 ? 'var(--star)' : 'var(--text-3)', fontSize: '0.75rem' }}>{i < 2 ? '★' : '☆'}</span>
              <span className="ab-li-chev">›</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ScreenBoard() {
  return (
    <>
      <Head title="자유" back right={<span className="ab-head-act">글쓰기</span>} />
      <div className="ab-body">
        <div className="ab-list">
          {[
            { t: '내일 체력검정 준비 어떻게 하세요?', p: '3km 페이스 조절이 제일 어렵던데 다들 어떻게…', m: ['2시간 전', '👀 214', '💬 12', '👍 18'], hot: true },
            { t: '항공기상학 중간 범위 확인된 분', p: '교수님이 1~5장이라고 하신 것 같은데 맞나요?', m: ['5시간 전', '👀 88', '💬 4', '👍 6'], img: true },
            { t: '식당 신메뉴 후기', p: '오늘 나온 거 생각보다 괜찮았어요', m: ['어제', '👀 341', '💬 27', '👍 42'] },
            { t: '(제목 없음)', p: '주말 외출 같이 가실 분 계신가요', m: ['3.12.', '👀 52', '💬 2'] },
          ].map((p) => (
            <div className="ab-li" key={p.t} style={{ alignItems: 'flex-start' }}>
              <span className="ab-li-body">
                <span className="ab-m-row" style={{ gap: '0.22rem' }}>
                  <span className="ab-li-t" style={{ flex: '0 1 auto' }}>{p.t}</span>
                  {p.hot && <span style={{ fontSize: '0.55rem' }}>🔥</span>}
                  {p.img && <span style={{ fontSize: '0.55rem' }}>🖼</span>}
                </span>
                <span className="ab-li-s">{p.p}</span>
                <span className="ab-li-meta">{p.m.map((m) => <span key={m}>{m}</span>)}</span>
              </span>
            </div>
          ))}
        </div>
        <p className="ab-m-note" style={{ textAlign: 'center' }}>모든 글을 불러왔어요</p>
      </div>
    </>
  );
}

function ScreenPost() {
  return (
    <>
      <Head title="게시글" back />
      <div className="ab-body">
        <div className="ab-post-title">내일 체력검정 준비 어떻게 하세요?</div>
        <div className="ab-m-row" style={{ gap: '0.28rem', marginTop: '0.25rem' }}>
          <span className="ab-m-pill ab-m-pill-pri">자유</span>
          <span className="ab-m-pill ab-m-pill-warn">🔥 HOT</span>
          <span className="ab-m-sub">2시간 전</span>
          <span className="ab-m-sub">👀 214</span>
        </div>
        <div className="ab-post-body">
          3km 페이스 조절이 제일 어렵던데 다들 어떻게 하시나요? 초반에 너무 빨리 나가면 뒤에서 무너지고,
          아끼면 기록이 안 나오고…
        </div>
        <div className="ab-post-img">🖼</div>
        <div className="ab-react">
          <span className="ab-react-pill is-on">👍 <b>18</b></span>
          <span className="ab-react-pill">👎 <b>1</b></span>
          <span className="ab-react-pill is-rep">🚨 <b>0</b></span>
          <span className="ab-react-pill is-on">🔔 알림</span>
        </div>
        <div className="ab-m-label">댓글 3</div>
        <div className="ab-comment" style={{ borderTop: 0, paddingTop: 0 }}>
          <div className="ab-comment-b">첫 1km는 일부러 느리게 갑니다. 후반에 올리는 게 기록이 더 나와요.</div>
          <div className="ab-reply">↳ 저도 이 방법으로 30초 줄였어요</div>
        </div>
        <div className="ab-comment">
          <div className="ab-comment-b">전날 스트레칭이랑 수면이 진짜 큽니다</div>
        </div>
      </div>
    </>
  );
}

function ScreenProfessors() {
  return (
    <>
      <Head title="김민수" back />
      <div className="ab-body">
        <div className="ab-card">
          <div className="ab-m-row" style={{ alignItems: 'flex-start' }}>
            <span className="ab-m-col" style={{ flex: 1 }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 800 }}>김민수</span>
              <span className="ab-m-sub">항공우주공학과</span>
              <span className="ab-m-sub">📍 단재관 334호</span>
            </span>
            <span className="ab-m-col" style={{ alignItems: 'flex-end' }}>
              <Stars value={4.3} />
              <span className="ab-m-sub" style={{ marginTop: '0.15rem' }}>강의평 27개</span>
              <span className="ab-sec-flag">🚩 정보 수정 제안</span>
            </span>
          </div>
        </div>
        <div className="ab-m-label">2026-1 담당 시간표</div>
        {[['항공기상학 1분반', '월1~2, 수1~2'], ['항공역학 2분반', '화3~4']].map(([n, t]) => (
          <div className="ab-sec-card" key={n}>
            <span className="ab-m-col" style={{ flex: 1 }}>
              <span className="ab-sec-name">{n}</span>
              <span className="ab-sec-time">🕒 {t}</span>
            </span>
          </div>
        ))}
        <div className="ab-m-label">교수별 강의평</div>
        <div className="ab-card">
          <div className="ab-m-row">
            <b style={{ fontSize: '0.68rem' }}>항공기상학</b>
            <span style={{ marginLeft: 'auto' }}><Stars value={4.3} /></span>
          </div>
          <div className="ab-metrics">
            <span className="ab-metric"><span className="ab-metric-l">과제량</span><span className="ab-metric-v">3.5</span></span>
            <span className="ab-metric"><span className="ab-metric-l">난이도</span><span className="ab-metric-v">3.2</span></span>
            <span className="ab-metric ab-metric-fail"><span>과락률</span><span className="ab-metric-v">8%</span></span>
          </div>
          <div style={{ fontSize: '0.55rem', fontWeight: 600, color: 'var(--primary)', marginTop: '0.3rem' }}>이 과목 강의평 →</div>
        </div>
      </div>
    </>
  );
}

function ScreenRooms() {
  const sel = [[0, 2], [0, 3], [2, 2]];
  return (
    <>
      <Head title="빈 강의실" back />
      <div className="ab-body">
        <div className="ab-card">
          <div className="ab-m-row" style={{ marginBottom: '0.3rem' }}>
            <span className="ab-m-title">2026-1 요일·교시 선택</span>
            <span className="ab-m-pill" style={{ marginLeft: 'auto' }}>📍 지금</span>
          </div>
          <table className="ab-er">
            <thead>
              <tr><th style={{ width: 14 }} />{DAYS.map((d) => <th key={d}>{d}</th>)}</tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6].map((p, r) => (
                <tr key={p}>
                  <th>{p}</th>
                  {DAYS.map((_, d) => {
                    const on = sel.some(([sd, sr]) => sd === d && sr === r);
                    return (
                      <td key={d}>
                        <div className={`ab-er-cell${on ? ' is-on' : ''}`}>{[9, 14, 6, 21, 11, 17][(d + r) % 6]}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ab-m-note">칸의 숫자는 그 시간의 빈 강의실 수. 여러 칸을 고르면 <b>모두 비는</b> 곳만 나옵니다.</p>
        </div>
        <div className="ab-card" style={{ marginTop: '0.45rem' }}>
          <div className="ab-m-row">
            <span className="ab-m-title">빈 강의실 5곳</span>
            <span className="ab-m-sub" style={{ marginLeft: 'auto' }}>월3, 월4, 수3</span>
          </div>
          <div className="ab-er-rooms">
            {['302', '305', '411', '단재관 201', '충무관 106'].map((r) => (
              <span className="ab-er-room" key={r}>{r}</span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function ScreenFriends({ palette }) {
  return (
    <>
      <Head title="👥 시간표 공유" back />
      <div className="ab-body">
        <div className="ab-toggle">
          <span className="ab-switch" />
          <span className="ab-m-col" style={{ flex: 1 }}>
            <span className="ab-m-title">내 확정시간표 공개</span>
            <span className="ab-m-sub">아이디로 검색해 볼 수 있어요</span>
          </span>
        </div>
        <div className="ab-m-input" style={{ marginTop: '0.45rem' }}>아이디 검색 후 Enter</div>
        <div className="ab-m-label">친구 시간표</div>
        <div className="ab-card">
          <div className="ab-m-row" style={{ marginBottom: '0.35rem' }}>
            <span className="ab-m-col">
              <span className="ab-m-title">지훈</span>
              <span className="ab-m-sub">cadet_jh</span>
            </span>
            <span className="ab-m-pill" style={{ marginLeft: 'auto' }}>별칭</span>
            <span className="ab-m-pill">삭제</span>
          </div>
          <MockGrid palette={palette} rows={4} />
        </div>
        <p className="ab-m-note">
          공개는 <b>내가 켤 때만</b>. 언제든 끌 수 있고, 게시판 익명성과는 완전히 별개입니다.
        </p>
      </div>
    </>
  );
}

function ScreenProfile() {
  return (
    <>
      <Head title="프로필" back />
      <div className="ab-body">
        <div className="ab-card">
          <div className="ab-m-row" style={{ gap: '0.55rem' }}>
            <span className="ab-badge ab-badge-silver">42</span>
            <span className="ab-m-col">
              <span className="ab-m-title" style={{ fontSize: '0.82rem' }}>cadet26</span>
              <span className="ab-m-sub">실버 · Lv.42</span>
            </span>
          </div>
          <div className="ab-m-row" style={{ marginTop: '0.45rem' }}>
            <span className="ab-m-sub">다음 등급 <b style={{ color: 'var(--text)' }}>골드</b></span>
            <span className="ab-m-sub" style={{ marginLeft: 'auto' }}>42 / 100</span>
          </div>
          <div className="ab-bar-track"><div className="ab-bar-fill" style={{ width: '42%' }} /></div>
          <div className="ab-m-note">58회 더 작성하면 골드 등급이 됩니다.</div>
        </div>
        <div className="ab-m-label">레벨 등급</div>
        <div className="ab-card">
          {[['bronze', '브론즈', '0회+'], ['silver', '실버', '20회+'], ['gold', '골드', '100회+'], ['rainbow', '레인보우', '200회+']].map(([k, n, m]) => (
            <div className="ab-m-row" key={k} style={{ padding: '0.22rem 0', gap: '0.45rem' }}>
              <span className={`ab-badge ab-badge-${k}`} style={{ width: 18, height: 18, fontSize: '0.45rem', borderRadius: 4 }} />
              <span style={{ fontSize: '0.65rem', fontWeight: 650 }}>{n}</span>
              <span className="ab-m-sub" style={{ marginLeft: 'auto' }}>{m}</span>
            </div>
          ))}
        </div>
        <div className="ab-m-label">푸시 알림</div>
        <div className="ab-card">
          <div className="ab-m-row"><span className="ab-switch" /><span className="ab-m-sub" style={{ flex: 1 }}>🔥 HOT 승격 게시글 알림</span></div>
          <div className="ab-m-row" style={{ marginTop: '0.3rem' }}><span className="ab-switch" /><span className="ab-m-sub" style={{ flex: 1 }}>🌙 방해금지 22:30 ~ 08:00</span></div>
        </div>
      </div>
    </>
  );
}

/* ══════════════════════════ 화면 목록 ══════════════════════════ */

export const SCREENS = [
  {
    key: 'home', tab: '시간표', icon: '🗓️', name: '홈 — 내 시간표',
    desc: '학기마다 시간표를 최대 5개까지 만들고, 그중 하나를 ★확정으로 지정합니다. 연강은 자동으로 하나로 병합돼요.',
    points: [
      ['🔀', '<b>시간표 전환 드롭다운</b> — 여러 안을 만들어 두고 이름 바꾸기·확정 지정·삭제까지 한자리에서.'],
      ['🖼️', '<b>이미지로 저장</b> — 캔버스로 직접 그려서 아이폰 사진 저장·공유까지 됩니다.'],
      ['＋', '<b>직접 추가</b> — DB에 없는 자율학습·개인일정도 요일·시간으로 바로 넣을 수 있어요.'],
      ['⚠️', '<b>겹침 감지</b> — 저장한 뒤 수업정보가 바뀌어 시간이 겹치면 홈에서 짚어 주고 마법사로 넘겨줍니다.'],
    ],
    Screen: ScreenHome,
  },
  {
    key: 'wizard', tab: '마법사', icon: '🪄', name: '시간표 마법사',
    desc: '들을 과목만 담으면 겹치지 않는 조합을 전부 만들어 비교해 줍니다. 계산은 전부 기기에서 — 서버 요청 0회.',
    points: [
      ['1️⃣', '<b>과목 담기</b> — 들어야 하는 과목을 검색해 담습니다.'],
      ['2️⃣', '<b>들을 수 있는 분반만 켜기</b> — 끈 분반은 어떤 후보에도 임의로 들어가지 않습니다.'],
      ['3️⃣', '<b>기피 시간 칠하기</b> — 칠한 시간을 쓰는 분반이 빠지고, 오후/오전 공강 순 등으로 정렬합니다.'],
      ['4️⃣', '<b>후보 비교·저장</b> — 미니 격자로 훑고 최대 5개 저장, 그중 하나를 확정으로.'],
      ['🧩', '조합이 0이면 <b>함께 못 듣는 과목 쌍</b>을 짚어 줍니다.'],
    ],
    Screen: ScreenWizard,
    interactive: '탭을 눌러 4단계를 넘겨 보세요',
  },
  {
    key: 'search', tab: '강의 검색', icon: '🔍', name: '강의 검색 → 시간표 추가',
    desc: '과목명·과목코드·교수명으로 찾아 담을 시간표를 골라 바로 추가합니다. 카탈로그는 기기에 캐시돼 오프라인에서도 열려요.',
    points: [
      ['⛔', '겹치는 시간·다른 학기는 <b>DB 트리거가 거부</b>합니다 — 잘못 담길 수가 없어요.'],
      ['🚩', '<b>수정 제안</b> — 시간·강의실·교수·과목명이 틀리면 익명으로 알려 주고, 관리자 검토 후 반영됩니다.'],
      ['📴', '카탈로그 IndexedDB 캐시 우선 — <b>오프라인에서도</b> 검색됩니다.'],
    ],
    Screen: ScreenSearch,
  },
  {
    key: 'reviews', tab: '강의평', icon: '⭐', name: '강의평',
    desc: '종합·과제량·진도·난이도·수업시간 5개 항목과 과락률까지. 교수별·과목별로 모아 봅니다.',
    points: [
      ['✍️', '<b>확정 시간표에 30일 이상 담은 강의</b>만 작성 가능 — 안 들은 수업에 평을 남길 수 없습니다.'],
      ['🕵️', '작성자 컬럼이 <b>아예 없습니다</b>. 수정·삭제는 글 비밀번호로만.'],
      ['🔒', '기기에 1인 1회 잠금이 걸려 같은 강의에 중복 작성이 막힙니다.'],
      ['♥', '공감·신고 — 신고가 쌓이면 글만 자동 삭제되고, 신고자도 작성자도 추적하지 않습니다.'],
    ],
    Screen: ScreenReviews,
  },
  {
    key: 'write', tab: '강의평 쓰기', icon: '📝', name: '강의평 작성',
    desc: '왼쪽이 부정, 오른쪽이 긍정. 별 5개로 5개 항목을 매기고 과락·팀플·발표 여부를 함께 남깁니다.',
    points: [
      ['⭐', '<b>종합만 필수</b> — 나머지는 아는 것만 매겨도 됩니다.'],
      ['🔑', '삭제용 비밀번호는 <b>선택</b>. 비우면 누구나 지울 수 있게 두는 것도 익명 커뮤니티의 선택지입니다.'],
      ['🧼', '비속어는 korcen + 사전 정규식으로 <b>부분 마스킹</b>됩니다(변형·초성 포함).'],
    ],
    Screen: ScreenReviewWrite,
  },
  {
    key: 'exams', tab: '족보', icon: '📂', name: '족보',
    desc: '기출·요약본을 과목별로 모읍니다. 파일은 Cloudflare R2에 올라가고 앱이 중계해 내려받습니다.',
    points: [
      ['📎', '한 글에 <b>최대 10개 · 각 100MB</b>까지. PDF·한글·PPT·ZIP·이미지.'],
      ['⏳', '보관 기한이 지나면 <b>자동 삭제</b>됩니다 — 만료일이 카드에 그대로 적혀 있어요.'],
      ['🔐', '다운로드는 로그인 검증(JWT)을 거친 중계로만 — 링크만으로는 열리지 않습니다.'],
    ],
    Screen: ScreenExams,
  },
  {
    key: 'memo', tab: '수업메모', icon: '🗒️', name: '수업 메모 (분반 전용)',
    desc: '휴강·보강·시험범위처럼 그 분반 사람만 아는 정보를 나눕니다. 시간표에서 수업 칸을 누르면 바로 열려요.',
    points: [
      ['🔒', '<b>그 분반을 확정 시간표에 담은 생도만</b> 열람·작성 — 초안 시간표로는 열리지 않습니다.'],
      ['🚪', '초안에 아무 분반이나 담아 남의 반 메모를 엿보는 우회를 서버에서 막습니다.'],
      ['♻️', '분반에 종속된 휘발성 정보 — 학기가 지나면 정리됩니다.'],
    ],
    Screen: ScreenMemo,
  },
  {
    key: 'boards', tab: '게시판', icon: '💬', name: '익명게시판',
    desc: '원하는 이름으로 게시판을 직접 만들고 즐겨찾기합니다. 30분 안에 반응이 몰리면 HOT으로 올라가요.',
    points: [
      ['➕', '검색해서 없으면 <b>그 이름으로 바로 새 게시판</b>을 만들 수 있습니다.'],
      ['🔥', '<b>HOT</b> — 30분 내 공감·비공감·댓글 합이 10건을 넘으면 자동 승격돼 최상단에 고정됩니다.'],
      ['⭐', '즐겨찾기한 게시판이 위로 올라옵니다.'],
      ['🧹', '글 90일·비활성 게시판 30일이면 자정에 자동 정리됩니다.'],
    ],
    Screen: ScreenBoards,
  },
  {
    key: 'board', tab: '글 목록', icon: '📋', name: '글 목록',
    desc: '15개씩 무한 스크롤. 제목·미리보기·조회·댓글·공감이 한 줄에 들어옵니다.',
    points: [
      ['🖼', '이미지가 붙은 글은 아이콘으로 표시 — <b>저화질 썸네일</b>을 먼저 받고 탭하면 원본을 엽니다.'],
      ['🔻', '아래로 당겨 새로고침 — 브라우저 기본 동작을 끄고 앱처럼 인디케이터만 내려옵니다.'],
      ['🚫', '캡처 방지(텍스트 선택·이미지 드래그 차단)가 게시판 계열에 걸려 있습니다.'],
    ],
    Screen: ScreenBoard,
  },
  {
    key: 'post', tab: '글 상세', icon: '🗨️', name: '글 상세 · 댓글',
    desc: '공감·비공감·신고·알림이 한 줄에. 댓글은 대댓글까지 한 단계 들어갑니다.',
    points: [
      ['🔔', '<b>글마다 알림</b>을 켜면 새 댓글이 달릴 때 푸시가 옵니다.'],
      ['🚨', '신고 <b>15분 내 10건</b> 또는 <b>누적 30건</b>이면 글이 자동 삭제됩니다.'],
      ['🗑️', '삭제는 글 비밀번호로. 관리자는 복구용 스냅샷으로만 볼 수 있고 작성자는 알 수 없습니다.'],
    ],
    Screen: ScreenPost,
  },
  {
    key: 'prof', tab: '교수', icon: '🎓', name: '교수 검색 · 상세',
    desc: '교수별 평점과 이번 학기 담당 시간표, 과목별 강의평을 한 화면에 모읍니다.',
    points: [
      ['🔄', '교수 명단은 <b>공사 공식 홈페이지에서 주기적으로 동기화</b>됩니다(추가·학과변경만, 삭제 없음).'],
      ['🧬', '표기가 갈린 동일 교수는 관리자가 <b>통합</b>해 분반·강의평·제안을 한 사람으로 합칩니다.'],
      ['🚩', '학과·연구실 위치가 틀리면 정보 수정 제안을 보낼 수 있어요.'],
    ],
    Screen: ScreenProfessors,
  },
  {
    key: 'rooms', tab: '빈 강의실', icon: '🚪', name: '빈 강의실',
    desc: '요일×교시 칸을 여러 개 고르면 그 시간에 모두 비어 있는 강의실만 남깁니다.',
    points: [
      ['📍', '<b>지금</b> 버튼이 현재 요일·교시를 바로 집어 줍니다.'],
      ['🔢', '칸에 적힌 숫자가 그 시간의 빈 강의실 수 — 고르기 전에 감이 옵니다.'],
      ['ℹ️', '시간표에 등록된 정규 수업 기준이라, 예약·행사·자습 사용 여부는 다를 수 있습니다.'],
    ],
    Screen: ScreenRooms,
  },
  {
    key: 'friends', tab: '친구 시간표', icon: '👥', name: '친구 시간표 공유',
    desc: '내가 공개를 켠 경우에만 아이디로 검색됩니다. 담아 둔 친구들의 시간표를 한 화면에서 훑어봐요.',
    points: [
      ['🔓', '<b>기본은 비공개</b>. 내가 토글을 켤 때만 검색·조회가 열리고 언제든 끌 수 있습니다.'],
      ['🏷️', '친구마다 <b>별칭</b>을 붙이고, 손잡이를 끌어 순서를 바꿉니다.'],
      ['🛡️', '조회는 서버 함수로만 — 공개 여부를 서버가 강제해 URL을 알아도 못 봅니다.'],
      ['🙈', '게시판 익명성과는 <b>완전히 별개</b>입니다.'],
    ],
    Screen: ScreenFriends,
  },
  {
    key: 'profile', tab: '레벨·설정', icon: '🏅', name: '레벨 · 프로필 · 알림',
    desc: '강의평·메모·족보를 쓸수록 레벨이 오릅니다. 테마·팔레트·푸시 설정도 여기에.',
    points: [
      ['🥉', '브론즈 → <b>실버 20</b> → <b>골드 100</b> → <b>레인보우 200</b>. 작성 +1, 삭제 −1.'],
      ['🌙', '<b>방해금지</b> 기본 22:30~08:00 — 이 시간엔 소리·진동 없이 조용히 도착합니다.'],
      ['📵', '방해금지 시간대는 <b>기기에만</b> 저장됩니다 — 서버는 시간대조차 받지 않아요.'],
      ['🗑️', '탈퇴하면 계정 정보는 지워지고, 익명으로 남긴 글은 작성자 정보가 없어 그대로 남습니다.'],
    ],
    Screen: ScreenProfile,
  },
];
