import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { writeLog } from '../common/logger';

const SOURCE_ROOT = join(__dirname, '..');
const WRITE_DECORATOR = /@(?:Post|Patch|Put|Delete)\(/gu;
const METHOD_START = /\n {2}(?:public |private |protected )?(?:async )?[A-Za-z_]\w*\s*\(/u;

/**
 * 业务写接口必须声明 @RequirePermission。
 * auth 控制器属于会话自服务（登录/刷新/登出），不纳入业务写接口范围。
 */
function listControllerFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listControllerFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      files.push(path);
    }
  }
  return files;
}

const violations: { file: string; snippet: string }[] = [];

for (const file of listControllerFiles(SOURCE_ROOT)) {
  const normalized = relative(SOURCE_ROOT, file);
  if (normalized === join('auth', 'auth.controller.ts')) {
    continue;
  }

  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(WRITE_DECORATOR)) {
    const start = match.index ?? 0;
    const rest = source.slice(start + match[0].length);
    const methodOffset = rest.search(METHOD_START);
    const segment = methodOffset === -1 ? rest : rest.slice(0, methodOffset);

    if (!segment.includes('@RequirePermission(') && !segment.includes('@Public(')) {
      violations.push({
        file: normalized,
        snippet: source.slice(start, Math.min(start + 160, source.length)).split('\n')[0] ?? '',
      });
    }
  }
}

if (violations.length > 0) {
  writeLog('error', 'write endpoints missing @RequirePermission', { violations });
  process.exit(1);
}

writeLog('info', 'permission declaration check passed', { scanned: listControllerFiles(SOURCE_ROOT).length });
