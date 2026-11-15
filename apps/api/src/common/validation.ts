import type { ValidationError } from '@nestjs/common';
import type { ValidationPipeOptions } from '@nestjs/common';
import { AppException } from './errors';

interface FieldIssue {
  field: string;
  reason: string;
}

function collect(errors: readonly ValidationError[], parent = ''): FieldIssue[] {
  const issues: FieldIssue[] = [];

  for (const error of errors) {
    const field = parent === '' ? error.property : `${parent}.${error.property}`;
    if (error.constraints !== undefined) {
      issues.push({ field, reason: Object.keys(error.constraints).join(', ') });
    }
    if (error.children !== undefined && error.children.length > 0) {
      issues.push(...collect(error.children, field));
    }
  }

  return issues;
}

const validationOptions: ValidationPipeOptions = {
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: (errors) => {
    const details = collect(errors);
    const fields = details.map((issue) => issue.field).join(', ');
    return AppException.validation(`请求参数校验失败: ${fields}`, details);
  },
};

export function validationPipeOptions(): ValidationPipeOptions {
  return validationOptions;
}
