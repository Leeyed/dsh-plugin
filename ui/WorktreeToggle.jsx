import { useState } from 'react'
import clsx from 'clsx'
import { IconBranchOutlineRegular, IconChevronDownOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { en as forgeEn, zh as forgeZh } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/locales.ts'
import css from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/WorktreeToggle.module.css'

const worktreeKeys = [
  'worktree.label',
  'worktree.hint',
  'worktree.base',
  'worktree.baseHead',
  'worktree.baseMenu',
  'worktree.currentBranch',
  'worktree.currentBranchTip',
  'worktree.detachedTip',
  'checkout.detached',
]

function pickKeys(source) {
  return Object.fromEntries(worktreeKeys.map(key => [key, source[key]]))
}

export const worktreeCopy = {
  en: pickKeys(forgeEn),
  zh: pickKeys(forgeZh),
}

function BaseMenu({ base, current, branches, disabled, onRefresh, onSelect, t }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    if (!onRefresh) {
      setOpen(true)
      return
    }
    setLoading(true)
    void Promise.resolve(onRefresh()).finally(() => {
      setLoading(false)
      setOpen(true)
    })
  }

  const items = [
    { type: 'label', id: 'title', text: t('worktree.baseMenu') },
    ...(branches ?? []).map(name => ({
      id: name,
      label: name === current
        ? <span className={css.option}><span className={css.optionName}>{name}</span><span className={css.optionNote}>{t('worktree.currentBranch')}</span></span>
        : <span className={css.optionName}>{name}</span>,
    })),
  ]

  return (
    <Menu
      open={open}
      items={items}
      selectedId={base ?? undefined}
      onSelect={id => {
        setOpen(false)
        if (id !== base) onSelect(id)
      }}
      onClose={() => setOpen(false)}
      side="bottom"
      align="end"
      portal
      anchor={
        <button type="button" className={css.base} aria-haspopup="menu" aria-expanded={open} disabled={loading || disabled} onClick={toggle}>
          <span className={css.baseLabel}>{base === null ? t('worktree.baseHead') : t('worktree.base', { branch: base })}</span>
          <IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, open && css.chevronOpen)} />
        </button>
      }
    />
  )
}

export function WorktreeToggle({ gitInfo, enabled, from, disabled, onToggle, onSelectBase, onRefreshBranches, t }) {
  if (!gitInfo?.isGit) return null

  const current = gitInfo.current ?? (gitInfo.commit === null ? t('checkout.detached') : t('worktree.detachedTip', { commit: gitInfo.commit }))
  const base = enabled ? (from !== undefined ? from : gitInfo.current) : gitInfo.current
  const branchText = enabled
    ? (base === null ? t('worktree.baseHead') : t('worktree.base', { branch: base }))
    : current
  const branchTip = enabled || gitInfo.current === null ? branchText : t('worktree.currentBranchTip', { branch: gitInfo.current })
  const usable = Boolean(gitInfo.commit) && (gitInfo.branches?.length ?? 0) > 0
  const checkboxDisabled = Boolean(disabled) || (!gitInfo.commit && !enabled)

  return (
    <span className={css.root} data-forge-worktree="">
      {enabled && usable ? (
        <BaseMenu
          base={base ?? null}
          current={gitInfo.current}
          branches={gitInfo.branches}
          disabled={Boolean(disabled)}
          onRefresh={onRefreshBranches}
          onSelect={onSelectBase}
          t={t}
        />
      ) : (
        <Tooltip label={branchTip} side="bottom" portal openOnClick>
          <button type="button" className={css.current} aria-label={branchTip}
            data-forge-current-branch={enabled ? undefined : ''} data-forge-base-branch={enabled ? '' : undefined}>
            <IconBranchOutlineRegular size={14} />
            <span className={css.baseLabel}>{branchText}</span>
          </button>
        </Tooltip>
      )}
      <Tooltip label={t('worktree.hint')} side="bottom" delayMs={500}>
        <label className={css.toggle} data-disabled={checkboxDisabled ? '' : undefined}>
          <input
            type="checkbox"
            className={css.checkbox}
            checked={enabled}
            disabled={checkboxDisabled}
            onChange={event => onToggle(event.currentTarget.checked, gitInfo.current)}
          />
          {t('worktree.label')}
        </label>
      </Tooltip>
    </span>
  )
}
