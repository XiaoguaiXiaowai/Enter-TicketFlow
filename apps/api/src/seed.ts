import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaClient, type Prisma } from '@prisma/client';

import { getEnv } from './config/runtime';

/**
 * 演示数据：两个租户、三个项目、四个账号。
 * ID 固定，便于端到端用例直接引用跨租户资源做隔离验证。
 * 脚本可重复执行（全部 upsert），密码取 SEED_DEFAULT_PASSWORD。
 *
 * 账号：
 * - agent-a@example.com     租户 A 客服（项目 A1/A2），同时是租户 B 外包坐席（项目 B1）
 * - lead-a@example.com      租户 A 客服主管
 * - contractor-a@example.com 租户 A 外包坐席（只授予项目 A1）
 * - agent-b@example.com     租户 B 客服
 */

const ID = {
  tenantA: '11111111-1111-4111-8111-111111111111',
  tenantB: '22222222-2222-4222-8222-222222222222',
  projectA1: 'a1111111-1111-4111-8111-111111111111',
  projectA2: 'a2222222-2222-4222-8222-222222222222',
  projectB1: 'b1111111-1111-4111-8111-111111111111',
  agentA: 'c1111111-1111-4111-8111-111111111111',
  leadA: 'c2222222-2222-4222-8222-222222222222',
  contractorA: 'c3333333-3333-4333-8333-333333333333',
  agentB: 'c4444444-4444-4444-8444-444444444444',
  roleAgentA: 'd1111111-1111-4111-8111-111111111111',
  roleLeadA: 'd2222222-2222-4222-8222-222222222222',
  roleContractorA: 'd3333333-3333-4333-8333-333333333333',
  roleAgentB: 'e1111111-1111-4111-8111-111111111111',
  roleContractorB: 'e3333333-3333-4333-8333-333333333333',
  membershipAgentA: 'f1111111-1111-4111-8111-111111111111',
  membershipLeadA: 'f2222222-2222-4222-8222-222222222222',
  membershipContractorA: 'f3333333-3333-4333-8333-333333333333',
  membershipAgentAInB: 'f4444444-4444-4444-8444-444444444444',
  membershipAgentB: 'f5555555-5555-4555-8555-555555555555',
  templateRefundA1: '9a111111-1111-4111-8111-111111111111',
  templateGreetingA2: '9a222222-2222-4222-8222-222222222222',
  templateWelcomeB1: '9b111111-1111-4111-8111-111111111111',
} as const;

interface PermissionRow {
  resource: string;
  action: string;
}

interface FieldPolicyRow {
  resource: string;
  field: string;
  canRead: boolean;
  canWrite: boolean;
  masked: boolean;
}

const AGENT_PERMISSIONS: PermissionRow[] = [
  { resource: 'ticket', action: 'list' },
  { resource: 'ticket', action: 'read' },
  { resource: 'ticket', action: 'create' },
  { resource: 'ticket', action: 'update' },
  { resource: 'ticket', action: 'reply' },
  { resource: 'ticket', action: 'note' },
  { resource: 'audit', action: 'read' },
  { resource: 'kb', action: 'read' },
  { resource: 'template', action: 'use' },
];

const LEAD_PERMISSIONS: PermissionRow[] = [
  ...AGENT_PERMISSIONS,
  { resource: 'ticket', action: 'close' },
  { resource: 'audit', action: 'read_all' },
  { resource: 'kb', action: 'write' },
  { resource: 'kb', action: 'publish' },
];

const CONTRACTOR_PERMISSIONS: PermissionRow[] = [
  { resource: 'ticket', action: 'list' },
  { resource: 'ticket', action: 'read' },
  { resource: 'ticket', action: 'reply' },
  { resource: 'kb', action: 'read' },
  { resource: 'template', action: 'use' },
];

const AGENT_FIELDS: FieldPolicyRow[] = [
  { resource: 'ticket', field: 'customerPhone', canRead: true, canWrite: true, masked: false },
  { resource: 'ticket', field: 'internalNote', canRead: true, canWrite: true, masked: false },
  { resource: 'ticket', field: 'refundAmount', canRead: true, canWrite: false, masked: false },
  { resource: 'ticket', field: 'assigneeId', canRead: true, canWrite: false, masked: false },
];

const LEAD_FIELDS: FieldPolicyRow[] = AGENT_FIELDS.map((row) => ({ ...row, canWrite: true }));

const CONTRACTOR_FIELDS: FieldPolicyRow[] = [
  { resource: 'ticket', field: 'customerPhone', canRead: true, canWrite: false, masked: true },
];

async function main(): Promise<void> {
  const env = getEnv();
  const prisma = new PrismaClient({ datasourceUrl: env.MIGRATE_DATABASE_URL });
  const password = env.SEED_DEFAULT_PASSWORD;
  const passwordOptions = {
    algorithm: Algorithm.Argon2id,
    memoryCost: env.ARGON2_MEMORY_KIB,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  };

  try {
    await prisma.tenant.upsert({
      where: { code: 'tenant-a' },
      update: { name: '演示租户 A', status: 'ACTIVE' },
      create: { id: ID.tenantA, code: 'tenant-a', name: '演示租户 A' },
    });
    await prisma.tenant.upsert({
      where: { code: 'tenant-b' },
      update: { name: '演示租户 B', status: 'ACTIVE' },
      create: { id: ID.tenantB, code: 'tenant-b', name: '演示租户 B' },
    });

    // 每个账号单独哈希：同一密码也会得到不同摘要（随机盐）。
    for (const account of [
      { id: ID.agentA, email: 'agent-a@example.com' },
      { id: ID.leadA, email: 'lead-a@example.com' },
      { id: ID.contractorA, email: 'contractor-a@example.com' },
      { id: ID.agentB, email: 'agent-b@example.com' },
    ]) {
      const passwordHash = await hash(password, passwordOptions);
      await prisma.user.upsert({
        where: { email: account.email },
        update: { passwordHash },
        create: { id: account.id, email: account.email, passwordHash },
      });
    }

    await seedTenant(prisma, {
      tenantId: ID.tenantA,
      projects: [
        { id: ID.projectA1, code: 'SUP', name: '客服支持' },
        { id: ID.projectA2, code: 'SVC', name: '售后服务' },
      ],
      roles: [
        { id: ID.roleAgentA, code: 'agent', name: '客服', permissions: AGENT_PERMISSIONS, fields: AGENT_FIELDS },
        { id: ID.roleLeadA, code: 'lead', name: '客服主管', permissions: LEAD_PERMISSIONS, fields: LEAD_FIELDS },
        {
          id: ID.roleContractorA,
          code: 'contractor',
          name: '外包坐席',
          permissions: CONTRACTOR_PERMISSIONS,
          fields: CONTRACTOR_FIELDS,
        },
      ],
      templates: [
        {
          id: ID.templateRefundA1,
          projectId: ID.projectA1,
          name: '退款指引',
          body: '您好 {{customer_name}}，订单 {{order_no}} 的退款申请已受理，将在 3 个工作日内原路退回。',
          variables: ['customer_name', 'order_no'],
        },
        {
          id: ID.templateGreetingA2,
          projectId: ID.projectA2,
          name: '通用问候',
          body: '您好 {{customer_name}}，已收到您的反馈，我们会尽快跟进处理。',
          variables: ['customer_name'],
        },
      ],
      memberships: [
        {
          id: ID.membershipAgentA,
          userId: ID.agentA,
          roleIds: [ID.roleAgentA],
          projectIds: [ID.projectA1, ID.projectA2],
        },
        {
          id: ID.membershipLeadA,
          userId: ID.leadA,
          roleIds: [ID.roleLeadA],
          projectIds: [ID.projectA1, ID.projectA2],
        },
        {
          id: ID.membershipContractorA,
          userId: ID.contractorA,
          roleIds: [ID.roleContractorA],
          projectIds: [ID.projectA1],
        },
      ],
    });

    await seedTenant(prisma, {
      tenantId: ID.tenantB,
      projects: [{ id: ID.projectB1, code: 'B2C', name: 'B2C 支持' }],
      roles: [
        { id: ID.roleAgentB, code: 'agent', name: '客服', permissions: AGENT_PERMISSIONS, fields: AGENT_FIELDS },
        {
          id: ID.roleContractorB,
          code: 'contractor',
          name: '外包坐席',
          permissions: CONTRACTOR_PERMISSIONS,
          fields: CONTRACTOR_FIELDS,
        },
      ],
      templates: [
        {
          id: ID.templateWelcomeB1,
          projectId: ID.projectB1,
          name: '通用问候',
          body: '您好 {{customer_name}}，这里是租户 B 客服，已收到您的反馈。',
          variables: ['customer_name'],
        },
      ],
      memberships: [
        {
          id: ID.membershipAgentB,
          userId: ID.agentB,
          roleIds: [ID.roleAgentB],
          projectIds: [ID.projectB1],
        },
        {
          // 同一用户在不同租户拥有不同角色：租户 B 中仅为外包坐席。
          id: ID.membershipAgentAInB,
          userId: ID.agentA,
          roleIds: [ID.roleContractorB],
          projectIds: [ID.projectB1],
        },
      ],
    });

    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        message: 'seed completed',
        tenants: ['tenant-a', 'tenant-b'],
        projects: Object.keys(ID).filter((key) => key.startsWith('project')).length,
        accounts: 4,
      })}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

interface TenantSeed {
  tenantId: string;
  projects: { id: string; code: string; name: string }[];
  roles: {
    id: string;
    code: string;
    name: string;
    permissions: PermissionRow[];
    fields: FieldPolicyRow[];
  }[];
  templates: {
    id: string;
    projectId: string;
    name: string;
    body: string;
    variables: string[];
  }[];
  memberships: {
    id: string;
    userId: string;
    roleIds: string[];
    projectIds: string[];
  }[];
}

/**
 * 租户数据必须显式设置 app.tenant_id：表上启用了 FORCE RLS，
 * 即便以表所有者（migrator）身份写入也要满足隔离策略。
 */
async function seedTenant(prisma: PrismaClient, seed: TenantSeed): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${seed.tenantId}, true)`;

    for (const project of seed.projects) {
      await tx.project.upsert({
        where: { tenantId_code: { tenantId: seed.tenantId, code: project.code } },
        update: { name: project.name },
        create: {
          id: project.id,
          tenantId: seed.tenantId,
          code: project.code,
          name: project.name,
        },
      });
    }

    for (const template of seed.templates) {
      await tx.replyTemplate.upsert({
        where: { projectId_name: { projectId: template.projectId, name: template.name } },
        update: { body: template.body, variables: template.variables, archivedAt: null },
        create: {
          id: template.id,
          tenantId: seed.tenantId,
          projectId: template.projectId,
          name: template.name,
          body: template.body,
          variables: template.variables,
        },
      });
    }

    for (const role of seed.roles) {
      await tx.role.upsert({
        where: { tenantId_code: { tenantId: seed.tenantId, code: role.code } },
        update: { name: role.name, isSystem: true },
        create: {
          id: role.id,
          tenantId: seed.tenantId,
          code: role.code,
          name: role.name,
          isSystem: true,
        },
      });

      const roleId = await resolveRoleId(tx, seed.tenantId, role.code);
      for (const permission of role.permissions) {
        await tx.rolePermission.upsert({
          where: {
            roleId_resource_action: {
              roleId,
              resource: permission.resource,
              action: permission.action,
            },
          },
          update: {},
          create: {
            tenantId: seed.tenantId,
            roleId,
            resource: permission.resource,
            action: permission.action,
          },
        });
      }
      for (const field of role.fields) {
        await tx.fieldPolicy.upsert({
          where: {
            roleId_resource_field: { roleId, resource: field.resource, field: field.field },
          },
          update: {
            canRead: field.canRead,
            canWrite: field.canWrite,
            masked: field.masked,
          },
          create: { tenantId: seed.tenantId, roleId, ...field },
        });
      }
    }

    for (const membership of seed.memberships) {
      await tx.membership.upsert({
        where: {
          tenantId_userId: { tenantId: seed.tenantId, userId: membership.userId },
        },
        update: { status: 'ACTIVE' },
        create: {
          id: membership.id,
          tenantId: seed.tenantId,
          userId: membership.userId,
          status: 'ACTIVE',
        },
      });

      const membershipId = await resolveMembershipId(tx, seed.tenantId, membership.userId);
      for (const roleId of membership.roleIds) {
        await tx.membershipRole.upsert({
          where: { membershipId_roleId: { membershipId, roleId } },
          update: {},
          create: { tenantId: seed.tenantId, membershipId, roleId },
        });
      }
      for (const projectId of membership.projectIds) {
        await tx.membershipProject.upsert({
          where: { membershipId_projectId: { membershipId, projectId } },
          update: {},
          create: { tenantId: seed.tenantId, membershipId, projectId },
        });
      }
    }
  });
}

async function resolveRoleId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  code: string,
): Promise<string> {
  const role = await tx.role.findFirstOrThrow({ where: { tenantId, code }, select: { id: true } });
  return role.id;
}

async function resolveMembershipId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<string> {
  const membership = await tx.membership.findFirstOrThrow({
    where: { tenantId, userId },
    select: { id: true },
  });
  return membership.id;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      message: 'seed failed',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
