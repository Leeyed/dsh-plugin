import { useId, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { reviewDraft } from './review-command.mjs'

const targets = [
  ['uncommitted', '/review uncommitted'],
  ['base', '/review base <branch>'],
  ['commit', '/review commit <sha>'],
  ['custom', '/review custom <instructions>'],
]

export function ReviewCommand({ replaceDraft, close, stage, t }) {
  const name = useId()
  const [target, setTarget] = useState(null)
  const [value, setValue] = useState('')
  const command = reviewDraft(target, value)
  return <Modal open title={t('composer.reviewTitle')} description={t('composer.reviewDescription')}
    closeLabel={t('close')} onClose={close} className="dchat-command-dialog" contentClassName="dchat-command-dialog-content"
    footer={<>
      <Button variant="outline" onClick={close}>{t('cancel')}</Button>
      <Button variant="primary" disabled={!command} onClick={() => { if (command) stage(command) }}>{t('composer.stageCommand')}</Button>
    </>}>
    <div className="dchat-review-targets" role="radiogroup" aria-label={t('composer.reviewTarget')}>
      {targets.map(([key, syntax], index) => <label key={key}>
        <input name={name} type="radio" checked={key === target} data-modal-autofocus={index === 0 ? '' : undefined}
          onChange={() => { setTarget(key); setValue('') }} />
        <span>{t(`composer.review.${key}`)}<code>{syntax}</code></span>
      </label>)}
    </div>
    {target && target !== 'uncommitted' && <label className="dchat-review-argument">
      {t(`composer.reviewValue.${target}`)}
      {target === 'custom' ? <textarea rows={3} value={value} onChange={event => setValue(event.currentTarget.value)} />
        : <input value={value} onChange={event => setValue(event.currentTarget.value)} autoComplete="off" spellCheck={false} />}
    </label>}
    {replaceDraft && <p className="dchat-command-replace-note">{t('composer.replacesDraft')}</p>}
  </Modal>
}
