import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog } from '../lib/cache';
import { downloadExam, deleteExam, examFiles, examExpiry } from '../lib/storage';
import ExamForm from '../components/ExamForm';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';

// 파일 크기 표기(1.2MB 등)
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))}KB`;
  return `${(kb / 1024).toFixed(1)}MB`;
}
// 만료일 표기(YYYY.MM.DD)
function fmtDate(d) {
  if (!d) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

const DEL_MSG = {
  BAD_PASSWORD: '비밀번호가 일치하지 않습니다.',
  NOT_FOUND: '이미 삭제되었거나 없는 글입니다.',
  BAD_REQUEST: '잘못된 요청입니다.',
  ERROR: '삭제 중 오류가 발생했습니다.',
};

// 화면7: 족보 (조회·다운로드는 로그인 사용자 / 작성·삭제는 게시글 비번)
export default function Exams() {
  const { courseCode } = useParams();
  const [courseName, setCourseName] = useState(courseCode);
  const [exams, setExams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [delTarget, setDelTarget] = useState(null);
  const [delPw, setDelPw] = useState('');
  const [delErr, setDelErr] = useState('');

  // silent: 당겨서 새로고침 때는 목록을 '불러오는 중…'으로 갈아치우지 않는다
  async function loadAll(silent = false) {
    if (!silent) setLoading(true);
    const catalog = await getCatalog().catch(() => null);
    const course = catalog?.course?.find((c) => c.code === courseCode);
    if (course) setCourseName(course.name);

    const { data } = await supabase
      .from('exam_archive')
      .select('*')
      .eq('course_code', courseCode)
      .order('created_at', { ascending: false });
    setExams(data ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseCode]);

  async function download(file, fallbackName) {
    setBusyId(file.key);
    try {
      await downloadExam(file.key, file.name || fallbackName);
    } catch {
      alert('다운로드에 실패했습니다.');
    } finally {
      setBusyId(null);
    }
  }

  // 비번 없는(누구나 삭제 가능) 족보: 확인 후 바로 삭제
  async function deleteOpen(id) {
    if (!confirm('이 족보를 삭제할까요?')) return;
    const status = await deleteExam(id, '');
    if (status === 'OK') { setExams((prev) => prev.filter((e) => e.id !== id)); return; }
    alert(DEL_MSG[status] || DEL_MSG.ERROR);
  }

  async function confirmDelete() {
    setDelErr('');
    const status = await deleteExam(delTarget, delPw);
    if (status === 'OK') {
      setExams((prev) => prev.filter((e) => e.id !== delTarget));
      setDelTarget(null);
      setDelPw('');
      return;
    }
    setDelErr(DEL_MSG[status] || DEL_MSG.ERROR);
  }

  return (
    <PullToRefresh className="page" onRefresh={() => loadAll(true)}>
      <header className="page-header">
        <BackButton fallback="/search" />
        <h2>{courseName} 족보</h2>
      </header>

      <div className="rev-actions">
        <button className={`btn-block ${showForm ? 'btn-remove' : 'btn-add'}`} onClick={() => setShowForm((v) => !v)}>
          {showForm ? '닫기' : '＋ 족보 올리기'}
        </button>
      </div>

      {showForm && (
        <ExamForm
          courseCode={courseCode}
          onDone={() => {
            setShowForm(false);
            loadAll();
          }}
        />
      )}

      <ul className="rev-list">
        {loading ? (
          <li className="muted center">불러오는 중…</li>
        ) : exams.length === 0 ? (
          <li className="empty">
            <span className="empty-emoji">📂</span>
            아직 올라온 족보가 없습니다.
          </li>
        ) : (
          exams.map((ex) => {
            const files = examFiles(ex);
            const expiry = examExpiry(ex.created_at);
            return (
            <li key={ex.id} className="rev-card exam-card">
              <div className="rev-card-top">
                <strong>{ex.title}</strong>
                <span className="tag tag-accent">{ex.exam_type ?? '기타'}</span>
              </div>
              <p className="exam-meta">
                <span className="exam-meta-ic" aria-hidden="true">📅</span>
                {ex.src_year ? `${ex.src_year}-${ex.src_term ?? '?'}학기 출처` : '출처 미상'}
              </p>
              {ex.description && <p className="rev-comment">{ex.description}</p>}

              <ul className="exam-files">
                {files.length === 0 && <li className="exam-file-row muted">첨부파일 없음</li>}
                {files.map((f, i) => (
                  <li key={f.key || i} className="exam-file-row">
                    <span className="exam-file-info">
                      <span className="exam-file-ic" aria-hidden="true">📎</span>
                      <span className="exam-file-name" title={f.name || ex.title}>{f.name || `첨부 ${i + 1}`}</span>
                      {f.size ? <span className="exam-file-size">{fmtSize(f.size)}</span> : null}
                    </span>
                    <button
                      className="btn-add btn-sm"
                      onClick={() => download(f, ex.title)}
                      disabled={busyId === f.key}
                    >
                      {busyId === f.key ? '…' : '⬇'}
                    </button>
                  </li>
                ))}
              </ul>

              {expiry && (
                <p className="exam-expire">
                  <span className="exam-meta-ic" aria-hidden="true">⏳</span>
                  만료 {fmtDate(expiry)}
                </p>
              )}

              <div className="rev-card-bottom exam-card-bottom">
                {ex.post_password_hash ? (
                  delTarget === ex.id ? (
                    <span className="rev-del">
                      <input
                        type="password"
                        value={delPw}
                        onChange={(e) => setDelPw(e.target.value)}
                        placeholder="게시글 비번"
                      />
                      <button className="btn-add btn-sm" onClick={confirmDelete}>확인</button>
                      <button className="btn-remove btn-sm" onClick={() => { setDelTarget(null); setDelPw(''); setDelErr(''); }}>취소</button>
                    </span>
                  ) : (
                    <button className="rev-del-btn" onClick={() => { setDelTarget(ex.id); setDelErr(''); }}>삭제</button>
                  )
                ) : (
                  <button className="rev-del-btn" onClick={() => deleteOpen(ex.id)}>삭제</button>
                )}
              </div>
              {delTarget === ex.id && delErr && <p className="error-msg">{delErr}</p>}
            </li>
            );
          })
        )}
      </ul>
    </PullToRefresh>
  );
}
