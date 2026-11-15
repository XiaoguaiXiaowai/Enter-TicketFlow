import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import type { TicketPriority } from '@ticket/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError, createTicket, newIdempotencyKey } from '../lib/api';

const PRIORITIES: TicketPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export function TicketCreatePage() {
  const { projectId } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const effectiveProjectId = searchParams.get('projectId') ?? projectId;

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('NORMAL');
  const [tags, setTags] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 同一次填写复用同一个幂等键：网络抖动后重试不会重复建单。
  const idempotencyKey = useRef(newIdempotencyKey());

  async function submit(): Promise<void> {
    if (effectiveProjectId === null || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const ticket = await createTicket(
        effectiveProjectId,
        {
          subject: subject.trim(),
          description: description.trim(),
          customerName: customerName.trim(),
          priority,
          ...(customerPhone.trim() === '' ? {} : { customerPhone: customerPhone.trim() }),
          tags: tags
            .split(/[,，]/u)
            .map((tag) => tag.trim())
            .filter((tag) => tag !== ''),
        },
        idempotencyKey.current,
      );
      navigate(`/tickets/${ticket.id}?projectId=${effectiveProjectId}`);
    } catch (caught: unknown) {
      setError(
        caught instanceof ApiError
          ? `${caught.message}（${caught.code}）`
          : '网络异常，请稍后重试',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (effectiveProjectId === null) {
    return (
      <section className="panel">
        <h1>新建工单</h1>
        <p className="form-error" role="alert">
          当前账号还没有被授予任何项目。
        </p>
        <Link to="/">返回工作台</Link>
      </section>
    );
  }

  return (
    <div className="workbench">
      <section className="panel">
        <h1>新建工单</h1>
        <p className="lead">提交后工单号按项目序列自动生成，并写入审计与事件表。</p>

        <form
          className="form form--wide"
          data-testid="ticket-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="form-field">
            主题
            <input
              className="input-field"
              value={subject}
              maxLength={200}
              required
              onChange={(event) => setSubject(event.target.value)}
              data-testid="subject-input"
            />
          </label>

          <label className="form-field">
            问题描述
            <textarea
              className="textarea"
              rows={5}
              value={description}
              maxLength={20000}
              required
              onChange={(event) => setDescription(event.target.value)}
              data-testid="description-input"
            />
          </label>

          <div className="form-grid">
            <label className="form-field">
              客户姓名
              <input
                className="input-field"
                value={customerName}
                maxLength={100}
                required
                onChange={(event) => setCustomerName(event.target.value)}
                data-testid="customer-name-input"
              />
            </label>

            <label className="form-field">
              客户手机号
              <input
                className="input-field"
                value={customerPhone}
                maxLength={11}
                onChange={(event) => setCustomerPhone(event.target.value)}
                data-testid="customer-phone-input"
              />
            </label>

            <label className="form-field">
              优先级
              <select
                className="select"
                value={priority}
                onChange={(event) => setPriority(event.target.value as TicketPriority)}
                data-testid="priority-select"
              >
                {PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              标签（逗号分隔）
              <input
                className="input-field"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                data-testid="tags-input"
              />
            </label>
          </div>

          {error !== null ? (
            <p className="form-error" role="alert" data-testid="create-error">
              {error}
            </p>
          ) : null}

          <div className="form-actions">
            <button
              type="submit"
              className="button"
              disabled={submitting}
              data-testid="submit-ticket"
            >
              {submitting ? '提交中…' : '创建工单'}
            </button>
            <Link className="button button--ghost" to="/tickets">
              返回列表
            </Link>
          </div>
        </form>
      </section>
    </div>
  );
}
