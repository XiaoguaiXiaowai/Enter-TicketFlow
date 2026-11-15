import { describe, expect, it } from 'vitest';

import { sanitizeRichText } from '../../src/common/rich-text';

describe('富文本白名单清洗', () => {
  it('移除 script/style/iframe 及其内容', () => {
    const dirty =
      '<p>退款说明</p><script>alert(1)</script><style>body{display:none}</style>' +
      '<iframe src="https://evil.example"></iframe>';
    expect(sanitizeRichText(dirty)).toBe('<p>退款说明</p>');
  });

  it('移除内联事件属性，只保留安全 href', () => {
    const dirty =
      '<a href="https://help.example.com/refund" onclick="steal()">退款</a>' +
      '<img src="x" onerror="alert(1)">';
    expect(sanitizeRichText(dirty)).toBe(
      '<a href="https://help.example.com/refund" rel="noopener noreferrer nofollow">退款</a>',
    );
  });

  it('危险协议与非白名单标签被丢弃', () => {
    const dirty = '<a href="javascript:alert(1)">点我</a><custom-tag>文本</custom-tag>';
    expect(sanitizeRichText(dirty)).toBe('<a>点我</a>文本');
  });

  it('保留结构化标签与 HTML 注释清理', () => {
    const dirty = '<!-- 内部备注 --><ul><li><strong>已受理</strong></li></ul><br/>';
    expect(sanitizeRichText(dirty)).toBe('<ul><li><strong>已受理</strong></li></ul><br>');
  });

  it('普通文本与模板变量渲染结果原样保留', () => {
    expect(sanitizeRichText('张先生您好，订单 2026-001 已退款。')).toBe(
      '张先生您好，订单 2026-001 已退款。',
    );
  });
});