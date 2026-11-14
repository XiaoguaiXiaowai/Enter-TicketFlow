import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <section className="panel">
      <h1>页面不存在</h1>
      <p className="lead">请从首页重新进入。</p>
      <Link to="/">返回首页</Link>
    </section>
  );
}
