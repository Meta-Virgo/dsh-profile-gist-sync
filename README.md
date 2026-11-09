# dsh-profile-gist-sync

Back up this DSH profile's configuration to an **unlisted secret GitHub Gist**,
pull it back on another machine, and see at a glance whether the two agree.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
plugin: a page in **Settings → Plugins → 配置同步 / Config sync**, and a
`config_backup` tool for the agent.

页面位置：**设置 → 插件 → 配置同步**。Agent 侧工具：`config_backup`。

## Install

```sh
dsh plugin --profile web add dsh-profile-gist-sync          # from npm
dsh plugin --profile web add github:Meta-Virgo/dsh-profile-gist-sync   # from source
```

Then restart DSH. No dependencies, no build step, no install scripts: the
package is plain ESM that Node runs as-is.

## The page

Three numbered steps, one button each; nothing has to be typed.

1. **状态** — one line saying whether the cloud copy and this machine agree,
   plus the profile, the file count, and the last upload/sync. It checks the
   cloud by itself on open; 重新检查 does it again.
2. **上传** — 上传到云端 backs this machine up to the cloud. The Gist this
   profile already uses is updated, and the first upload creates one and
   remembers it. 另存为本地文件 writes the same backup to a local file instead.
3. **同步** — 从云端同步 writes the cloud copy here, with 撤销上次同步 offered
   afterwards.

Everything fiddly (the Gist id, a token, the machine-state checkbox, restoring
from a backup file, the file list) sits in a collapsed **高级设置** section. The
Gist id and the last upload/sync are remembered in
`<profile>/.dsh-config-sync/settings.json`; that file is never part of a backup.

## What leaves this machine

Short version, for anyone deciding whether to install this:

- The only host ever contacted is `api.github.com`. The checks in `test/` fail if
  the plugin opens any other connection.
- Upload sends text configuration only — the files listed below. Credential
  stores, binaries, `node_modules`, the lockfile, and this machine's usage
  counters are excluded, and the UI names every exclusion instead of hiding it.
- The Gist is created `public: false`. **Unlisted, not private**: anyone with the
  link can read it, so the link is the secret.
- The GitHub token is never written anywhere; it is used for one request and can
  come from the request body, the host environment, or a signed-in `gh` CLI.
- The Gist id lives in `<profile>/.dsh-config-sync/settings.json` — inside a
  hidden directory, which backups never carry, so syncing a machine never leaks
  the id of the machine it came from.
- Restoring is merge-style and reversible: nothing is written before the
  overwritten bytes are snapshotted for 撤销上次同步.

## What a backup carries

Text configuration from the profile directory: `package.json`,
`cordis.patch.yml`, `cordis.yml`, `.npmrc`, `pnpm-workspace.yaml`,
`data/*.json`, `suppliers/*`, and any other text file the profile holds. The
document format is `dsh-profile-backup` v0.2 — the same one the DSH plugin market
reads and writes, so a backup from here imports there and vice versa.

Never included, and always listed as excluded in the UI:

| Path | Why |
| --- | --- |
| `node_modules/`, `pnpm-lock.yaml` | reproducible from `package.json` |
| `.git/`, `*.bak` | VCS state and repair leftovers |
| hidden directories (`.dsh-market/`, `.plugin-manager/`, `.dsh-config-sync/`) | logs, caches, this plugin's own undo snapshots |
| `data/auths/credentials.sqlite`, any other binary file | a credential store, and not portable |
| `data/usage.json` | this machine's counters — include with the checkbox when wanted |

A backup written elsewhere may still carry entries this plugin does not write
into a profile: the plugin market's exporter, for example, includes
`data/auths/credentials.sqlite`. Importing such a document is not refused — the
credential store, cached binaries, backup copies, oversized files, and hidden
directories are skipped, the rest of the configuration is restored, and the plan
lists exactly what was ignored and why. Only a path that escapes the profile, a
dependency directory, a duplicate path, a malformed entry, or a document with no
usable `package.json` is a hard refusal.

## Restore

Merge-style and reversible:

- Files in the backup are written; files only the local machine has stay.
- `package.json` is **merged**: dependencies and `dsh.profile.bundles` are
  unioned, so plugins already installed on the target machine are kept.
- Every overwritten or created path is copied into
  `<profile>/.dsh-config-sync/undo/<stamp>/` first, so the import can be undone
  from the page or with the tool's `undo` action.
- Installed plugins are not part of a backup: after a restore that adds
  dependencies, install them from the plugins page and restart DSH.

## GitHub Gist

Upload updates the Gist this profile remembers, or creates a secret one and
remembers it the first time; leave the id empty in 高级设置 and save to start a
different Gist, or paste an id/link to adopt one. Download reads
`dsh-profile-backup.json` from it and validates the document before anything is
written.

The token is never stored: paste one per session, or set `DSH_GITHUB_TOKEN` /
`GITHUB_TOKEN` on the host, or sign in with the `gh` CLI — the page offers a
"check token" button that reports which source answered. A secret Gist is
unlisted, **not private**: anyone with the link can read it.

## Agent tool

`config_backup` with `action`: `status`, `export`, `gist_upload`, `gist_read`,
`restore`, `undo`. Gist actions use the remembered cloud copy when `gistId` is
omitted, so "back this up" and "sync my configuration" work without an id.
`export` writes inside `<profile>/.dsh-config-sync/exports/`, and `restore`
reads only from inside the DSH home directory, so the tool cannot be used as a
file-system escape.

## Checks

```sh
node test/run.mjs
```

Four check files, each a separate process, all offline: profiles are temporary
directories, the GitHub HTTP layer is stubbed (and refuses every host but
`api.github.com`), and the only server any check talks to is its own loopback
port. They cover the document format and its exclusions, the restore plan and
undo, the activation contract, the route and tool surface, the first-run journey
against the stubbed GitHub — and that the package still activates after being
packed with only the manifest's `files` list.

## Which profile this plugin works on

A DSH process does **not** necessarily carry `DSH_PROFILE_DIR`. DSH Desktop
starts its host as
`DeepSeek Harness.exe --expose-internals …/dsh-desktop-host/lib/index.js <checkout> <profile dir> …`
with no profile variables at all — the `DSH_*` values a shell tool sees are
injected per call, not inherited by the host. So the profile is resolved from,
in order, and every source is checked against the filesystem before it is used:

1. what the running host reports (`profileContext`) — the launcher owns the
   location, so this wins when present;
2. `DSH_PROFILE_DIR`, then `DSH_HOME` + `DSH_PROFILE` (a CLI-started DSH takes
   these as instructions, and a missing directory is reported as such);
3. the `<profile dir>` argument the desktop host is started with;
4. the profile that has this plugin installed — the one running it;
5. the only profile present.

If none of them answers, the page says so instead of backing up the wrong
directory. `/api/status` carries the source that answered as `profileSource`
(and the `config_backup` tool prints it in its `status` summary); the page shows
the profile it settled on at the bottom of 高级设置.

## If the plugin does not load

设置 → 插件 → 插件列表 shows one row per loaded entry, with its `fiberPhase` and,
when it fails, a one-line diagnostic. When this plugin fails, none of its routes
exist: the page then answers `操作失败。HTTP 404` and names the missing host half
itself.

Two failures seen while building this, both worth avoiding:

- **`Invalid effect`** — a `ctx.effect(...)` callback returned something other
  than a disposer, and Cordis rejects the *whole row* for it (so the routes and
  the `config_backup` tool both disappear). Work that owns no resource belongs in
  a plain call inside `apply`, not in an effect.
- **`no-profile`** — the host was started without `DSH_PROFILE_DIR` and the
  fallback chain could not name a profile. See above.

Toggling that entry off and on re-imports the module from disk, so a source fix
applies **without restarting DSH**. A restart is only needed when the row's own
name changed, because the bundle then has to be resolved again at boot.

## Route surface

One `prefix` route on the bare web server:

```
GET  /dsh-profile-gist-sync/api/status
GET  /dsh-profile-gist-sync/api/export[?include=machine]
POST /dsh-profile-gist-sync/api/settings  { gistId?, includeMachine? }
POST /dsh-profile-gist-sync/api/sync      { id?, token? }
POST /dsh-profile-gist-sync/api/preview   { backup }
POST /dsh-profile-gist-sync/api/restore   { backup, confirm: true }
POST /dsh-profile-gist-sync/api/undo      {}
POST /dsh-profile-gist-sync/api/file/read { path }
POST /dsh-profile-gist-sync/api/gist/token  { token? }
POST /dsh-profile-gist-sync/api/gist/upload { id?, token?, includeMachine? }
POST /dsh-profile-gist-sync/api/gist/read   { id?, token? }
```

`/api/sync` is `/api/gist/read` plus `/api/restore` in one step, restricted to a
Gist target — that restriction is what keeps it from being a general write
endpoint: the document still has to be a valid `dsh-profile-backup`.

Every request must pass the host's own gate (`connection.requestRejection`)
when the host publishes one, and its Host must be loopback or an authority the
deployment declared.

## Licence

MIT. `icon.svg` is the plugin's own mark; `assets/icon-256.png` is the raster
form the plugin market asks for, generated by `assets/make-icon.py`.
