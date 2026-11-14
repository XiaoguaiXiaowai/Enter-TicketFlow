import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { envSchema } from '../apps/api/src/config/env';

const EXAMPLE_FILE = resolve(process.cwd(), '.env.example');

function readExampleKeys(): string[] {
  const content = readFileSync(EXAMPLE_FILE, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim() ?? '')
    .filter((key) => key.length > 0);
}

const schemaKeys = Object.keys(envSchema.shape).sort();
const exampleKeys = readExampleKeys();
const uniqueExampleKeys = [...new Set(exampleKeys)].sort();

const missingInExample = schemaKeys.filter((key) => !uniqueExampleKeys.includes(key));
const extraInExample = uniqueExampleKeys.filter((key) => !schemaKeys.includes(key));
const duplicated = exampleKeys.filter((key, index) => exampleKeys.indexOf(key) !== index);

if (missingInExample.length > 0 || extraInExample.length > 0 || duplicated.length > 0) {
  process.stderr.write(
    `${JSON.stringify(
      {
        level: 'error',
        message: '.env.example does not match the configuration schema',
        missingInExample,
        extraInExample,
        duplicated,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    level: 'info',
    message: '.env.example matches the configuration schema',
    keys: schemaKeys.length,
  })}\n`,
);
