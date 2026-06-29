import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog } from '../lib/cache';
import { getDownloadUrl } from '../lib/storage';
import ExamForm from '../components/ExamForm';

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

  async function loadAll() {
    setLoading(true);
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

  async function download(ex) {
    setBusyId(ex.id);
    try {
      const url = await getDownloadUrl(ex.file_url, `${ex.title}`);
      window.open(url, '_blank', 'noopener');
    } catch {
      alert('다운로드 링크를 만들지 못했습니다.');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    setDelErr('');
    const { data, error } = await supabase.functions.invoke('exam-delete', {
      body: { id: delTarget, password: delPw },
    });
    let status = data?.status;
    if (error) {
      try {
        status = (await error.context?.json?.())?.status;
      } catch {
        /* ignore */
      }
    }
    if (status === 'OK') {
      setExams((prev) => prev.filter((e) => e.id !== delTarget));
      setDelTarget(null);
      setDelPw('');
      return;
    }
    setDelErr(DEL_MSG[status] || DEL_MSG.ERROR);
  }

  return (
    <div className="page">
      <header className="page-header row">
        <Link to="/search" className="link-btn">← 검색</Link>
        <h2>{courseName} 족보</h2>
        <span style={{ width: '2.5rem' }} />
      </header>

      <div className="rev-actions">
        <button className="btn-add" onClick={() => setShowForm((v) => !v)}>
          {showForm ? '닫기' : '족보 올리기'}
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
          <p className="muted center">불러오는 중…</p>
        ) : exams.length === 0 ? (
          <p className="muted center">아직 올라온 족보가 없습니다.</p>
        ) : (
          exams.map((ex) => (
            <li key={ex.id} className="rev-card">
              <div className="rev-card-top">
                <strong>{ex.title}</strong>
                <span className="tag">{ex.exam_type ?? '기타'}</span>
              </div>
              <p className="exam-meta">
                {ex.src_year ? `${ex.src_year}-${ex.src_term ?? '?'}` : '출처 미상'}
              </p>
              {ex.description && <p className="rev-comment">{ex.description}</p>}
              <div className="rev-card-bottom">
                <button className="btn-add" onClick={() => download(ex)} disabled={busyId === ex.id}>
                  {busyId === ex.id ? '…' : '다운로드'}
                </button>
                {delTarget === ex.id ? (
                  <span className="rev-del">
                    <input
                      type="password"
                      value={delPw}
                      onChange={(e) => setDelPw(e.target.value)}
                      placeholder="게시글 비번"
                    />
                    <button onClick={confirmDelete}>확인</button>
                    <button onClick={() => { setDelTarget(null); setDelPw(''); setDelErr(''); }}>취소</button>
                  </span>
                ) : (
                  <button className="rev-del-btn" onClick={() => { setDelTarget(ex.id); setDelErr(''); }}>삭제</button>
                )}
              </div>
              {delTarget === ex.id && delErr && <p className="error-msg">{delErr}</p>}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
