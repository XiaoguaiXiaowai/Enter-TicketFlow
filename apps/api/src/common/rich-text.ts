const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'div',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
]);

const DANGEROUS_BLOCKS =
  /<(script|style|iframe|object|embed|form|meta|link|base|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DANGEROUS_SINGLE =
  /<(script|style|iframe|object|embed|form|meta|link|base|svg|math)\b[^>]*\/?>/gi;
const ATTRIBUTE_PATTERN = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
const SAFE_LINK = /^(https?:|mailto:|\/|#)/i;

function sanitizeAttributes(rawAttributes: string): string {
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let result = '';
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_PATTERN.exec(rawAttributes)) !== null) {
    const name = String(match[1]).toLowerCase();
    const value = match[3] ?? match[4] ?? '';
    if (name === 'href' && SAFE_LINK.test(value.trim())) {
      result += ` href="${value.replace(/"/g, '&quot;')}" rel="noopener noreferrer nofollow"`;
    }
  }
  return result;
}

/**
 * 富文本白名单清洗：移除脚本/样式/内联事件与危险协议，仅保留结构化标签。
 * 输入源包括人工维护的回复模板；清洗后仍由前端按文本渲染。
 */
export function sanitizeRichText(input: string): string {
  let output = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DANGEROUS_BLOCKS, '')
    .replace(DANGEROUS_SINGLE, '');

  output = output.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, closing, rawTag, attrs) => {
    const tag = String(rawTag).toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      return '';
    }
    if (closing === '/') {
      return `</${tag}>`;
    }
    return `<${tag}${sanitizeAttributes(String(attrs))}>`;
  });

  return output;
}