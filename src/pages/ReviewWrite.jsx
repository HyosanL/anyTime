import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getCatalog } from '../lib/cache';
import ReviewForm from '../components/ReviewForm';
import BackButton from '../components/BackButton';
import '../styles/course.css';

// 강의평 쓰기 전용 화면(족보 보기처럼 새 화면으로 진입). 작성 자격은 서버 RPC가 강제.
export default function ReviewWrite() {
  const { courseCode, year, term, sectionNo } = useParams();
  const y = Number(year);
  const t = Number(term);
  const sn = Number(sectionNo);
  const navigate = useNavigate();

  const [header, setHeader] = useState({ name: courseCode, prof: '', profCode: '' });

  useEffect(() => {
    (async () => {
      const catalog = await getCatalog().catch(() => null);
      if (!catalog) return;
      const course = catalog.course?.find((c) => c.code === courseCode);
      const section = catalog.section?.find(
        (s) => s.course_code === courseCode && s.year === y && s.term === t && s.section_no === sn
      );
      const prof = catalog.professor?.find((p) => p.code === section?.professor_code);
      setHeader({
        name: course?.name ?? courseCode,
        prof: prof?.name ?? '',
        profCode: section?.professor_code ?? '',
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseCode, year, term, sectionNo]);

  return (
    <div className="page">
      <header className="page-header">
        <BackButton fallback={`/reviews/${courseCode}`} />
        <h2>{header.name} 강의평 쓰기</h2>
      </header>

      <ReviewForm
        courseCode={courseCode}
        professors={header.profCode ? [{ code: header.profCode, name: header.prof }] : []}
        defaultProf={header.profCode}
        onDone={() => navigate(-1)}
      />
    </div>
  );
}
