import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { KbArticleResponse, KbArticleSummary } from '@ticket/shared';
import { useAuth } from '../auth/AuthContext';
import {
  ApiError,
  archiveKbArticle,
  createKbArticle,
  fetchKbArticle,
  fetchKbArticles,
  publishKbArticle,
  updateKbArticle,
} from '../lib/api';

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: KbArticleSummary[]; nextCursor: string | null }
  | { kind: 'error'; message: string };

export function KnowledgePage() {
  const { projectId, hasPermission } = useAuth();
  const [searchParams] = useSearchParams();
  const effectiveProjectId = searchParams.get('projectId') ?? projectId;

  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [selected, setSelected] = useState<KbArticleResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({ slug: '', title: '', body: '' });
  const [editForm, setEditForm] = useState({ title: '', body: '' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canWrite = hasPermission('kb', 'write');
  const canPublish = hasPermission('kb', 'publish');

  const loadList = useCallback(
    async (q: string, cursor?: string): Promise<void> => {
      if (effectiveProjectId === null) {
        setList({ kind: 'error', message: '请先在首页选择项目' });
        return;
      }
      try {
        const page = await fetchKbArticles(effectiveProjectId, {
          q,
          ...(cursor === undefined ? {} : { cursor }),
        });
        setList((previous) => ({
          kind: 'ready',
          items:
            cursor === undefined || previous.kind !== 'ready'
              ? page.items
              : [...previous.items, ...page.items],
          nextCursor: page.nextCursor,
        }));
      } catch (caught: unknown) {
        setList({
          kind: 'error',
          message: caught instanceof ApiError ? caught.message : '知识库加载失败',
        });
      }
    },
    [effectiveProjectId],
  );

  useEffect(() => {
    setList({ kind: 'loading' });
    void loadList('');
  }, [loadList]);

  async function search(): Promise<void> {
    setAppliedKeyword(keyword.trim());
    setList({ kind: 'loading' });
    await loadList(keyword.trim());
  }

  async function openArticle(id: string): Promise<void> {
    if (effectiveProjectId === null) {
      return;
    }
    setDetailError(null);
    setActionError(null);
    try {
      const article = await fetchKbArticle(id, effectiveProjectId);
      setSelected(article);
      const latest = article.versions[0];
      setEditForm({
        title: latest?.title ?? '',
        body: latest?.body ?? '',
      });
    } catch (caught: unknown) {
      setSelected(null);
      setDetailError(caught instanceof ApiError ? caught.message : '文章加载失败');
    }
  }

  async function submitCreate(): Promise<void> {
    if (effectiveProjectId === null || busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const article = await createKbArticle(effectiveProjectId, createForm);
      setCreateForm({ slug: '', title: '', body: '' });
      setNotice('草稿已创建，发布后才会出现在检索结果中。');
      await loadList(appliedKeyword);
      await openArticle(article.id);
    } catch (caught: unknown) {
      setActionError(caught instanceof ApiError ? `${caught.message}（${caught.code}）` : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft(): Promise<void> {
    if (effectiveProjectId === null || selected === null || busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const article = await updateKbArticle(selected.id, effectiveProjectId, editForm);
      setSelected(article);
      setEditForm({ title: article.versions[0]?.title ?? '', body: article.versions[0]?.body ?? '' });
      setNotice('已生成新的草稿版本，线上已发布内容保持不变。');
    } catch (caught: unknown) {
      setActionError(caught instanceof ApiError ? `${caught.message}（${caught.code}）` : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function publish(): Promise<void> {
    if (effectiveProjectId === null || selected === null || busy) {
      return;
    }
    const latest = selected.versions[0];
    if (latest === undefined) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await publishKbArticle(selected.id, effectiveProjectId, latest.versionNo);
      setNotice(`已发布 v${latest.versionNo}。`);
      await loadList(appliedKeyword);
      await openArticle(selected.id);
    } catch (caught: unknown) {
      setActionError(
        caught instanceof ApiError ? `${caught.message}（${caught.code}）` : '发布失败',
      );
    } finally {
      setBusy(false);
    }
  }

  async function archive(): Promise<void> {
    if (effectiveProjectId === null || selected === null || busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await archiveKbArticle(selected.id, effectiveProjectId);
      setNotice('文章已归档，检索不再返回该文章。');
      setSelected(null);
      await loadList(appliedKeyword);
    } catch (caught: unknown) {
      setActionError(caught instanceof ApiError ? `${caught.message}（${caught.code}）` : '归档失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workbench" data-testid="knowledge-page">
      <section className="panel">
        <div className="page-head">
          <div>
            <h1>知识库</h1>
            <p className="lead">检索只覆盖已发布版本；编辑会先生成草稿，不影响线上回复。</p>
          </div>
          <Link to="/">返回工作台</Link>
        </div>

        <div className="inline-form">
          <input
            className="input-field"
            placeholder="搜索标题或正文，支持中文短语"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void search();
              }
            }}
            data-testid="kb-search-input"
          />
          <button
            type="button"
            className="button"
            onClick={() => void search()}
            data-testid="kb-search-button"
          >
            搜索
          </button>
        </div>

        {list.kind === 'loading' ? <p className="lead">加载中…</p> : null}
        {list.kind === 'error' ? (
          <p className="form-error" data-testid="kb-list-error">
            {list.message}
          </p>
        ) : null}
        {list.kind === 'ready' ? (
          list.items.length === 0 ? (
            <p className="muted" data-testid="kb-search-empty">
              没有匹配的已发布文章。
            </p>
          ) : (
            <ul className="menu" data-testid="kb-article-list">
              {list.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => void openArticle(item.id)}
                    data-testid="kb-article-item"
                  >
                    <strong data-testid="kb-article-title">{item.title}</strong>
                    <span className="muted">
                      v{item.versionNo} · {new Date(item.updatedAt).toLocaleString('zh-CN')}
                    </span>
                    {item.snippet !== null ? (
                      <span className="muted" data-testid="kb-article-snippet">
                        {highlight(item.snippet, appliedKeyword)}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {list.kind === 'ready' && list.nextCursor !== null ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void loadList(appliedKeyword, list.nextCursor ?? undefined)}
            data-testid="kb-load-more"
          >
            加载更多
          </button>
        ) : null}
      </section>

      {canWrite ? (
        <section className="panel">
          <h2>新建草稿</h2>
          <div className="form">
            <label className="form-field">
              Slug
              <input
                className="input-field"
                value={createForm.slug}
                onChange={(event) => setCreateForm({ ...createForm, slug: event.target.value })}
                placeholder="refund-policy"
                data-testid="kb-create-slug"
              />
            </label>
            <label className="form-field">
              标题
              <input
                className="input-field"
                value={createForm.title}
                onChange={(event) => setCreateForm({ ...createForm, title: event.target.value })}
                data-testid="kb-create-title"
              />
            </label>
            <label className="form-field">
              正文
              <textarea
                className="textarea"
                rows={6}
                value={createForm.body}
                onChange={(event) => setCreateForm({ ...createForm, body: event.target.value })}
                data-testid="kb-create-body"
              />
            </label>
            <button
              type="button"
              className="button"
              disabled={
                busy ||
                createForm.slug.trim() === '' ||
                createForm.title.trim() === '' ||
                createForm.body.trim() === ''
              }
              onClick={() => void submitCreate()}
              data-testid="kb-create-submit"
            >
              创建草稿
            </button>
          </div>
        </section>
      ) : null}

      {detailError !== null ? (
        <section className="panel">
          <p className="form-error" data-testid="kb-detail-error">
            {detailError}
          </p>
        </section>
      ) : null}

      {selected !== null ? (
        <section className="panel" data-testid="kb-detail">
          <div className="page-head">
            <div>
              <h2>{selected.versions[0]?.title ?? selected.slug}</h2>
              <p className="lead">
                slug <code>{selected.slug}</code>
                <span className="muted"> · 文章版本 v{selected.version}</span>
              </p>
            </div>
            {canPublish ? (
              <div className="inline-form">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void publish()}
                  data-testid="kb-publish"
                >
                  发布最新版本
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy}
                  onClick={() => void archive()}
                  data-testid="kb-archive"
                >
                  归档
                </button>
              </div>
            ) : null}
          </div>

          {notice !== null ? (
            <p className="form-notice" data-testid="kb-notice">
              {notice}
            </p>
          ) : null}
          {actionError !== null ? (
            <p className="form-error" role="alert" data-testid="kb-action-error">
              {actionError}
            </p>
          ) : null}

          <h3>历史版本</h3>
          <ul className="audit-list" data-testid="kb-version-list">
            {selected.versions.map((version) => (
              <li key={version.id} className="audit-item">
                <div className="message__meta">
                  <span className="tag">v{version.versionNo}</span>
                  <span className={version.status === 'PUBLISHED' ? 'tag tag--public' : 'tag'}>
                    {statusLabel(version.status)}
                  </span>
                  <span className="muted">
                    {new Date(version.createdAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <p className="audit-item__fields">{version.title}</p>
              </li>
            ))}
          </ul>

          {canWrite ? (
            <div className="form">
              <h3>编辑生成新草稿</h3>
              <label className="form-field">
                标题
                <input
                  className="input-field"
                  value={editForm.title}
                  onChange={(event) => setEditForm({ ...editForm, title: event.target.value })}
                  data-testid="kb-edit-title"
                />
              </label>
              <label className="form-field">
                正文
                <textarea
                  className="textarea"
                  rows={6}
                  value={editForm.body}
                  onChange={(event) => setEditForm({ ...editForm, body: event.target.value })}
                  data-testid="kb-edit-body"
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={busy || editForm.title.trim() === '' || editForm.body.trim() === ''}
                onClick={() => void saveDraft()}
                data-testid="kb-save-draft"
              >
                保存为新草稿
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function statusLabel(status: string): string {
  if (status === 'PUBLISHED') {
    return '已发布';
  }
  if (status === 'ARCHIVED') {
    return '已归档';
  }
  return '草稿';
}

function highlight(text: string, keyword: string): ReactNode {
  if (keyword === '') {
    return text;
  }
  const index = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) {
    return text;
  }
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + keyword.length)}</mark>
      {text.slice(index + keyword.length)}
    </>
  );
}
