/**
 * Browser half of dsh-profile-gist-sync: one page inside Settings → Plugins.
 *
 * The page is deliberately three plain things — status, upload, sync — because
 * that is all this plugin is for. Everything fiddly (which Gist, which token,
 * which file, what gets excluded, how to undo) is either handled by the Host
 * half or folded into the collapsed 高级 section, so the normal path is one
 * button press with no fields to fill in.
 *
 * The page renders into the slot the Plugins section declares
 * (`settings.plugins.tab`), uses the host's theme tokens for every visible
 * colour, and talks to the Host half only through that half's HTTP routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-profile-gist-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-profile-gist-sync'
    const API = '/dsh-profile-gist-sync/api'
    const TAB_ORDER = 70

    /** UI strings. English is the fallback every other locale resolves to. */
    const DICT = {
      zh: {
        tab: '配置同步',
        title: '配置同步',
        subtitle: '把本机配置传到云端备份，或从云端同步回来。',
        statusTitle: '① 状态',
        recheck: '重新检查',
        openCloud: '打开云端备份',
        profileLabel: '本机 profile',
        filesLabel: '配置文件',
        lastUpload: '上次上传',
        lastSync: '上次同步',
        never: '还没有过',
        needRestart: '这个插件刚更新过：重启 DSH 之后，上传和同步按钮才能用。',
        hostMissing: '这个插件在 DSH 里没有加载成功，所以这一页拿不到本机配置。',
        hostMissingHint: '重启 DSH 之后再打开这一页即可。原始错误：',
        cloudNone: '还没有设置云端备份：点下面「上传到云端」就会自动建好。',
        cloudSame: '✓ 云端备份和本机一致，不用做任何事。',
        cloudDiffers: '云端备份有更新的内容：',
        cloudDiffersFiles: '个文件与本机不同',
        cloudDiffersHint: '点下面「从云端同步」把它们取回来。',
        cloudUnreachable: '暂时读不到云端备份',
        notChecked: '还没检查云端。',
        checking: '正在检查云端…',
        uploadTitle: '② 上传（把本机配置备份到云端）',
        uploadHint: '会覆盖云端上一次的备份，只备份配置，不含插件本体和凭据。',
        uploadAction: '上传到云端',
        exportAction: '另存为本地文件',
        uploaded: '✓ 已上传',
        droppedTitle: '没上传的本机依赖',
        droppedHint: '它们是本机路径，传到别的电脑只会指向不存在的目录。那边同步时会保留原有的写法。',
        filesUnit: '个文件',
        countsOverwrite: '覆盖',
        countsAdd: '新增',
        countsIdentical: '不变',
        syncTitle: '③ 同步（把云端配置取回本机）',
        syncHint: '云端的配置写入本机；本机独有的文件保留，插件清单取并集。',
        syncAction: '从云端同步',
        synced: '✓ 已同步',
        syncedSkipped: '，跳过',
        syncedSkippedUnit: '项（凭据库等不写入）',
        restartHint: '重启 DSH 后生效。',
        undoAction: '撤销上次同步',
        undoAvailable: '可撤销：',
        undone: '✓ 已还原',
        advanced: '高级设置',
        gistIdLabel: '云端备份 ID（Gist）',
        gistIdPlaceholder: '留空并保存 = 下次上传时新建一个',
        save: '保存',
        saved: '✓ 已保存',
        gistIdHint: '这些设置不会进入备份，记在这里：',
        profileLocation: '本机 profile：',
        tokenLabel: 'GitHub 令牌（一般不用填）',
        tokenPlaceholder: '留空就用本机 gh 登录或环境变量',
        tokenCheck: '检测令牌',
        tokenHint: '令牌只用于这一次请求，不会被保存。',
        tokenOk: '✓ 令牌可用：',
        includeMachine: '备份时带上本机用量统计（data/usage.json）',
        pickFile: '从备份文件恢复…',
        pendingTitle: '待恢复的备份文件',
        pendingPlan: '将写入',
        importConfirm: '确认恢复',
        cancel: '取消',
        imported: '✓ 已恢复',
        showFiles: '显示文件清单',
        hideFiles: '收起文件清单',
        excludedLabel: '已排除',
        filesEmpty: '没有可备份的配置文件。',
        excludedEmpty: '没有排除任何文件。',
        limits: '上限：整份备份 2 MB，Gist 单文件 1 MB。',
        busy: '处理中…',
        'code.dependency': '依赖目录',
        'code.lockfile': '锁文件',
        'code.hidden-dir': '隐藏目录',
        'code.backup-copy': '备份副本',
        'code.symlink': '符号链接',
        'code.machine-state': '本机用量',
        'code.credential': '凭据库',
        'code.binary': '二进制',
        'code.too-large': '文件过大',
        'code.tool-state': '临时状态',
        'code.local-dependency': '本机路径依赖',
        'err.auth': [
          'GitHub 进不去：这个令牌不行。',
          '可能是令牌无效或过期，可能少了 gist 权限，也可能它属于另一个 GitHub 账号',
          '——secret Gist 只有它的主人能通过 API 读到。',
          '',
          '三种给令牌的方法，选一种：',
          '1. 在本页「高级设置 → GitHub 令牌」粘贴一个，只用于这一次，不会保存；',
          '2. 在启动 DSH 的环境里设 DSH_GITHUB_TOKEN，然后重启 DSH；',
          '3. 装过 GitHub CLI 的话执行 gh auth login，插件会自动取 gh auth token。',
          '',
          '令牌要勾上 gist 权限：GitHub → Settings → Developer settings →',
          'Personal access tokens → Tokens (classic) → Generate new token。',
          '勾好 gist 的直达链接：https://github.com/settings/tokens/new?scopes=gist&description=DSH%20config%20sync',
        ].join('\n'),
        'err.notfound': '找不到这个 Gist：核对 ID 或链接，并确认令牌属于它的主人。',
        'err.rate-limit': 'GitHub 限流或权限不足，请稍后再试。',
        'err.invalid': '备份内容不合法，无法恢复。',
        'err.too-large': '备份超出大小上限。',
        'err.timeout': '访问 GitHub 超时。',
        'err.network': '连不上 GitHub。',
        'err.no-profile': '这个 DSH 进程没有以 profile 启动，没有配置可备份。',
        'err.no-cloud': '还没有云端备份，请先上传。',
        'err.unsafe-path': '备份里有不安全的路径，已拒绝恢复。',
        'err.nothing-to-undo': '没有可以撤销的同步。',
        'err.invalidJson': '这不是合法的 JSON 文件。',
        'err.other': '操作失败。',
        'source.request': '本次填写',
        'source.env': '环境变量',
        'source.gh': 'gh CLI',
        pluginsTitle: '插件',
        pluginsHint: '备份不带插件本体。同步之后这里会列出还差的插件。',
        pluginsChecking: '正在看还缺哪些插件…',
        pluginsUnknown: '这台机器查不了还缺哪些插件（DSH 没提供插件管理服务）。',
        pluginsUnknownHint: '按「高级设置」里的换机步骤，手动把插件装上。',
        pluginsAllPresent: '✓ 清单里声明的插件，这台机器上都有。',
        pluginsMissing: '还差',
        pluginsMissingUnit: '个插件没装',
        pluginUnresolvedUnit: '个本机装不了',
        pluginsInstall: '安装缺的插件',
        pluginsInstalling: '正在安装…',
        pluginsInstalledCount: '已安装',
        pluginsPresentCount: '本来就有',
        pluginsFailedCount: '失败',
        pluginsSkippedCount: '跳过',
        pluginsRestart: '装完重启 DSH 才会生效。',
        pluginsDone: '✓ 装完了',
        'note.local-path': '本机路径，这台机器装不了',
        'note.workspace-protocol': 'workspace: 声明，这台机器装不了',
        newMachineTitle: '第一次在另一台电脑上用',
        newMachineStep1: '在这台电脑装好这个插件，然后重启 DSH。',
        newMachineStep2: '用同一个 GitHub 账号给令牌：secret Gist 只有它的主人能通过 API 读到，换个账号只会得到「找不到」。',
        newMachineStep3: '打开这一页，点「从云端同步」，把配置取回来。',
        newMachineStep4: '同步后这里会列出还差的插件，点「安装缺的插件」一次装完，再重启 DSH。',
        newMachineHint: '令牌的三种给法和 gist 权限，写在出错时的提示里。',
      },
      en: {
        tab: 'Config sync',
        title: 'Config sync',
        subtitle: 'Back this machine up to the cloud, or sync the cloud copy back here.',
        statusTitle: '① Status',
        recheck: 'Check again',
        openCloud: 'Open the cloud copy',
        profileLabel: 'Profile',
        filesLabel: 'Config files',
        lastUpload: 'Last upload',
        lastSync: 'Last sync',
        never: 'never',
        needRestart: 'This plugin was just updated: restart DSH, then the upload and sync buttons will work.',
        hostMissing: 'This plugin did not load inside DSH, so this page cannot read the local profile.',
        hostMissingHint: 'Restart DSH, then open this page again. The original error: ',
        cloudNone: 'No cloud copy yet: “Upload” below creates one for you.',
        cloudSame: '✓ The cloud copy matches this machine. Nothing to do.',
        cloudDiffers: 'The cloud copy is ahead:',
        cloudDiffersFiles: 'files differ from this machine',
        cloudDiffersHint: 'Use “Sync from cloud” below to bring them back.',
        cloudUnreachable: 'The cloud copy could not be read',
        notChecked: 'The cloud has not been checked yet.',
        checking: 'Checking the cloud…',
        uploadTitle: '② Upload (back this machine up to the cloud)',
        uploadHint: 'Overwrites the previous cloud backup. Configuration only — no plugins, no credentials.',
        uploadAction: 'Upload to cloud',
        exportAction: 'Save as a local file',
        uploaded: '✓ Uploaded',
        droppedTitle: 'machine-local dependencies left out',
        droppedHint: 'They are paths on this machine; on another computer they would point at a directory that is not there. A sync there keeps whatever it already has.',
        filesUnit: 'files',
        countsOverwrite: 'overwrite',
        countsAdd: 'add',
        countsIdentical: 'unchanged',
        syncTitle: '③ Sync (bring the cloud copy back here)',
        syncHint: 'Writes the cloud configuration here. Files only this machine has stay, and the plugin list is unioned.',
        syncAction: 'Sync from cloud',
        synced: '✓ Synced',
        syncedSkipped: ', skipped',
        syncedSkippedUnit: 'entries (a credential store is never written)',
        restartHint: 'Restart DSH to apply.',
        undoAction: 'Undo last sync',
        undoAvailable: 'Can be undone: ',
        undone: '✓ Reverted',
        advanced: 'Advanced',
        gistIdLabel: 'Cloud copy id (Gist)',
        gistIdPlaceholder: 'Leave empty and save to create a new one on the next upload',
        save: 'Save',
        saved: '✓ Saved',
        gistIdHint: 'These settings never enter a backup; they live at: ',
        profileLocation: 'This machine\u2019s profile: ',
        tokenLabel: 'GitHub token (usually unnecessary)',
        tokenPlaceholder: 'Empty uses this machine’s gh login or environment',
        tokenCheck: 'Check token',
        tokenHint: 'The token is used for this request only and is never stored.',
        tokenOk: '✓ Token works: ',
        includeMachine: "Include this machine's usage counters (data/usage.json)",
        pickFile: 'Restore from a backup file…',
        pendingTitle: 'Backup file ready to restore',
        pendingPlan: 'Will write',
        importConfirm: 'Restore now',
        cancel: 'Cancel',
        imported: '✓ Restored',
        showFiles: 'Show file list',
        hideFiles: 'Hide file list',
        excludedLabel: 'Excluded',
        filesEmpty: 'No configuration files to back up.',
        excludedEmpty: 'Nothing was excluded.',
        limits: 'Limits: 2 MB per backup, 1 MB per Gist file.',
        busy: 'Working…',
        'code.dependency': 'dependency',
        'code.lockfile': 'lockfile',
        'code.hidden-dir': 'hidden dir',
        'code.backup-copy': 'backup copy',
        'code.symlink': 'symlink',
        'code.machine-state': 'machine state',
        'code.credential': 'credential store',
        'code.binary': 'binary',
        'code.too-large': 'too large',
        'code.tool-state': 'tool state',
        'code.local-dependency': 'machine-local dependency',
        'err.auth': [
          'GitHub refused the token this machine offered.',
          'It may be invalid or expired, it may lack the gist scope, or it may belong to another',
          'GitHub account — a secret Gist is readable through the API only by its owner.',
          '',
          'Three ways to give it one, pick one:',
          '1. paste one into 高级设置 → GitHub 令牌 on this page, used for that request only and never saved;',
          '2. set DSH_GITHUB_TOKEN in the environment DSH starts with, then restart DSH;',
          '3. if the GitHub CLI is installed, run gh auth login — this plugin reads gh auth token.',
          '',
          'The token needs the gist scope: GitHub → Settings → Developer settings →',
          'Personal access tokens → Tokens (classic) → Generate new token.',
          'Direct link with gist pre-ticked: https://github.com/settings/tokens/new?scopes=gist&description=DSH%20config%20sync',
        ].join('\n'),
        'err.notfound': 'No such Gist — check the id or link, and that the token owns it.',
        'err.rate-limit': 'GitHub rate-limited the request or the token lacks scope.',
        'err.invalid': 'That backup is not valid, so it was not restored.',
        'err.too-large': 'The backup is over the size limit.',
        'err.timeout': 'The GitHub request timed out.',
        'err.network': 'GitHub is unreachable.',
        'err.no-profile': 'This DSH process was not started with a profile, so there is nothing to back up.',
        'err.no-cloud': 'There is no cloud backup yet — upload first.',
        'err.unsafe-path': 'The backup contains an unsafe path, so the restore was refused.',
        'err.nothing-to-undo': 'There is no sync to undo.',
        'err.invalidJson': 'That file is not valid JSON.',
        'err.other': 'The operation failed.',
        'source.request': 'entered here',
        'source.env': 'environment variable',
        'source.gh': 'gh CLI',
        pluginsTitle: 'Plugins',
        pluginsHint: 'A backup never carries plugin packages. After a sync, what is still missing is listed here.',
        pluginsChecking: 'Checking which plugins are missing…',
        pluginsUnknown: 'This machine cannot check which plugins are missing (DSH published no plugin manager).',
        pluginsUnknownHint: 'Follow the new-machine steps in Advanced and install them by hand.',
        pluginsAllPresent: '✓ Every plugin the manifest declares is on this machine.',
        pluginsMissing: 'Missing:',
        pluginsMissingUnit: 'plugins not installed',
        pluginUnresolvedUnit: 'cannot be installed here',
        pluginsInstall: 'Install the missing plugins',
        pluginsInstalling: 'Installing…',
        pluginsInstalledCount: 'installed',
        pluginsPresentCount: 'already there',
        pluginsFailedCount: 'failed',
        pluginsSkippedCount: 'skipped',
        pluginsRestart: 'Restart DSH after installing for them to take effect.',
        pluginsDone: '✓ Finished',
        'note.local-path': 'a local path — this machine cannot install it',
        'note.workspace-protocol': 'a workspace: declaration — this machine cannot install it',
        newMachineTitle: 'Using this on another computer the first time',
        newMachineStep1: 'Install this plugin there, then restart DSH.',
        newMachineStep2: 'Give it a token for the same GitHub account: a secret Gist is readable through the API only by its owner, so another account just gets "not found".',
        newMachineStep3: 'Open this page and press “Sync from cloud” to bring the configuration over.',
        newMachineStep4: 'What is still missing then appears here; press “Install the missing plugins” once, then restart DSH.',
        newMachineHint: 'The three token sources and the gist scope are in the error message when something fails.',
      },
      'zh-CN': null,
    }
    DICT['zh-CN'] = DICT.zh

    const CSS = `
.dcsx-root { display:flex; flex-direction:column; gap:14px; padding:2px 2px 28px; color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.6; }
.dcsx-head h2 { margin:0 0 2px; font-size:15px; font-weight:600; }
.dcsx-head p { margin:0; color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.dcsx-card { border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); padding:14px 16px; display:flex; flex-direction:column; gap:10px; }
.dcsx-cardtitle { font-size:13.5px; font-weight:600; }
.dcsx-hint { color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.dcsx-verdict { border-radius:10px; padding:9px 12px; border:1px solid var(--dsw-alias-border-l2); font-size:13px; }
.dcsx-ok { border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-state-success-primary); }
.dcsx-warn { border-color:var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-state-warn-primary); }
.dcsx-muted { color:var(--dsw-alias-label-secondary); }
.dcsx-facts { display:flex; flex-direction:column; gap:2px; }
.dcsx-row { display:flex; gap:10px; font-size:12.5px; }
.dcsx-row .dcsx-key { flex:0 0 96px; color:var(--dsw-alias-label-secondary); }
.dcsx-row .dcsx-val { min-width:0; word-break:break-all; }
.dcsx-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.dcsx-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-radius:8px; padding:7px 14px; font-size:12.5px; font-family:inherit; cursor:pointer; text-decoration:none; }
.dcsx-btn:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); }
.dcsx-btn:disabled { opacity:.55; cursor:default; }
.dcsx-btn-primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; }
.dcsx-btn-link { border-color:transparent; background:transparent; padding:2px 4px; color:var(--dsw-alias-brand-primary); }
.dcsx-field { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.dcsx-field .dcsx-key { flex:0 0 150px; color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.dcsx-input { flex:1 1 260px; min-width:0; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); padding:6px 10px; font-size:12.5px; font-family:inherit; }
.dcsx-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dcsx-check { display:flex; align-items:center; gap:8px; color:var(--dsw-alias-label-secondary); font-size:12.5px; cursor:pointer; }
.dcsx-notice { border-radius:10px; padding:9px 12px; border:1px solid var(--dsw-alias-border-l2); font-size:12.5px; white-space:pre-wrap; word-break:break-word; }
.dcsx-notice-ok { border-color:var(--dsw-alias-state-success-primary); }
.dcsx-notice-error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.dcsx-link { color:var(--dsw-alias-brand-primary); text-decoration:none; word-break:break-all; font-size:12.5px; }
.dcsx-details { border-top:1px dashed var(--dsw-alias-border-l1); padding-top:10px; }
.dcsx-details summary { cursor:pointer; color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.dcsx-advbody { display:flex; flex-direction:column; gap:12px; padding-top:12px; }
.dcsx-list { margin:0; padding:0; list-style:none; max-height:200px; overflow:auto; border-top:1px dashed var(--dsw-alias-border-l1); }
.dcsx-list li { display:flex; gap:10px; justify-content:space-between; padding:2px 0; border-bottom:1px dashed var(--dsw-alias-border-l1); font-size:12px; }
.dcsx-path { font-family:inherit; word-break:break-all; }
.dcsx-dim { color:var(--dsw-alias-label-secondary); flex:0 0 auto; }
.dcsx-sub { display:flex; flex-direction:column; gap:6px; padding-top:8px; border-top:1px dashed var(--dsw-alias-border-l1); }
.dcsx-subtitle { font-size:12.5px; font-weight:600; }
.dcsx-steps { margin:0; padding-left:18px; display:flex; flex-direction:column; gap:4px; color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.dcsx-busy { color:var(--dsw-alias-label-secondary); }
`
    let injected = false
    /** Add this page's stylesheet once per document. */
    function ensureStyles() {
      if (injected || typeof document === 'undefined') return
      injected = true
      const style = document.createElement('style')
      style.setAttribute('data-dsh-profile-gist-sync', '')
      style.textContent = CSS
      document.head.append(style)
    }

    /** One Host route call; a failed answer becomes an error with its code. */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        ...init,
        headers: init?.body === undefined ? init?.headers : { 'content-type': 'application/json', ...init?.headers },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const error = new Error(payload?.error ?? `HTTP ${response.status}`)
        error.code = payload?.code ?? 'other'
        throw error
      }
      return payload
    }

    /** Human-readable size. */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    }

    /** Absolute time, in the reader's own locale. */
    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
    }

    function Panel(props) {
      const { ctx, t } = props
      // Re-render on a locale switch; `t` itself reads the active locale.
      React.useSyncExternalStore(
        (notify) => ctx.locale.subscribe(notify),
        () => ctx.locale.getSnapshot(),
      )
      ensureStyles()
      const [status, setStatus] = React.useState(null)
      const [cloud, setCloud] = React.useState({ state: 'unknown' })
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [gistId, setGistId] = React.useState('')
      const [token, setToken] = React.useState('')
      const [includeMachine, setIncludeMachine] = React.useState(false)
      const [statusError, setStatusError] = React.useState(null)
      const [showFiles, setShowFiles] = React.useState(false)
      // `null` means "not asked yet", which is deliberately distinct from a
      // payload with `available: false` — the page must not paint a green line
      // for a question it has not put to the host.
      const [plugins, setPlugins] = React.useState(null)
      const [pluginReport, setPluginReport] = React.useState(null)

      const errorText = React.useCallback((error) => {
        const code = typeof error?.code === 'string' ? error.code : 'other'
        const localized = t(`err.${code}`)
        const fallback = t('err.other')
        const detail = typeof error?.message === 'string' ? error.message : ''
        if (localized === `err.${code}`) return detail === '' ? fallback : detail
        return detail === '' ? localized : `${localized}\n${detail}`
      }, [t])

      const run = React.useCallback(async (label, task) => {
        setBusy(label)
        setNotice(null)
        try {
          await task()
        } catch (error) {
          setNotice({ kind: 'error', text: errorText(error) })
        } finally {
          setBusy(null)
        }
      }, [errorText])

      /** Local facts plus what the Host remembers about the cloud copy. */
      const refresh = React.useCallback(async () => {
        const payload = await api('/status')
        setStatus(payload)
        setGistId(payload.cloud.gistId ?? '')
        setIncludeMachine(payload.cloud.includeMachine === true)
        return payload
      }, [])

      /** Read the cloud copy and say, in one line, whether it differs. */
      const checkCloud = React.useCallback(async () => {
        setCloud({ state: 'checking' })
        try {
          const payload = await api('/gist/read', { method: 'POST', body: {} })
          const counts = payload.preview.counts
          const different = counts.add + counts.overwrite + counts.merge
          setCloud({
            state: different === 0 ? 'same' : 'differs',
            different,
            files: payload.backup.files.length,
            updatedAt: payload.ref.updatedAt ?? null,
            url: payload.ref.htmlUrl ?? null,
          })
        } catch (error) {
          setCloud({
            state: error?.code === 'no-cloud' ? 'none' : 'error',
            text: errorText(error),
          })
        }
      }, [errorText])

      /** Which declared plugins this machine does not have yet. */
      const checkPlugins = React.useCallback(async () => {
        try {
          setPlugins(await api('/plugins'))
        } catch (error) {
          // A host that cannot answer is not the same as a clean answer, and the
          // page has to show which one it got.
          setPlugins({ available: false, reason: 'unreachable', text: errorText(error) })
        }
      }, [errorText])

      /** A one-line result banner, defined before any render path uses it. */
      const noticeView = (value) => h('div', { className: `dcsx-notice dcsx-notice-${value.kind}` },
        value.text,
        value.href === null || value.href === undefined
          ? null
          : h('div', null, h('a', { className: 'dcsx-link', href: value.href, target: '_blank', rel: 'noreferrer' }, value.href)),
      )

      /** One label/value line in the status card. */
      const row = (key, value) => h('div', { className: 'dcsx-row', key },
        h('span', { className: 'dcsx-key' }, key),
        h('span', { className: 'dcsx-val' }, value),
      )

      // On open: local facts always, the cloud only when one is remembered.
      React.useEffect(() => {
        void (async () => {
          try {
            const payload = await refresh()
            if (payload.cloud.gistId !== null) await checkCloud()
          } catch (error) {
            // Without this route there is nothing this page can do, so it must
            // say why instead of showing "checking" forever.
            setStatusError(error)
            setNotice({ kind: 'error', text: errorText(error) })
          }
        })()
        // Whether plugins are missing is worth knowing before any sync: it is
        // what a fresh restore of a previous machine leaves behind.
        void checkPlugins()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const upload = () => run('upload', async () => {
        const payload = await api('/gist/upload', { method: 'POST', body: { includeMachine } })
        // A dependency left out of the upload is news the reader can only act on
        // here: on the other machine it just silently will not be there.
        const left = Array.isArray(payload.dropped) && payload.dropped.length > 0
          ? `\n${t('droppedTitle')}：${payload.dropped.map(entry => `${entry.name}（${entry.spec}）`).join('、')}\n${t('droppedHint')}`
          : ''
        setNotice({
          kind: 'ok',
          text: `${t('uploaded')} ${payload.files} ${t('filesUnit')}（${formatBytes(payload.bytes)}）${left}`,
          href: payload.ref.htmlUrl ?? null,
        })
        await refresh()
        await checkCloud()
      })

      const sync = () => run('sync', async () => {
        const payload = await api('/sync', {
          method: 'POST',
          body: token.trim() === '' ? {} : { token: token.trim() },
        })
        const counts = payload.report.counts
        const skip = payload.report.dropped.length === 0
          ? ''
          : `${t('syncedSkipped')} ${payload.report.dropped.length} ${t('syncedSkippedUnit')}`
        setNotice({
          kind: 'ok',
          text: `${t('synced')} ${payload.report.restored} ${t('filesUnit')}（${t('countsOverwrite')} ${counts.overwrite} · ${t('countsAdd')} ${counts.add} · ${t('countsIdentical')} ${counts.identical}）${skip}\n${t('restartHint')}`,
        })
        setPluginReport(null)
        await refresh()
        // A sync writes a manifest that may name plugins this machine lacks, so
        // the question is asked again right after it, which is what makes the
        // ③ card able to answer "what now?" without a second button press.
        await checkPlugins()
        await checkCloud()
      })

      const installPlugins = () => run('plugins', async () => {
        const payload = await api('/plugins/install', { method: 'POST', body: {} })
        setPlugins(payload)
        setPluginReport(payload)
      })

      const undo = () => run('undo', async () => {
        const payload = await api('/undo', { method: 'POST', body: {} })
        setNotice({ kind: 'ok', text: `${t('undone')} ${payload.report.reverted} ${t('filesUnit')}` })
        await refresh()
        await checkCloud()
      })

      const saveSettings = () => run('save', async () => {
        const payload = await api('/settings', {
          method: 'POST',
          body: { gistId: gistId.trim(), token: undefined, includeMachine },
        })
        setNotice({ kind: 'ok', text: t('saved') })
        await refresh()
        if (payload.cloud.gistId === null) setCloud({ state: 'none' })
        else await checkCloud()
      })

      const checkToken = () => run('token', async () => {
        const payload = await api('/gist/token', {
          method: 'POST',
          body: token.trim() === '' ? {} : { token: token.trim() },
        })
        const login = typeof payload.login === 'string' ? ` · ${payload.login}` : ''
        setNotice({ kind: 'ok', text: `${t('tokenOk')}${t(`source.${payload.source}`)}${login}` })
      })

      /** Remember the usage-counter choice as soon as it is toggled. */
      const toggleMachine = (value) => {
        setIncludeMachine(value)
        void api('/settings', { method: 'POST', body: { includeMachine: value } }).catch(() => {})
      }

      /** Restore from a file the reader picks; the Host previews it first. */
      const chooseFile = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'
        input.onchange = () => {
          const file = input.files?.[0]
          if (file === undefined || file === null) return
          void run('file', async () => {
            const text = await file.text()
            let parsed
            try {
              parsed = JSON.parse(text)
            } catch {
              const error = new Error('')
              error.code = 'invalidJson'
              throw error
            }
            const payload = await api('/preview', { method: 'POST', body: { backup: parsed } })
            setPending({ name: file.name, backup: parsed, preview: payload.preview })
          })
        }
        input.click()
      }

      const applyPending = () => run('restore', async () => {
        const payload = await api('/restore', {
          method: 'POST',
          body: { backup: pending.backup, confirm: true },
        })
        setPending(null)
        setNotice({
          kind: 'ok',
          text: `${t('imported')} ${payload.report.restored} ${t('filesUnit')}\n${t('restartHint')}`,
        })
        setPluginReport(null)
        await refresh()
        await checkPlugins()
      })

      if (status === null) {
        // The Host half answers /status, so a failure here means its routes are
        // not there at all — the plugin did not load in this DSH process, which
        // a restart is what fixes. Say that; never spin on "checking".
        return h('div', { className: 'dcsx-root' },
          h('div', { className: 'dcsx-head' }, h('h2', null, t('title'))),
          notice === null ? null : noticeView(notice),
          h('div', { className: 'dcsx-card' },
            h('div', { className: 'dcsx-hint' }, statusError === null ? t('checking') : t('hostMissing')),
            statusError === null ? null : h('div', { className: 'dcsx-hint' }, `${t('hostMissingHint')}${errorText(statusError)}`),
          ),
        )
      }

      // The host half is only re-imported when DSH restarts, while this page can
      // already be the new one. A status payload without `cloud` therefore means
      // "new page, old host": say so plainly instead of failing in the reader's
      // face. Everything below tolerates `settings === null`.
      const settings = status.cloud ?? null
      const staleHost = settings === null
      const exportHref = `${API}/export${includeMachine ? '?include=machine' : ''}`
      const cloudUrl = cloud.url ?? (staleHost || settings.gistId === null ? null : `https://gist.github.com/${settings.gistId}`)
      const verdict = staleHost
        ? { kind: 'warn', text: t('needRestart'), hint: null }
        : cloudVerdict(cloud, settings.gistId !== null, t)
      const disabled = busy !== null || staleHost

      const stamp = (record) => record === null || record === undefined
        ? t('never')
        : `${formatTime(record.at)} · ${record.files ?? '?'} ${t('filesLabel')}`

      const statusCard = h('div', { className: 'dcsx-card' },
        h('div', { className: 'dcsx-cardtitle' }, t('statusTitle')),
        h('div', { className: `dcsx-verdict dcsx-${verdict.kind}` }, verdict.text),
        verdict.hint === null ? null : h('div', { className: 'dcsx-hint' }, verdict.hint),
        h('div', { className: 'dcsx-facts' },
          row(t('profileLabel'), status.profile),
          row(t('filesLabel'), `${status.counts.files} · ${formatBytes(status.counts.bytes)}`),
          staleHost ? null : row(t('lastUpload'), stamp(settings.lastUpload)),
          staleHost ? null : row(t('lastSync'), stamp(settings.lastSync)),
        ),
        h('div', { className: 'dcsx-actions' },
          h('button', { className: 'dcsx-btn', onClick: () => run('check', checkCloud), disabled }, t('recheck')),
          cloudUrl === null ? null : h('a', { className: 'dcsx-link', href: cloudUrl, target: '_blank', rel: 'noreferrer' }, t('openCloud')),
        ),
      )

      const uploadCard = h('div', { className: 'dcsx-card' },
        h('div', { className: 'dcsx-cardtitle' }, t('uploadTitle')),
        h('div', { className: 'dcsx-hint' }, t('uploadHint')),
        h('div', { className: 'dcsx-actions' },
          h('button', { className: 'dcsx-btn dcsx-btn-primary', onClick: upload, disabled }, busy === 'upload' ? t('busy') : t('uploadAction')),
          h('a', { className: 'dcsx-btn', href: exportHref }, t('exportAction')),
        ),
      )

      /**
       * What the manifest declares and this machine lacks.
       *
       * Lives inside the ③ card because that is where the question arises — a
       * sync just wrote a plugin list here — and because it is the one thing to
       * do next when the cloud copy named plugins. It never claims more than it
       * knows: a host without a plugin manager says so in the same place, in the
       * same words, rather than showing an empty list that reads as "all good".
       */
      const pluginsBlock = (() => {
        if (plugins === null) {
          return h('div', { className: 'dcsx-sub' },
            h('div', { className: 'dcsx-hint dcsx-busy' }, t('pluginsChecking')),
          )
        }
        if (plugins.available !== true) {
          const detail = typeof plugins.text === 'string' ? plugins.text : ''
          return h('div', { className: 'dcsx-sub' },
            h('div', { className: 'dcsx-subtitle' }, t('pluginsTitle')),
            h('div', { className: 'dcsx-verdict dcsx-warn' }, t('pluginsUnknown')),
            detail === '' ? null : h('div', { className: 'dcsx-hint' }, detail),
            h('div', { className: 'dcsx-hint' }, t('pluginsUnknownHint')),
          )
        }
        const missing = Array.isArray(plugins.missing) ? plugins.missing : []
        if (missing.length === 0) {
          return h('div', { className: 'dcsx-sub' },
            h('div', { className: 'dcsx-verdict dcsx-ok' }, t('pluginsAllPresent')),
          )
        }
        const counts = plugins.counts ?? {}
        const unresolved = Number.isFinite(counts.unresolved) ? counts.unresolved : 0
        // What to show beside a name: the version it will install when this
        // machine can install it at all, and the reason when it cannot.
        const detailOf = (entry) => {
          if (entry.resolvable !== true) return t(`note.${entry.note}`)
          if (typeof entry.version === 'string') return entry.version
          if (typeof entry.spec === 'string') return entry.spec
          return ''
        }
        return h('div', { className: 'dcsx-sub' },
          h('div', { className: 'dcsx-subtitle' }, t('pluginsTitle')),
          h('div', { className: 'dcsx-verdict dcsx-warn' },
            `${t('pluginsMissing')} ${missing.length} ${t('pluginsMissingUnit')}`
            + (unresolved === 0 ? '' : `（${unresolved} ${t('pluginUnresolvedUnit')}）`)),
          h('ul', { className: 'dcsx-list' },
            missing.map(entry => h('li', { key: entry.name },
              h('span', { className: 'dcsx-path' }, entry.name),
              h('span', { className: 'dcsx-dim' }, detailOf(entry)),
            )),
          ),
          h('div', { className: 'dcsx-hint' }, t('pluginsHint')),
          h('div', { className: 'dcsx-actions' },
            h('button', {
              // Not a second primary: ③ keeps exactly one, its sync button. This
              // is the follow-up that sync makes possible, not a competing path.
              className: 'dcsx-btn',
              onClick: installPlugins,
              disabled,
            }, busy === 'plugins' ? t('pluginsInstalling') : t('pluginsInstall')),
          ),
          pluginReport === null ? null : h('div', { className: 'dcsx-hint' }, outcomeText(pluginReport, t)),
        )
      })()

      const syncCard = h('div', { className: 'dcsx-card' },
        h('div', { className: 'dcsx-cardtitle' }, t('syncTitle')),
        h('div', { className: 'dcsx-hint' }, t('syncHint')),
        h('div', { className: 'dcsx-actions' },
          h('button', { className: 'dcsx-btn dcsx-btn-primary', onClick: sync, disabled }, busy === 'sync' ? t('busy') : t('syncAction')),
          status.undo === null
            ? null
            : h('button', { className: 'dcsx-btn', onClick: undo, disabled }, t('undoAction')),
        ),
        status.undo === null
          ? null
          : h('div', { className: 'dcsx-hint' }, `${t('undoAvailable')}${formatTime(status.undo.createdAt)} · ${status.undo.files} ${t('filesLabel')}`),
        pluginsBlock,
      )

      const pendingCard = pending === null ? null : h('div', { className: 'dcsx-card' },
        h('div', { className: 'dcsx-cardtitle' }, `${t('pendingTitle')}：${pending.name}`),
        h('div', { className: 'dcsx-hint' }, `${t('pendingPlan')} ${pending.preview.files.length} ${t('filesUnit')}：${t('countsOverwrite')} ${pending.preview.counts.overwrite} · ${t('countsAdd')} ${pending.preview.counts.add} · ${t('countsIdentical')} ${pending.preview.counts.identical}`),
        pending.preview.dropped.length === 0
          ? null
          : h('div', { className: 'dcsx-hint' }, `${t('excludedLabel')}：${pending.preview.dropped.map(entry => `${entry.path} (${t(`code.${entry.code}`)})`).join(', ')}`),
        h('div', { className: 'dcsx-actions' },
          h('button', { className: 'dcsx-btn dcsx-btn-primary', onClick: applyPending, disabled }, busy === 'restore' ? t('busy') : t('importConfirm')),
          h('button', { className: 'dcsx-btn', onClick: () => setPending(null), disabled }, t('cancel')),
        ),
      )

      const advanced = h('details', { className: 'dcsx-details' },
        h('summary', null, t('advanced')),
        h('div', { className: 'dcsx-advbody' },
          h('div', { className: 'dcsx-field' },
            h('span', { className: 'dcsx-key' }, t('gistIdLabel')),
            h('input', {
              className: 'dcsx-input',
              value: gistId,
              placeholder: t('gistIdPlaceholder'),
              onChange: (event) => setGistId(event.target.value),
            }),
            h('button', { className: 'dcsx-btn', onClick: saveSettings, disabled }, t('save')),
          ),
          h('div', { className: 'dcsx-hint' }, settings === null ? t('needRestart') : `${t('gistIdHint')}${settings.settingsFile ?? ''}`),
          h('div', { className: 'dcsx-hint' }, `${t('profileLocation')}${status.profile}（${status.root ?? ''}）`),
          h('div', { className: 'dcsx-field' },
            h('span', { className: 'dcsx-key' }, t('tokenLabel')),
            h('input', {
              className: 'dcsx-input',
              type: 'password',
              value: token,
              placeholder: t('tokenPlaceholder'),
              onChange: (event) => setToken(event.target.value),
            }),
            h('button', { className: 'dcsx-btn', onClick: checkToken, disabled }, t('tokenCheck')),
          ),
          h('div', { className: 'dcsx-hint' }, t('tokenHint')),
          // The checklist a reader needs precisely when the page has just told
          // them something is wrong — a new machine with no token yet. It sits
          // in the collapsed section rather than lengthening the three cards,
          // which are the part that has to stay one button each.
          h('div', { className: 'dcsx-sub' },
            h('div', { className: 'dcsx-subtitle' }, t('newMachineTitle')),
            h('ol', { className: 'dcsx-steps' },
              h('li', null, t('newMachineStep1')),
              h('li', null, t('newMachineStep2')),
              h('li', null, t('newMachineStep3')),
              h('li', null, t('newMachineStep4')),
            ),
            h('div', { className: 'dcsx-hint' }, t('newMachineHint')),
          ),
          h('label', { className: 'dcsx-check' },
            h('input', {
              type: 'checkbox',
              checked: includeMachine,
              onChange: (event) => toggleMachine(event.target.checked),
            }),
            t('includeMachine'),
          ),
          h('div', { className: 'dcsx-actions' },
            h('button', { className: 'dcsx-btn', onClick: chooseFile, disabled }, t('pickFile')),
          ),
          h('button', {
            className: 'dcsx-btn dcsx-btn-link',
            onClick: () => setShowFiles((value) => !value),
            disabled: false,
          }, showFiles ? t('hideFiles') : t('showFiles')),
          showFiles ? fileLists(status, t) : null,
          h('div', { className: 'dcsx-hint' }, t('limits')),
        ),
      )

      return h('div', { className: 'dcsx-root' },
        h('div', { className: 'dcsx-head' },
          h('h2', null, t('title')),
          h('p', null, t('subtitle')),
        ),
        notice === null ? null : noticeView(notice),
        statusCard,
        uploadCard,
        syncCard,
        pendingCard,
        advanced,
      )
    }

    /** One plain sentence about how the cloud copy compares with this machine. */
    function cloudVerdict(cloud, hasCloud, t) {
      if (cloud.state === 'checking') return { kind: 'muted', text: t('checking'), hint: null }
      if (cloud.state === 'none') return { kind: 'warn', text: t('cloudNone'), hint: null }
      if (cloud.state === 'same') return { kind: 'ok', text: t('cloudSame'), hint: null }
      if (cloud.state === 'differs') {
        return {
          kind: 'warn',
          text: `${t('cloudDiffers')} ${cloud.different} ${t('cloudDiffersFiles')}`,
          hint: t('cloudDiffersHint'),
        }
      }
      if (cloud.state === 'error') {
        return { kind: 'warn', text: `${t('cloudUnreachable')}：${cloud.text}`, hint: null }
      }
      return {
        kind: 'muted',
        text: hasCloud ? t('notChecked') : t('cloudNone'),
        hint: null,
      }
    }

    /**
     * One sentence about an install run, honest about each of the four outcomes.
     *
     * "Skipped" is not dressed up as success: those are the names this machine
     * cannot install at all because the manifest records a path, and saying
     * "done" over them would be the same lie as a green line over an unasked
     * question. A failed spec is named with the manager's own diagnostic.
     */
    function outcomeText(report, t) {
      const counts = report?.outcomeCounts ?? {}
      const parts = []
      if (counts.installed > 0) parts.push(`${counts.installed} ${t('pluginsInstalledCount')}`)
      if (counts['already-present'] > 0) parts.push(`${counts['already-present']} ${t('pluginsPresentCount')}`)
      if (counts.failed > 0) parts.push(`${counts.failed} ${t('pluginsFailedCount')}`)
      if (counts.skipped > 0) parts.push(`${counts.skipped} ${t('pluginsSkippedCount')}`)
      const results = Array.isArray(report?.results) ? report.results : []
      const failures = results
        .filter(result => result.outcome === 'failed' && typeof result.message === 'string' && result.message !== '')
        .map(result => `${result.name}: ${result.message}`)
      const lines = [`${t('pluginsDone')}${parts.length === 0 ? '' : ` · ${parts.join(' · ')}`}`]
      if (failures.length > 0) lines.push(...failures)
      if (report?.restart === true) lines.push(t('pluginsRestart'))
      return lines.join('\n')
    }

    /** The included/excluded file lists behind the toggle. */
    function fileLists(status, t) {
      const included = status.files.length === 0
        ? h('div', { className: 'dcsx-hint' }, t('filesEmpty'))
        : h('ul', { className: 'dcsx-list' },
            status.files.map(file => h('li', { key: file.path },
              h('span', { className: 'dcsx-path' }, file.path),
              h('span', { className: 'dcsx-dim' }, formatBytes(file.bytes)),
            )),
          )
      const excluded = status.excluded.length === 0
        ? h('div', { className: 'dcsx-hint' }, t('excludedEmpty'))
        : h('ul', { className: 'dcsx-list' },
            status.excluded.map(entry => h('li', { key: entry.path },
              h('span', { className: 'dcsx-path' }, entry.path),
              h('span', { className: 'dcsx-dim' }, t(`code.${entry.code}`)),
            )),
          )
      return h('div', null,
        h('div', { className: 'dcsx-hint' }, `${t('filesLabel')} (${status.files.length})`),
        included,
        h('div', { className: 'dcsx-hint' }, `${t('excludedLabel')} (${status.excluded.length})`),
        excluded,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Registering a dictionary that already exists is a no-op the host
        // rejects; each locale is registered on its own so one refusal cannot
        // take the whole page down.
        for (const locale of ['zh', 'zh-CN', 'en']) {
          try {
            ctx.effect(() => ctx.locale.register(NS, locale, DICT[locale]), `dsh-profile-gist-sync: ${locale}`)
          } catch (error) {
            console.warn(`[dsh-profile-gist-sync] could not register the ${locale} dictionary:`, error)
          }
        }
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: NS,
          order: TAB_ORDER,
          label: () => t('tab'),
          locale: NS,
        }, () => h(Panel, { ctx, t })))
      },
    }
  },
})
