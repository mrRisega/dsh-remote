# dsh-remote-ui — 公网远程控制 dsh web 的插件

> **给 DeepSeek Harness（dsh web）一个「随时随地」的公网入口。**
> 安装后在 dsh web 的设置页登录账号，即得到一个专属的**加密远程地址**：人在办公室外、
> 用手机流量或任意网络打开它，都能像坐在电脑前一样操作 dsh——继续对话、看工具执行、
> 审批授权、改设置。**不要求手机和电脑在同一 WiFi/局域网**，也不需要公网 IP、
> 路由器映射或自己搭服务器，开箱即用、全程加密。
> 懂技术的用户也可以把服务部署到自己的服务器上，数据与流量完全自控（普通用户无需关心）。

以下为面向开发者/维护者的实现说明：

Embeds the dsh-remote configuration UI into dsh web itself (the "everything is a
plugin" model):

- Entry point: the **Settings** page, via the official `settings.section`
  extension point (`order: 30`, below "Agent presets").
- Inline configuration panel:
  - Connection-mode tabs: **Cloud service** (SaaS) / **Self-hosted**
  - Remote-control URL (from the relay `public-config` `app_url`, copyable)
  - Account: phone + password login/save, registration (with SVG captcha);
    signed-in state shows plan / upgrade / invite / feedback / **sign out**
  - Bridge service: launchd status (pid), start/stop switch; shows device id and
    autostart state — never exposes config paths or passwords
  - **About dsh-remote** card (for newcomers: SaaS convenience, bandwidth costs,
    self-hosting option)
  - **User feedback** card (submodule of the commercial edition): submit
    feedback (category + captcha anti-abuse) and track "my feedback" threads
    with admin replies; satisfaction popup ~10 minutes after first use
- First-run hint: a red dot on the "Remote Control" entry (localStorage
  `dsh-remote-seen-dot`).
- Config file: `~/.dsh-remote/.dsh-config.json` by default (0600), overridable
  via the entry config `relayDir` or `DSH_RELAY_DIR`.

## Architecture (dual-half plugin)

| Half | File | Responsibility |
|---|---|---|
| Node half (host plugin) | `lib/index.js` | Injects `webServer`; same-origin `/dsh-remote/*` routes: status / config / start / stop / captcha / register / login / remote-url / feedback proxy; relay requests bypass system proxies (6s timeout) |
| Browser half (client plugin) | `lib/client.js` | Hand-written `__ModuleLoader__.load({id, factory})` bundle (no build step); registers the `settings.section` entry + satisfaction popup; only requires `react` (seed module) |

The browser half needs no Vite/tsdown rebuild: `dsh-client-modules` reads
`exports["./client"]` at startup and serves it with index.html (restart
`dsh web` after changes).

## Install / Uninstall

`npx @mrrisega/dsh-remote`（一键安装）会自动把插件装进 dsh web 默认 profile。
也可以单独管理：

```bash
# 单独安装/重装(把插件装进 dsh web 默认 profile)
npx @mrrisega/dsh-remote plugin

# 卸载
npx @mrrisega/dsh-remote plugin --uninstall
```

What it does:

- `package.json` dependency: `"dsh-remote-ui": "link:<包目录>/packages/dsh-remote-ui"`
- `cordis.patch.yml` insert: `{ id: dsh-remote-ui, name: 'dsh-remote-ui', config: { relayDir: '~/.dsh-remote' } }`
- runs `pnpm install` (fallback `npm install`) in the profile

Restart `dsh web` afterwards. Manual alternative: edit the two files above and
restart.

> Note: a failing browser plugin blocks the whole web app from starting
> (framework constraint). Rollback = remove the patch entry and restart.

## Development

```sh
# node half: restart dsh web (profile uses link: dependency, source is live)
# browser half: edit lib/client.js, restart dsh web (no build)
dsh --profile web --port 3090 --no-open   # verify on a separate port, 3080 untouched
```

Verify: `/` `__DSH_BOOT__` contains `dsh-remote-ui`; `/plugins/dsh-remote-ui/client.js`
200; `/dsh-remote/status` returns JSON; panel renders in headless Chrome.

## Known limitations

- The entry uses the official Settings-page slot (`settings.section`, `order: 30`).
- First-run red dot relies on DOM fallback injection (MutationObserver matching
  the nav cell class + "远程控制" text); if the hash/wording changes the dot
  simply won't show — the panel itself is unaffected.
- Start/stop switches call launchctl (same bootstrap/bootout logic as
  `dsh-setup.mjs`).
- Feedback API defaults to the account API base (`cfg.api_url`); self-hosted or
  compatible implementations can override with `feedback_url` in the config.
