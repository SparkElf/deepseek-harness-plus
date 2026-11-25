/**
 * Labeled fixtures for reviewing the new surfaces before the backend contract is deployed.
 *
 * They are only reachable through `?dataopsReviewDemo=1`; production never merges them into a
 * listing. Keeping them in one module means the plaza, the audit dialog and the permission
 * centre tell the same story instead of each inventing a different sample.
 */

import type { PlazaSkill } from './skill-plaza-client.ts'
import type { RbacOverview } from './review-client.ts'

/** A pending skill with an AI report, an approved global skill, and a rejected private one. */
export function demoPlazaSkills(): PlazaSkill[] {
  return [
    {
      id: 9101,
      name: 'SQL 取数助手',
      description: '把自然语言问题改写成只读 SQL，并解释每个过滤条件。',
      instruction: '你是数据分析助手。只生成只读 SELECT，不要写 UPDATE/DELETE。',
      tags: ['数据', 'SQL'],
      sharedByMe: false,
      updatedAt: '2026-10-23T04:40:00.000Z',
      reviewStatus: 'pending',
      visibility: 'department',
      departmentCode: 'dept-rd',
      departmentName: '研发部',
      departmentPath: [{ code: 'dept-root', name: '万相' }, { code: 'dept-rd', name: '研发部' }],
      ownerName: '林工',
      riskReport: {
        score: 62,
        severity: 'medium',
        summary: '指令包含数据库读取，需确认连接凭据的最小权限。',
        findings: [
          { category: 'credential_access', severity: 'medium', evidence: '提示词要求读取 DATABASE_URL 以连接数据库。', recommendation: '改为由平台注入只读连接，不要在提示词中出现凭据。' },
          { category: 'destructive_action', severity: 'low', evidence: '明确禁止写操作，但未限制 DDL。', recommendation: '补充「禁止 CREATE/ALTER/DROP」。' },
        ],
        scannedAt: '2026-10-23T04:41:00.000Z',
      },
      reviewNote: null,
      submittedAt: '2026-10-23T04:40:00.000Z',
    },
    {
      id: 9102,
      name: '经营日报生成',
      description: '按日汇总营收、订单与退款，输出 Markdown 日报。',
      instruction: '读取昨日指标，生成经营日报。',
      tags: ['经营', '日报'],
      sharedByMe: true,
      updatedAt: '2026-10-21T02:00:00.000Z',
      reviewStatus: 'approved',
      visibility: 'global',
      departmentCode: null,
      ownerName: 'admin',
      riskReport: null,
    },
    {
      id: 9103,
      name: '私域名单清洗',
      description: '按内部规则去重并标记高价值客户。',
      instruction: '清洗名单并输出 CSV。',
      tags: ['客户'],
      sharedByMe: false,
      updatedAt: '2026-10-20T06:00:00.000Z',
      reviewStatus: 'rejected',
      visibility: 'private',
      departmentCode: 'dept-rd',
      departmentName: '研发部',
      ownerName: '周工',
      reviewNote: '包含真实手机号样例，请脱敏后重新提交。',
    },
  ]
}

/** Four roles, the permission catalog, three members, two departments, and three resources. */
export function demoRbacOverview(): RbacOverview {
  return {
    matrix: {
      permissions: [
        { key: 'skill.review', name: '审核技能', group: '技能广场' },
        { key: 'workflow.review', name: '审核工作流', group: '工作流广场' },
        { key: 'rbac.manage', name: '管理权限', group: '系统' },
        { key: 'kb.write', name: '写入知识库', group: '知识库' },
      ],
      roles: [
        { code: 'SUPER_ADMIN', name: '超级管理员', systemKey: 'SUPER_ADMIN', dataScope: 'ALL', permissions: ['skill.review', 'workflow.review', 'rbac.manage', 'kb.write'] },
        { code: 'ADMIN', name: '管理员', systemKey: 'ADMIN', dataScope: 'ALL', permissions: ['skill.review', 'workflow.review', 'kb.write'] },
        { code: 'DEPT_ADMIN', name: '部门管理员', systemKey: 'DEPT_ADMIN', dataScope: 'DEPARTMENT_TREE', permissions: ['skill.review', 'workflow.review'] },
        { code: 'APP_USER', name: '应用人员', systemKey: 'APP_USER', dataScope: 'SELF', permissions: [] },
      ],
    },
    members: [
      { userId: 'u1', username: 'admin', displayName: '超级管理员', roleCodes: ['SUPER_ADMIN'], departmentCode: 'dept-root', departmentPath: [{ code: 'dept-root', name: '万相' }] },
      { userId: 'u2', username: 'lin', displayName: '林工', roleCodes: ['DEPT_ADMIN'], departmentCode: 'dept-rd', departmentPath: [{ code: 'dept-root', name: '万相' }, { code: 'dept-rd', name: '研发部' }] },
      { userId: 'u3', username: 'zhou', displayName: '周工', roleCodes: ['APP_USER'], departmentCode: 'dept-rd', departmentPath: [{ code: 'dept-root', name: '万相' }, { code: 'dept-rd', name: '研发部' }] },
    ],
    departments: [
      { code: 'dept-root', name: '万相', path: [{ code: 'dept-root', name: '万相' }], memberCount: 3, deptAdmins: [] },
      { code: 'dept-rd', name: '研发部', parentCode: 'dept-root', path: [{ code: 'dept-root', name: '万相' }, { code: 'dept-rd', name: '研发部' }], memberCount: 2, deptAdmins: [{ userId: 'u2', username: 'lin', displayName: '林工' }] },
    ],
    resources: [
      { kind: 'builtin', id: 1, name: 'Word 技能', ownerName: '平台内置', departmentCode: null, visibility: 'unshared', reviewStatus: 'unshared' },
      { kind: 'skill', id: 9101, name: 'SQL 取数助手', ownerName: '林工', departmentCode: 'dept-rd', visibility: 'department', reviewStatus: 'pending' },
      { kind: 'skill', id: 9102, name: '经营日报生成', ownerName: 'admin', departmentCode: null, visibility: 'global', reviewStatus: 'approved' },
      { kind: 'workflow', id: 'wf-1', name: '每日经营日报', ownerName: 'admin', departmentCode: null, visibility: 'global', reviewStatus: 'approved' },
    ],
  }
}