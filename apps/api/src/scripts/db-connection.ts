export interface RoleCredentials {
  user: string;
  password: string;
}

export interface ParsedConnection extends RoleCredentials {
  host: string;
  port: number;
  database: string;
}

const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i;

export function parseConnectionUrl(raw: string): ParsedConnection {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: Number(url.port === '' ? 5432 : url.port),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export function credentialsFromUrl(raw: string): RoleCredentials {
  const { user, password } = parseConnectionUrl(raw);
  return { user, password };
}

export function assertRoleName(name: string): void {
  if (!ROLE_NAME_PATTERN.test(name)) {
    throw new Error(`invalid database role name: ${name}`);
  }
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
