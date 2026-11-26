import mime from 'mime'

export const workspaceEntryTarget = 'direct-chat.workspace-entry'

export function workspaceEntryMenu({ session, fileActions, pathLabel, fileLabel, writeClipboard, notify }) {
  async function openPath(request) {
    const result = await session.openWorkspacePath(request)
    if (!result.ok) throw new Error('Host could not open path')
  }

  return {
    id: workspaceEntryTarget,
    target: workspaceEntryTarget,
    order: 100,
    async resolve({ sessionId, entry, absolutePath, openIn }, signal) {
      const url = new URL('/api/direct-chat/sessions/' + encodeURIComponent(sessionId) + '/download', document.baseURI)
      url.searchParams.set('path', entry.path)
      const [desktop, available] = await Promise.all([
        session.canOpenWorkspacePath().then(result => result.ok && result.value).catch(() => false),
        entry.directory || fetch(url, { method: 'HEAD', signal, credentials: 'same-origin' }).then(res => res.ok).catch(() => false),
      ])
      signal.throwIfAborted()
      const manager = document.documentElement.dataset.platform === 'darwin' ? 'menu.finder' : 'menu.reveal'
      const reveal = {
        id: 'reveal', icon: { key: 'open-in-app.reveal' }, label: pathLabel(manager), disabled: !desktop || !available,
        failureLabel: pathLabel('path.revealError'), run: () => openPath({ path: absolutePath, action: 'reveal' }),
      }
      const copyPath = {
        id: 'copyPath', icon: { key: 'open-in-app.copy' },
        label: pathLabel(entry.directory ? 'menu.copyDirectoryPath' : 'menu.copyPath'), failureLabel: pathLabel('menu.copyFailed'),
        run: async () => {
          if (!await writeClipboard(absolutePath)) throw new Error('Clipboard unavailable')
          notify(pathLabel('menu.copied'), true)
        },
      }
      if (entry.directory) return [reveal, copyPath]

      let application
      if (desktop && available) {
        const apps = await session.workspacePathApplications({ path: absolutePath }, signal).catch(() => null)
        signal.throwIfAborted()
        application = apps?.ok && apps.value.find(app => app.default)
      }
      const mediaType = mime.getType(entry.name) ?? 'application/octet-stream'
      const image = mediaType.startsWith('image/')
      const source = {
        url: url.href, name: entry.name, mediaType,
        async read(signal) {
          const response = await fetch(url, { signal, credentials: 'same-origin' })
          if (!response.ok) throw new Error('Original file unavailable')
          const blob = await response.blob()
          return blob.slice(0, blob.size, mediaType)
        },
      }
      async function save(mode) {
        const result = await fileActions.save(source, mode)
        if (result.status === 'cancelled') return
        const message = result.status === 'requested' ? 'menu.downloadStarted' : mode === 'download' ? 'menu.downloaded' : 'menu.saved'
        notify(fileLabel(message), true, result.status !== 'saved' ? undefined : {
          label: fileLabel(manager), failureLabel: fileLabel('path.revealError'),
          run: () => openPath({ path: result.path, action: 'reveal' }),
        })
      }
      return [
        { id: 'sidebar', icon: { key: 'open-in-app.sidebar' }, label: pathLabel('menu.openInSidebar'), disabled: !available, run: () => openIn(entry.path, 'sidebar') },
        { id: 'float', icon: { key: 'open-in-app.float' }, label: pathLabel('menu.openInFloat'), disabled: !available, run: () => openIn(entry.path, 'float') },
        reveal,
        { id: 'open', label: application ? pathLabel('open.title', { app: application.name }) : pathLabel('menu.defaultApp'),
          icon: { key: 'open-in-app.application', ...(application?.icon && { src: application.icon }) }, disabled: !application,
          run: () => openPath({ path: absolutePath, application: application.id }), failureLabel: pathLabel('path.openError') },
        copyPath,
        ...(image ? [{ id: 'copyImage', icon: { key: 'file-actions.copy' }, separatorBefore: true, label: fileLabel('menu.copyImage'),
          disabled: !available, failureLabel: fileLabel('menu.copyFailed'), run: async () => {
            await fileActions.copyImage(source)
            notify(fileLabel('menu.copied'), true)
          } }] : []),
        ...(image || !fileActions.canSaveAs ? [{ id: 'download', icon: { key: 'file-actions.download' }, label: fileLabel('menu.download'),
          disabled: !available, failureLabel: fileLabel('menu.saveFailed'), run: () => save('download') }] : []),
        ...(fileActions.canSaveAs ? [{ id: 'saveAs', icon: { key: 'file-actions.save' }, label: fileLabel('menu.saveAs'),
          disabled: !available, failureLabel: fileLabel('menu.saveFailed'), run: () => save('saveAs') }] : []),
      ]
    },
  }
}
