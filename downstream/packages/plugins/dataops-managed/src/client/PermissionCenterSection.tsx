import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import {
  createDepartment,
  deleteDepartment,
  fetchRbacOverview,
  fetchVisibleRoles,
  grantMemberRole,
  revokeMemberRole,
  fetchReviewContext,
  reviewDemoMode,
  saveRbacSection,
  updateDepartment,
  type DepartmentRow,
  type MemberRow,
  type RbacOverview,
  type VisibleRoleRow,
  type VisibleRolesView,
  type ResourceScopeRow,
  type RoleMatrixRow,
} from './review-client.ts'
import type { PortalRole, ReviewContext } from './review-types.ts'
import { canEditResourceScopeRow, canManagePermissions } from './review-types.ts'
import { canSeeManagedSettings, currentManagedSettingsRole } from './settings-gate.ts'
import { demoRbacOverview } from './review-demo.ts'
import styles from './PermissionCenterSection.module.css'
import { clampActiveIndex, filterComboboxOptions, ownerDisplay, type ComboboxOption } from './combobox.ts'

/** The four tabs of the permission centre. */
type PermissionTab = 'roles' | 'members' | 'departments' | 'resources'

/** Props accepted by the page. */
export interface PermissionCenterSectionProps {
  t?: (key: keyof typeof en) => string
}

/** How many rows one page of the members/resources tables shows. */
const PAGE_SIZE = 10

/**
 * The permission centre.
 *
 * Every write goes through `saveRbacSection`; the backend enforces the same role/scope rules
 * the disabled controls represent. The page keeps target-aware state explicitly (actor role,
 * actor department) so an ADMIN cannot edit a SUPER_ADMIN row and a DEPT_ADMIN cannot reach
 * another department, even if a list payload is wider than expected.
 */
export function PermissionCenterSection({ t }: PermissionCenterSectionProps): ReactNode {
  const [context, setContext] = useState<ReviewContext | null | undefined>(undefined)
  const [overview, setOverview] = useState<RbacOverview | null | undefined>(undefined)
  const [visibleRoles, setVisibleRoles] = useState<VisibleRolesView | null>(null)
  const [tab, setTab] = useState<PermissionTab>('roles')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deptDialog, setDeptDialog] = useState<DepartmentRow | null>(null)
  const [deptSearch, setDeptSearch] = useState('')
  const [deptSelected, setDeptSelected] = useState<string[]>([])
  const [deptSaving, setDeptSaving] = useState(false)
  const [deptError, setDeptError] = useState<string | null>(null)
  const [deptForm, setDeptForm] = useState<{ mode: 'create' | 'edit'; parentCode?: string | null; department?: DepartmentRow } | null>(null)
  const demo = reviewDemoMode()

  const load = useCallback(async () => {
    const nextContext = await fetchReviewContext()
    setContext(nextContext)
    if (nextContext === null && !demo) { setOverview(null); return }
    try {
      const [nextOverview, nextVisible] = await Promise.all([
        demo ? Promise.resolve(demoRbacOverview()) : fetchRbacOverview(),
        demo ? Promise.resolve(null) : fetchVisibleRoles().catch(() => null),
      ])
      setOverview(nextOverview)
      setVisibleRoles(nextVisible)
    } catch {
      setOverview(null)
    }
  }, [demo])

  useEffect(() => { void load() }, [load])

  if (t === undefined) return null
  if (context === undefined || overview === undefined) return null

  // The launcher label is authoritative for the two administrator roles. A null review context
  // means the review API has not shipped yet, not that the caller is unauthorised: show the page
  // skeleton with the waiting note instead of a false "no access" screen.
  const knownAdmin = canSeeManagedSettings()
  const denied = context !== null
    ? (context.role !== 'SUPER_ADMIN' && context.role !== 'ADMIN' && context.role !== 'DEPT_ADMIN' && !knownAdmin)
    : !knownAdmin
  if (denied) return <section className={styles.page}><p className={styles.empty}>{t('permNoAccess')}</p></section>

  const roleName = context === null ? (currentManagedSettingsRole() ?? '—') : roleLabel(context.role)
  const departmentName = context?.departmentPath?.join(' / ') ?? '—'
  const actorRole: PortalRole = context?.role ?? (knownAdmin ? 'ADMIN' : 'APP_USER')
  const writable = context === null ? knownAdmin : (canManagePermissions(context) || demo)
  // Resource scopes are delegated to department administrators by the backend policy, even
  // though role/member writes stay administrator-only.
  const resourceWritable = writable || actorRole === 'DEPT_ADMIN'
  const superAdmin = context === null ? knownAdmin : context.role === 'SUPER_ADMIN' || demo
  const canAssignDepartment = writable && (superAdmin || actorRole === 'ADMIN')
  const tabs: { key: PermissionTab; label: string; group: string; count: number }[] = [
    { key: 'roles', label: t('permTabRoles'), group: t('permGroupRoles'), count: overview?.matrix.roles.length ?? 0 },
    { key: 'members', label: t('permTabMembers'), group: t('permGroupRoles'), count: overview?.members.length ?? 0 },
    { key: 'departments', label: t('permTabDepartments'), group: t('permGroupOrg'), count: overview?.departments.length ?? 0 },
    { key: 'resources', label: t('permTabResources'), group: t('permGroupResources'), count: overview?.resources.length ?? 0 },
  ]
  const tabGroups = tabs.reduce<{ group: string; items: typeof tabs }[]>((groups, item) => {
    const existing = groups.find(group => group.group === item.group)
    if (existing === undefined) groups.push({ group: item.group, items: [item] })
    else existing.items.push(item)
    return groups
  }, [])

  const save = async (section: PermissionTab, value: unknown): Promise<{ ok: boolean; reason?: string }> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await saveRbacSection(section, value)
      setNotice(result.ok ? t('permSaved') : (result.reason ?? t('permWaiting')))
      if (result.ok) await load()
      return result
    } catch {
      setNotice(t('permSaveFailed'))
      return { ok: false, reason: t('permSaveFailed') }
    } finally {
      setBusy(false)
    }
  }

  const saveRoleChanges = async (changes: readonly { roleCode: string; permissionKeys: string[] }[]): Promise<{ ok: boolean; reason?: string }> => {
    setBusy(true)
    setNotice(null)
    try {
      for (const change of changes) {
        const result = await saveRbacSection('roles', { roleCode: change.roleCode, permissionKeys: change.permissionKeys })
        if (!result.ok) {
          setNotice(result.reason ?? t('permSaveFailed'))
          await load()
          return result
        }
      }
      setNotice(t('permSaved'))
      await load()
      return { ok: true }
    } catch {
      setNotice(t('permSaveFailed'))
      return { ok: false, reason: t('permSaveFailed') }
    } finally {
      setBusy(false)
    }
  }

  const grantRole = async (userId: string, roleCode: string, departmentCode?: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await grantMemberRole(userId, roleCode, departmentCode)
      setNotice(result.ok ? t('permSaved') : (result.reason ?? t('permSaveFailed')))
      if (result.ok) await load()
    } finally {
      setBusy(false)
    }
  }

  const revokeRole = async (userId: string, roleCode: string): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await revokeMemberRole(userId, roleCode)
      setNotice(result.ok ? t('permSaved') : (result.reason ?? t('permSaveFailed')))
      if (result.ok) await load()
    } finally {
      setBusy(false)
    }
  }

  const openDepartment = (department: DepartmentRow): void => {
    setDeptDialog(department)
    setDeptSelected(department.deptAdmins?.map(admin => admin.userId) ?? [])
    setDeptSearch('')
    setDeptError(null)
  }

  const assignDepartment = async (userIds: string[]): Promise<void> => {
    if (deptDialog === null || deptSaving) return
    setDeptSaving(true)
    setDeptError(null)
    try {
      const result = await saveRbacSection('departments', { code: deptDialog.code, userIds })
      if (!result.ok) {
        setDeptError(result.reason ?? '保存失败：后端拒绝或无权限（403）。')
        return
      }
      setDeptDialog(null)
      setNotice('部门管理员已更新。')
      await load()
    } catch {
      setDeptError('保存失败：后端拒绝或无权限（403）。')
    } finally {
      setDeptSaving(false)
    }
  }

  const removeDepartment = async (department: DepartmentRow): Promise<void> => {
    const children = overview?.departments.filter(row => row.parentCode === department.code).length ?? 0
    const members = department.memberCount ?? 0
    if (!window.confirm('确认删除部门「' + department.name + '」？\n成员 ' + String(members) + ' 人，子部门 ' + String(children) + ' 个；删除后不可恢复。')) return
    const result = await deleteDepartment(department.code)
    if (!result.ok) {
      setNotice(result.reason ?? '删除失败：后端拒绝或无权限（403）。')
      return
    }
    setNotice('部门已删除。')
    await load()
  }

  const candidates = deptDialog === null || overview === null ? [] : overview.members.filter(member => {
    const pathCodes = member.departmentPath?.map(entry => entry.code) ?? []
    return member.departmentCode === deptDialog.code || pathCodes.includes(deptDialog.code)
  }).filter(member => {
    const needle = deptSearch.trim().toLowerCase()
    return needle === '' || member.displayName.toLowerCase().includes(needle) || member.username.toLowerCase().includes(needle)
  })

  return (
    <section className={styles.page} data-permission-center="">
      <header className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{t('permTitle')}</h1>
          <p className={styles.subtitle}>
            {roleName} · {departmentName}
            {demo ? <span className={styles.demo}>{t('permDemo')}</span> : null}
          </p>
        </div>
        <div className={styles.headActions}>
          <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={16} />} onClick={() => { void load() }}>{t('permRefresh')}</Button>
        </div>
      </header>

      <div className={styles.tabs} role="tablist" aria-label={t('permTitle')}>
        {tabGroups.map((group, groupIndex) => (
          <div className={styles.tabGroup} key={group.group}>
            {groupIndex > 0 ? <span className={styles.tabDivider} aria-hidden="true" /> : null}
            {group.items.map(item => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={tab === item.key ? styles.tab + ' ' + styles.tabActive : styles.tab}
                onClick={() => { setTab(item.key) }}
              >
                {item.label}
                <span className={styles.tabBadge}>{item.count}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      {notice === null ? null : <p className={styles.notice}>{notice}</p>}
      {overview === null ? <p className={styles.waiting}>{t('permWaiting')}</p> : (
        <>
          {tab === 'roles' ? <RoleMatrix roles={overview.matrix.roles} permissions={overview.matrix.permissions} writable={writable} actorRole={actorRole} busy={busy} t={t} onSaveAll={saveRoleChanges} /> : null}
          {tab === 'members' ? <Members members={overview.members} writable={writable} actorRole={actorRole} actorUserId={context?.userId} actorDepartmentCode={context?.departmentCode} visibleRoles={visibleRoles} busy={busy} t={t} onSave={(userId, roleCodes) => { void save('members', { userId, roleCodes }) }} onGrant={(userId, roleCode, departmentCode) => { void grantRole(userId, roleCode, departmentCode) }} onRevoke={(userId, roleCode) => { void revokeRole(userId, roleCode) }} /> : null}
          {tab === 'departments' ? <Departments departments={overview.departments} writable={writable} canAssign={canAssignDepartment} canWrite={writable && (superAdmin || actorRole === 'ADMIN')} t={t} onAssign={openDepartment} onAdd={(parentCode) => { setDeptForm({ mode: 'create', parentCode }) }} onEdit={(department) => { setDeptForm({ mode: 'edit', department }) }} onDelete={(department) => { void removeDepartment(department) }} /> : null}
          {tab === 'resources' ? <Resources resources={overview.resources} departments={overview.departments} writable={resourceWritable} actorRole={actorRole} actorDepartmentCode={context?.departmentCode} busy={busy} t={t} onSave={(row, visibility, departmentCode) => save('resources', { kind: row.kind, id: row.id, visibility, departmentCode })} /> : null}
        </>
      )}

      <Modal
        open={deptDialog !== null}
        onClose={() => { if (!deptSaving) setDeptDialog(null) }}
        title={deptDialog === null ? '分配部门管理员' : '分配管理员 · ' + deptDialog.name}
        closeLabel="取消"
        className={styles.dialog as string}
        footer={(
          <div className={styles.dialogFooter}>
            <Button variant="outline" disabled={deptSaving} onClick={() => { if (deptDialog !== null) void assignDepartment([]) }}>清空</Button>
            <Button variant="outline" disabled={deptSaving} onClick={() => { setDeptDialog(null) }}>取消</Button>
            <Button variant="primary" disabled={deptSaving} onClick={() => { void assignDepartment(deptSelected) }}>保存</Button>
          </div>
        )}
      >
        {deptDialog === null ? null : (
          <div className={styles.dialogBody}>
            <p className={styles.dialogHint}>当前管理员：{deptDialog.deptAdmins?.length === 0 || deptDialog.deptAdmins === undefined ? '未设置' : deptDialog.deptAdmins.map(admin => admin.displayName).join('、')}</p>
            <input className={styles.search} value={deptSearch} placeholder="搜索本部门成员…" onChange={(event) => { setDeptSearch(event.target.value) }} />
            <ul className={styles.candidates}>
              {candidates.length === 0 ? <li className={styles.muted}>没有可选成员（后端可能只允许本部门/未分配用户）。</li> : candidates.map(member => (
                <li key={member.userId}>
                  <label className={styles.candidate}>
                    <input
                      type="checkbox"
                      checked={deptSelected.includes(member.userId)}
                      onChange={(event) => {
                        setDeptSelected(current => event.target.checked
                          ? [...current, member.userId]
                          : current.filter(id => id !== member.userId))
                      }}
                    />
                    <span>{member.displayName}</span>
                    <span className={styles.muted}>@{member.username} · {member.departmentPath?.map(entry => entry.name).join(' / ') ?? '—'}</span>
                  </label>
                </li>
              ))}
            </ul>
            {deptError === null ? null : <p className={styles.error} role="alert">{deptError}</p>}
          </div>
        )}
      </Modal>

      <DepartmentFormDialog
        state={deptForm}
        departments={overview?.departments ?? []}
        t={t}
        onClose={() => { setDeptForm(null) }}
        onSaved={async () => { setDeptForm(null); setNotice('部门已保存。'); await load() }}
      />
    </section>
  )
}

function RoleMatrix({ roles, permissions, writable, actorRole, busy, t, onSaveAll }: {
  roles: readonly RoleMatrixRow[]
  permissions: readonly { key: string; name: string; group: string; scope?: string; description?: string }[]
  writable: boolean
  actorRole: PortalRole
  busy: boolean
  t: (key: keyof typeof en) => string
  onSaveAll: (changes: readonly { roleCode: string; permissionKeys: string[] }[]) => Promise<{ ok: boolean; reason?: string }>
}): ReactNode {
  // 全部角色：内置角色按固定顺序在前，自定义角色（systemKey === null）追加在后。
  const visibleRoles = useMemo(() => {
    const builtinOrder = ['SUPER_ADMIN', 'ADMIN', 'DEPT_ADMIN', 'APP_USER']
    const rank = (role: RoleMatrixRow): number => {
      const systemKey = role.systemKey ?? null
      if (systemKey === null) return 100
      const index = builtinOrder.indexOf(systemKey)
      return index < 0 ? 50 : index
    }
    return [...roles]
      .map(role => (role.systemKey === 'APP_USER' || role.code === '应用人员' || role.code === '普通用户') ? { ...role, name: '普通用户' } : role)
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh-CN'))
  }, [roles])
  const [roleQuery, setRoleQuery] = useState('')
  const shownRoles = useMemo(() => {
    const needle = roleQuery.trim().toLowerCase()
    if (needle === '') return visibleRoles
    return visibleRoles.filter(role => role.name.toLowerCase().includes(needle) || role.code.toLowerCase().includes(needle))
  }, [visibleRoles, roleQuery])
  const groups = useMemo(() => {
    const hasSkill = permissions.some(point => point.group === 'skill' || point.group === '技能中心')
    const keyOf = (group: string): 'kb' | 'skill' | 'workflow' | 'automation' | null => {
      const raw = group.trim().toLowerCase()
      if (raw === 'kb' || raw === 'knowledge' || group === '知识库') return 'kb'
      if (raw === 'skill' || group === '技能中心') return 'skill'
      if (raw === 'workflow' || group === '工作流广场') return 'workflow'
      if (raw === 'automation' || group === '自动化任务') return 'automation'
      // Compatibility while task-70's catalogue is rolling out: legacy `ai` stands in for
      // the skill group only when no dedicated `skill` group is present.
      if (raw === 'ai' && !hasSkill) return 'skill'
      return null
    }
    const defs: { key: 'kb' | 'skill' | 'workflow' | 'automation'; label: string }[] = [
      { key: 'kb', label: '知识库' },
      { key: 'skill', label: '技能中心' },
      { key: 'workflow', label: '工作流广场' },
      { key: 'automation', label: '自动化任务' },
    ]
    return defs.map(def => ({ ...def, points: permissions.filter(point => keyOf(point.group) === def.key) })).filter(group => group.points.length > 0)
  }, [permissions])
  const visiblePermissions = useMemo(() => groups.flatMap(group => group.points), [groups])
  const [draft, setDraft] = useState<Record<string, Set<string>>>(() => Object.fromEntries(visibleRoles.map(role => [role.code, new Set(role.permissions)])))
  const [dirty, setDirty] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copyKey = async (key: string): Promise<void> => {
    try { await navigator.clipboard.writeText(key) } catch { /* Clipboard may be unavailable in an iframe. */ }
    setCopiedKey(key)
    window.setTimeout(() => { setCopiedKey(current => current === key ? null : current) }, 1600)
  }

  useEffect(() => {
    setDraft(Object.fromEntries(visibleRoles.map(role => [role.code, new Set(role.permissions)])))
    setDirty(new Set())
  }, [visibleRoles])

  const isSuperRole = (code: string): boolean => code === 'SUPER_ADMIN' || code === '超级管理员'
  const isDepartmentRole = (code: string): boolean => code === 'DEPT_ADMIN' || code === '部门管理员'
  const isAppRole = (code: string): boolean => code === 'APP_USER' || code === '应用人员' || code === '普通用户'
  const globalScope = (point: { key: string; scope?: string }): boolean => point.scope === 'global' || point.scope === 'GLOBAL'
    || point.key === 'skill:review:global' || point.key === 'workflow:review:global'
  const locked = (roleCode: string, point: { key: string; scope?: string }): boolean => {
    if (!writable || actorRole !== 'SUPER_ADMIN') return true
    // Global points are only assignable to the two administrator roles; SUPER_ADMIN remains
    // editable for the actor who already holds it, while DEPT_ADMIN/APP_USER are read-only.
    return globalScope(point) && (isDepartmentRole(roleCode) || isAppRole(roleCode))
  }

  const [transposed, setTransposed] = useState(false)
  const toggle = (roleCode: string, pointKey: string, checked: boolean): void => {
    setDraft(current => {
      const next = new Set(current[roleCode] ?? [])
      if (checked) next.add(pointKey)
      else next.delete(pointKey)
      return { ...current, [roleCode]: next }
    })
    setDirty(current => new Set(current).add(roleCode))
  }

  return (
    <div className={styles.panel}>
      <div className={styles.matrixHead}>
        <span className={styles.matrixHeadLeft}>
          <h2 className={styles.sectionTitle}>{t('permRoleMatrix')}</h2>
          <button
            type="button"
            className={transposed ? styles.matrixTool + ' ' + styles.matrixToolActive : styles.matrixTool}
            data-matrix-transpose=""
            aria-pressed={transposed}
            title={t('permTranspose')}
            aria-label={t('permTranspose')}
            onClick={() => { setTransposed(value => !value) }}
          >
            ⇄
          </button>
        </span>
        <span className={styles.roleSearchWrap}>
          <svg className={styles.roleSearchIcon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="m10.5 10.5 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            className={styles.roleSearch}
            value={roleQuery}
            placeholder={t('permRoleSearch')}
            aria-label={t('permRoleSearch')}
            onChange={(event) => { setRoleQuery(event.target.value) }}
          />
        </span>
      </div>
      {shownRoles.length === 0 ? (
        <p className={styles.empty}>{t('permRoleEmpty')}</p>
      ) : transposed ? (
      <div className={styles.matrixScroll}>
        <table className={styles.matrix} data-matrix-orientation="transposed">
          <thead>
            <tr>
              <th className={styles.matrixRoleHead}>{t('permRoleColumn')}</th>
              {visiblePermissions.map(point => (
                <th key={point.key} className={styles.matrixPermHead} title={point.key}>{point.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRoles.map(role => (
              <tr key={role.code}>
                <th scope="row" className={styles.matrixRoleCell}>{role.name}</th>
                {visiblePermissions.map(point => (
                  <td key={point.key}>
                    <label className={styles.permission}>
                      <input
                        type="checkbox"
                        checked={draft[role.code]?.has(point.key) === true}
                        disabled={locked(role.code, point) || busy}
                        onChange={(event) => { toggle(role.code, point.key, event.target.checked) }}
                      />
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : (
      <div className={styles.matrixScroll}>
        <table className={styles.matrix} data-matrix-orientation="normal">
          <thead>
            <tr>
              <th>{t('permPermissionModule')}</th>
              <th>{t('permPermissionPoint')}</th>
              {shownRoles.map(role => <th key={role.code}>{role.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map(group => (
              <Fragment key={group.key}>
                {group.points.map((point, pointIndex) => {
                  const global = globalScope(point)
                  return (
                    <tr key={point.key}>
                      {pointIndex === 0 ? (
                        <th scope="rowgroup" rowSpan={group.points.length} className={styles.matrixModule}>{group.label}</th>
                      ) : null}
                      <th scope="row" className={styles.matrixPermission}>
                        <button type="button" className={styles.permCopy} title={point.key} onClick={() => { void copyKey(point.key) }}>
                          <span>{point.name}</span>
                          <span className={styles.scopeBadge} data-scope={global ? 'global' : 'department'}>{global ? '全局' : '部门级'}</span>
                          {copiedKey === point.key ? <span className={styles.copied}>已复制</span> : null}
                        </button>
                        {point.description === undefined ? null : <span className={styles.permDescription}>{point.description}</span>}
                      </th>
                      {shownRoles.map(role => (
                        <td key={role.code}>
                          <label className={styles.permission}>
                            <input
                              type="checkbox"
                              checked={draft[role.code]?.has(point.key) === true}
                              disabled={locked(role.code, point) || busy}
                              onChange={(event) => { toggle(role.code, point.key, event.target.checked) }}
                            />
                            {global && (isDepartmentRole(role.code) || isAppRole(role.code))
                              ? <span className={styles.onlyAdmin}>仅管理员</span>
                              : null}
                          </label>
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      )}
      <div className={styles.panelFoot}>
        {error === null ? null : <span className={styles.error}>{error}</span>}
        {actorRole !== 'SUPER_ADMIN' ? <span className={styles.readOnly}>{t('permSuperAdminOnly')}</span> : null}
        <Button
          variant="primary"
          size="sm"
          disabled={dirty.size === 0 || busy || saving}
          onClick={() => {
            setSaving(true)
            setError(null)
            const changes = visibleRoles.filter(role => dirty.has(role.code)).map(role => ({ roleCode: role.code, permissionKeys: [...(draft[role.code] ?? [])] }))
            void onSaveAll(changes).then(result => {
              if (result.ok) { setDirty(new Set()); setError(null) }
              else setError(result.reason ?? t('permSaveFailed'))
            }).finally(() => { setSaving(false) })
          }}
        >
          {t('permSave')}{dirty.size === 0 ? '' : ' (' + String(dirty.size) + ')'}
        </Button>
      </div>
    </div>
  )
}

function MemberRoleCell({ member, visibleRoles, locked, busy, t, onGrant, onRevoke }: {
  member: MemberRow
  visibleRoles: VisibleRolesView | null
  locked: boolean
  busy: boolean
  t: (key: keyof typeof en) => string
  onGrant: (userId: string, roleCode: string, departmentCode?: string) => void
  onRevoke: (userId: string, roleCode: string) => void
}): ReactNode {
  const [selected, setSelected] = useState('')
  const roles = visibleRoles?.roles ?? []
  const canGrant = (role: VisibleRoleRow): boolean => {
    if (visibleRoles === null || visibleRoles.actorLevel >= role.level) return false
    if (!role.departmentScoped) return true
    return member.departmentCode !== undefined && visibleRoles.departmentCodes.includes(member.departmentCode)
  }
  const grantable = roles.filter(canGrant)
  return (
    <div className={styles.roleCell}>
      <span className={styles.roleTags}>
        {member.roleCodes.map(code => {
          const role = roles.find(item => item.code === code)
          const revocable = role !== undefined && canGrant(role)
          return (
            <span key={code} className={styles.roleTag}>
              {role?.name ?? code}
              {revocable && !locked ? (
                <button
                  type="button"
                  className={styles.roleRevoke}
                  title={t('permRevoke')}
                  aria-label={t('permRevoke') + ' ' + (role?.name ?? code)}
                  disabled={busy}
                  onClick={() => { onRevoke(member.userId, code) }}
                >
                  ×
                </button>
              ) : null}
            </span>
          )
        })}
      </span>
      <span className={styles.roleGrant}>
        <select value={selected} disabled={locked || busy || grantable.length === 0} onChange={(event) => { setSelected(event.target.value) }}>
          <option value="">{t('permGrantSelect')}</option>
          {grantable.map(role => <option key={role.code} value={role.code}>{role.name}</option>)}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || busy || selected === ''}
          onClick={() => {
            onGrant(member.userId, selected, member.departmentCode)
            setSelected('')
          }}
        >
          {t('permGrant')}
        </Button>
      </span>
    </div>
  )
}

function Members({ members, writable, actorRole, actorUserId, actorDepartmentCode, visibleRoles, busy, t, onSave, onGrant, onRevoke }: {
  members: readonly MemberRow[]
  writable: boolean
  actorRole: PortalRole
  actorUserId?: string
  actorDepartmentCode?: string
  visibleRoles: VisibleRolesView | null
  busy: boolean
  t: (key: keyof typeof en) => string
  onSave: (userId: string, roleCodes: string[]) => void
  onGrant: (userId: string, roleCode: string, departmentCode?: string) => void
  onRevoke: (userId: string, roleCode: string) => void
}): ReactNode {
  const [page, setPage] = useState(0)
  const protectedMember = (member: MemberRow): boolean => member.roleCodes.some(code => {
    if (code === 'SUPER_ADMIN' || code === '超级管理员' || code === 'ADMIN' || code === '管理员') return true
    // A department administrator may not touch another department administrator.
    return actorRole === 'DEPT_ADMIN' && (code === 'DEPT_ADMIN' || code === '部门管理员')
  })
  const superCount = members.filter(member => member.roleCodes.some(code => code === 'SUPER_ADMIN' || code === '超级管理员')).length
  const inScope = (member: MemberRow): boolean => actorRole === 'SUPER_ADMIN' || actorRole === 'ADMIN'
    || member.departmentCode === actorDepartmentCode
    || member.departmentPath?.some(entry => entry.code === actorDepartmentCode) === true
  const pages = Math.max(1, Math.ceil(members.length / PAGE_SIZE))
  const visible = members.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
  return (
    <div className={styles.panel}>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead><tr><th>{t('permMember')}</th><th>{t('permDepartment')}</th><th>{t('permRole')}</th></tr></thead>
          <tbody>
            {visible.map(member => {
              const isProtected = protectedMember(member)
              const scoped = inScope(member)
              const isSelf = actorUserId !== undefined && member.userId === actorUserId
              const lastSuper = superCount <= 1 && member.roleCodes.some(code => code === 'SUPER_ADMIN' || code === '超级管理员')
              const locked = !writable || !scoped || isSelf || lastSuper || (actorRole !== 'SUPER_ADMIN' && isProtected)
              return (
                <tr key={member.userId} data-locked={locked}>
                  <td><strong>{member.displayName}</strong><span className={styles.muted}> @{member.username}</span>{isProtected && actorRole !== 'SUPER_ADMIN' ? <span className={styles.protected}>受保护</span> : null}{isSelf ? <span className={styles.protected}>本人</span> : null}{lastSuper ? <span className={styles.protected}>最后一个超管</span> : null}{!scoped ? <span className={styles.protected}>越界</span> : null}</td>
                  <td>{member.departmentPath?.map(entry => entry.name).join(' / ') ?? '—'}</td>
                  <td>
                    <MemberRoleCell
                      member={member}
                      visibleRoles={visibleRoles}
                      locked={locked}
                      busy={busy}
                      t={t}
                      onGrant={onGrant}
                      onRevoke={onRevoke}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} onChange={setPage} />
    </div>
  )
}

function Departments({ departments, writable, canAssign, canWrite, t, onAssign, onAdd, onEdit, onDelete }: {
  departments: readonly DepartmentRow[]
  writable: boolean
  canAssign: boolean
  canWrite: boolean
  t: (key: keyof typeof en) => string
  onAssign: (department: DepartmentRow) => void
  onAdd: (parentCode: string | null) => void
  onEdit: (department: DepartmentRow) => void
  onDelete: (department: DepartmentRow) => void
}): ReactNode {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(departments.map(department => department.code)))
  const byParent = useMemo(() => {
    const map = new Map<string | null, DepartmentRow[]>()
    const codes = new Set(departments.map(department => department.code))
    for (const department of departments) {
      const parent = department.parentCode !== undefined && department.parentCode !== null && codes.has(department.parentCode) ? department.parentCode : null
      map.set(parent, [...(map.get(parent) ?? []), department])
    }
    for (const list of map.values()) list.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.code.localeCompare(right.code))
    return map
  }, [departments])

  const node = (department: DepartmentRow, depth: number): ReactNode => {
    const children = byParent.get(department.code) ?? []
    const open = expanded.has(department.code)
    return (
      <li key={department.code} className={styles.treeNode}>
        <div className={styles.treeRow} style={{ paddingLeft: String(8 + depth * 18) + 'px' }}>
          {children.length === 0 ? <span className={styles.treeSpacer} /> : (
            <button
              type="button"
              className={styles.treeToggle}
              aria-label={open ? '折叠' : '展开'}
              onClick={() => {
                setExpanded(current => {
                  const next = new Set(current)
                  if (next.has(department.code)) next.delete(department.code)
                  else next.add(department.code)
                  return next
                })
              }}
            >{open ? '▾' : '▸'}</button>
          )}
          <strong className={styles.treeName}>{department.name}</strong>
          <span className={styles.muted}>{department.code} · {department.memberCount ?? 0} 人</span>
          <span className={styles.deptAdmins}>
            {department.deptAdmins?.length === 0 || department.deptAdmins === undefined ? null
              : department.deptAdmins.map(admin => <span key={admin.userId} className={styles.adminTag}>{admin.displayName}</span>)}
          </span>
          <span className={styles.treeActions}>
            {canAssign ? <Button variant="ghost" size="sm" disabled={!writable} onClick={() => { onAssign(department) }}>分配管理员</Button> : null}
            {canWrite ? <Button variant="ghost" size="sm" onClick={() => { onAdd(department.code) }}>+ 子部门</Button> : null}
            {canWrite ? <Button variant="ghost" size="sm" onClick={() => { onEdit(department) }}>编辑</Button> : null}
            {canWrite ? <Button variant="ghost" size="sm" onClick={() => { onDelete(department) }}>删除</Button> : null}
          </span>
        </div>
        {children.length > 0 && open ? <ul className={styles.treeChildren}>{children.map(child => node(child, depth + 1))}</ul> : null}
      </li>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h2 className={styles.sectionTitle}>{t('permTabDepartments')}</h2>
        {canWrite ? <Button variant="outline" size="sm" onClick={() => { onAdd(null) }}>新增部门</Button> : null}
      </div>
      <ul className={styles.treeRoot}>
        {(byParent.get(null) ?? []).map(department => node(department, 0))}
      </ul>
      {departments.length === 0 ? <p className={styles.muted}>暂无部门。</p> : null}
    </div>
  )
}

/** Create/edit dialog for one department. */
function DepartmentFormDialog({ state, departments, t, onClose, onSaved }: {
  state: { mode: 'create' | 'edit'; parentCode?: string | null; department?: DepartmentRow } | null
  departments: readonly DepartmentRow[]
  t: (key: keyof typeof en) => string
  onClose: () => void
  onSaved: () => Promise<void>
}): ReactNode {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [parentCode, setParentCode] = useState('')
  const [description, setDescription] = useState('')
  const [owner, setOwner] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (state === null) return
    setCode(state.department?.code ?? '')
    setName(state.department?.name ?? '')
    setParentCode(state.parentCode ?? state.department?.parentCode ?? '')
    setDescription(state.department?.description ?? '')
    setOwner(state.department?.owner ?? '')
    setEnabled(state.department?.enabled !== false)
    setError(null)
  }, [state])

  if (state === null) return null
  const editing = state.mode === 'edit'
  const blocked = new Set<string>()
  if (editing && state.department !== undefined) {
    blocked.add(state.department.code)
    let changed = true
    while (changed) {
      changed = false
      for (const department of departments) {
        if (department.parentCode !== undefined && department.parentCode !== null && blocked.has(department.parentCode) && !blocked.has(department.code)) {
          blocked.add(department.code)
          changed = true
        }
      }
    }
  }

  const submit = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const result = editing && state.department !== undefined
        ? await updateDepartment({ code: state.department.code, name, parentCode: parentCode === '' ? null : parentCode, description, owner, enabled, updatedAt: state.department.updatedAt })
        : await createDepartment({ code: code.trim(), name: name.trim(), parentCode: parentCode === '' ? null : parentCode, description, owner, enabled })
      if (!result.ok) {
        setError(result.reason ?? '保存失败：后端拒绝或无权限（403）。')
        return
      }
      await onSaved()
    } catch {
      setError('保存失败：网络或后端异常。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => { if (!saving) onClose() }}
      title={editing ? '编辑部门' : '新增部门'}
      closeLabel="取消"
      className={styles.dialog as string}
      footer={(
        <div className={styles.dialogFooter}>
          <Button variant="outline" disabled={saving} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={() => { void submit() }}>保存</Button>
        </div>
      )}
    >
      <div className={styles.dialogBody}>
        <label className={styles.field}><span>部门编码</span><input value={code} disabled={editing} placeholder="例如 marketing" onChange={event => { setCode(event.target.value) }} /></label>
        <label className={styles.field}><span>部门名称</span><input value={name} placeholder="例如 市场部" onChange={event => { setName(event.target.value) }} /></label>
        <label className={styles.field}><span>上级部门</span>
          <SearchCombobox
            t={t}
            value={parentCode}
            ariaLabel="上级部门"
            placeholder={t('permNone')}
            options={[{ value: '', label: t('permNone') }, ...departments.filter(department => !blocked.has(department.code)).map(department => ({ value: department.code, label: department.name, hint: department.code }))]}
            onChange={setParentCode}
          />
        </label>
        <label className={styles.field}><span>描述</span><input value={description} onChange={event => { setDescription(event.target.value) }} /></label>
        <label className={styles.field}><span>负责人</span><input value={owner} onChange={event => { setOwner(event.target.value) }} /></label>
        <label className={styles.candidate}><input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked) }} /><span>启用</span></label>
        {error === null ? null : <p className={styles.error} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

function Resources({ resources, departments, writable, actorRole, actorDepartmentCode, busy, t, onSave }: {
  resources: readonly ResourceScopeRow[]
  departments: readonly DepartmentRow[]
  writable: boolean
  actorRole: PortalRole
  actorDepartmentCode?: string
  busy: boolean
  t: (key: keyof typeof en) => string
  onSave: (row: ResourceScopeRow, visibility: ResourceScopeRow['visibility'], departmentCode: string | null) => Promise<{ ok: boolean; reason?: string }>
}): ReactNode {
  const [page, setPage] = useState(0)
  const [draft, setDraft] = useState<Record<string, { visibility: ResourceScopeRow['visibility']; departmentCode: string | null }>>({})
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<ResourceScopeRow | null>(null)
  const pages = Math.max(1, Math.ceil(resources.length / PAGE_SIZE))
  const visible = resources.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
  const departmentOptions = actorRole === 'DEPT_ADMIN'
    ? departments.filter(department => department.code === actorDepartmentCode
      || department.path?.some(entry => entry.code === actorDepartmentCode) === true)
    : departments
  const keyOf = (row: ResourceScopeRow): string => row.kind + ':' + String(row.id)
  const valueOf = (row: ResourceScopeRow) => draft[keyOf(row)] ?? { visibility: row.visibility, departmentCode: row.departmentCode ?? null }
  const visibilityLabel = (visibility: ResourceScopeRow['visibility']): string => visibility === 'global'
    ? t('permGlobal')
    : visibility === 'department' ? t('permDepartmentScope')
      : visibility === 'unshared' ? t('permUnshared') : t('permPrivate')
  const typeLabel = (kind: ResourceScopeRow['kind']): string => kind === 'builtin'
    ? t('permResourceBuiltin')
    : kind === 'skill' ? t('permResourceSkill') : t('permResourceWorkflow')
  const statusLabel = (status: ResourceScopeRow['reviewStatus']): string => status === 'pending'
    ? t('permStatusPending')
    : status === 'approved' ? t('permStatusApproved')
      : status === 'rejected' ? t('permStatusRejected')
        : status === 'unshared' ? t('permUnshared') : '—'
  const departmentName = (code: string | null | undefined): string => code === null || code === undefined
    ? '—' : departments.find(department => department.code === code)?.name ?? code
  return (
    <div className={styles.panel}>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('permType')}</th>
              <th>{t('permName')}</th>
              <th>{t('permOwner')}</th>
              <th>{t('permScope')}</th>
              <th>{t('permDepartment')}</th>
              <th>{t('permOperations')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(row => {
              const key = keyOf(row)
              const value = valueOf(row)
              const edit = canEditResourceScopeRow({ kind: row.kind, visibility: row.visibility, departmentCode: row.departmentCode ?? null }, actorRole)
              const editable = writable && !busy && edit.allowed
              // Built-in skills expose the platform sharing decision; plaza rows only their scope.
              const visibilityOptions: ResourceScopeRow['visibility'][] = row.kind === 'builtin'
                ? (actorRole === 'SUPER_ADMIN' ? ['unshared', 'global', 'department'] : [row.visibility])
                : actorRole === 'DEPT_ADMIN'
                  ? [row.visibility]
                  : ['global', 'department']
              return (
                <tr key={key}>
                  <td>{typeLabel(row.kind)}</td>
                  <td><strong>{row.name}</strong></td>
                  <td>{ownerDisplay(row.ownerName)}</td>
                  <td>
                    <SearchCombobox
                      t={t}
                      value={value.visibility}
                      ariaLabel={t('permScope')}
                      placeholder={t('permSelect')}
                      disabled={!editable}
                      options={visibilityOptions.map(option => ({ value: option, label: visibilityLabel(option) }))}
                      onChange={(next) => {
                        const visibility = next as ResourceScopeRow['visibility']
                        setDraft(current => ({ ...current, [key]: { visibility, departmentCode: visibility === 'department' ? (current[key]?.departmentCode ?? row.departmentCode ?? actorDepartmentCode ?? null) : null } }))
                      }}
                    />
                  </td>
                  <td>
                    <SearchCombobox
                      t={t}
                      value={value.departmentCode ?? ''}
                      ariaLabel={t('permDepartment')}
                      placeholder={t('permNone')}
                      disabled={!editable || value.visibility !== 'department' || actorRole === 'DEPT_ADMIN'}
                      options={[{ value: '', label: t('permNone') }, ...departmentOptions.map(department => ({ value: department.code, label: department.name, hint: department.code }))]}
                      onChange={(next) => { setDraft(current => ({ ...current, [key]: { ...valueOf(row), departmentCode: next === '' ? null : next } })) }}
                    />
                  </td>
                  <td>
                    <div className={styles.rowActions}>
                      <Button variant="ghost" size="sm" onClick={() => { setDetail(row) }}>{t('permViewDetails')}</Button>
                      <Button variant="outline" size="sm" disabled={!editable} title={edit.allowed ? undefined : edit.reason} onClick={() => {
                        setError(null)
                        if (window.confirm(t('permSave') + '？')) {
                          void onSave(row, value.visibility, value.departmentCode).then(result => { if (!result.ok) setError(result.reason ?? t('permSaveFailed')) })
                        }
                      }}>{t('permSave')}</Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} onChange={setPage} />
      {error === null ? null : <p className={styles.error} role="alert">{error}</p>}

      <Modal
        open={detail !== null}
        onClose={() => { setDetail(null) }}
        title={t('permDetailTitle')}
        closeLabel={t('permClose')}
        className={styles.dialog as string}
        footer={<div className={styles.dialogFooter}><Button variant="outline" onClick={() => { setDetail(null) }}>{t('permClose')}</Button></div>}
      >
        {detail === null ? null : (
          <dl className={styles.detailGrid}>
            <dt>{t('permDetailType')}</dt><dd>{typeLabel(detail.kind)}</dd>
            <dt>{t('permDetailName')}</dt><dd>{detail.name}</dd>
            <dt>{t('permDetailOwner')}</dt><dd>{ownerDisplay(detail.ownerName)}</dd>
            <dt>{t('permDetailScope')}</dt><dd>{visibilityLabel(detail.visibility)}</dd>
            <dt>{t('permDetailDepartment')}</dt><dd>{departmentName(detail.departmentCode)}</dd>
            <dt>{t('permDetailStatus')}</dt><dd>{statusLabel(detail.reviewStatus)}</dd>
            <dt>{t('permDetailUpdated')}</dt><dd>{detail.updatedAt === undefined ? '—' : new Date(detail.updatedAt).toLocaleString()}</dd>
          </dl>
        )}
      </Modal>
    </div>
  )
}

/** Accessible searchable combobox used for visibility and department pickers. */
function SearchCombobox({ t, value, options, onChange, placeholder, ariaLabel, disabled = false }: {
  t: (key: keyof typeof en) => string
  value: string
  options: readonly { value: string; label: string; hint?: string }[]
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  disabled?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const selected = options.find(option => option.value === value)
  const filtered = useMemo(() => filterComboboxOptions(options, query), [options, query])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    inputRef.current?.focus()
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const index = filtered.findIndex(option => option.value === value)
    setActive(index >= 0 ? index : 0)
  }, [open, filtered, value])

  const choose = (next: string): void => {
    onChange(next)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className={styles.combobox} ref={rootRef}>
      <button
        type="button"
        className={styles.comboboxTrigger}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={selected === undefined ? styles.comboboxPlaceholder : undefined}>{selected?.label ?? placeholder}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className={styles.comboboxMenu}>
          <input
            ref={inputRef}
            className={styles.comboboxSearch}
            value={query}
            placeholder={t('permSearch')}
            aria-label={t('permSearch')}
            onChange={event => { setQuery(event.target.value); setActive(0) }}
            onKeyDown={event => {
              if (event.key === 'Escape') { setOpen(false); return }
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive(current => clampActiveIndex(current + 1, filtered.length)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActive(current => clampActiveIndex(current - 1, filtered.length)) }
              if (event.key === 'Enter') {
                event.preventDefault()
                const option = filtered[active]
                if (option !== undefined) choose(option.value)
              }
            }}
          />
          <ul className={styles.comboboxList} role="listbox" aria-label={ariaLabel}>
            {filtered.length === 0 ? <li className={styles.comboboxEmpty}>{t('permNoMatches')}</li> : filtered.map((option, index) => (
              <li key={option.value} role="option" aria-selected={option.value === value}>
                <button
                  type="button"
                  className={index === active ? styles.comboboxOption + ' ' + styles.comboboxOptionActive : styles.comboboxOption}
                  onMouseEnter={() => { setActive(index) }}
                  onClick={() => { choose(option.value) }}
                >
                  <span className={styles.comboboxCheck}>{option.value === value ? '✓' : ''}</span>
                  <span>{option.label}</span>
                  {option.hint === undefined ? null : <span className={styles.comboboxHint}>{option.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }): ReactNode {
  if (pages <= 1) return null
  return (
    <div className={styles.pager}>
      <Button variant="outline" size="sm" disabled={page === 0} onClick={() => { onChange(page - 1) }}>上一页</Button>
      <span className={styles.muted}>{page + 1} / {pages}</span>
      <Button variant="outline" size="sm" disabled={page >= pages - 1} onClick={() => { onChange(page + 1) }}>下一页</Button>
    </div>
  )
}

/** The four role labels, so the header does not show a backend code. */
function roleLabel(role: PortalRole): string {
  switch (role) {
    case 'SUPER_ADMIN': return '超级管理员'
    case 'ADMIN': return '管理员'
    case 'DEPT_ADMIN': return '部门管理员'
    default: return '应用人员'
  }
}
