# MDD 网关控制台

**自托管 SIM / eSIM 网关的管理控制台**，以及一批为网关本体补齐的功能。

底座是 [MddIdd/mdd-sim-gateway](https://github.com/MddIdd/mdd-sim-gateway)（GPL-3.0）。
本仓库做的是两件独立的事：**重写前端**，以及**补上上游没有的功能**。

```
mdd-webui/    控制台前端（React + TS + Vite），十个页面
mdd-addons/   网关本体侧的补齐功能（Python），六个功能
```

---

## 为什么分成两部分

| | `mdd-webui/` | `mdd-addons/` |
|---|---|---|
| 是什么 | 纯静态前端 | 网关控制面与宿主工具的增量 |
| 跑在哪 | 静态托管 + 同源反代（Cloudflare Worker / nginx） | 网关主机上 |
| 怎么装 | `npm ci && npm run build`，产物传上去 | 拷进你的 MDD fork，加几行登记 |
| 语言 | TypeScript / React | Python |

两部分是**分开部署、分开升级**的：控制台是纯静态产物，网关是那台插着 SIM 的机器。

---

## `mdd-webui/` —— 控制台

十个页面：概览、设备、线路、通话、**AT 终端**、短信、余额与保号、eSIM（含 eUICC 清单）、
网络出口、通知（六渠道）、设置。

```bash
cd mdd-webui
npm ci
npm run dev:mock        # 起 mock 后端 + vite，密码 mdd-demo-password
```

**没有硬件也能把界面点通** —— `mock/server.mjs` 复刻了控制面里那些最容易搞错的行为
（`SameSite=Strict` 的 Cookie、CSRF 校验、WebSocket 的 4401 关闭码、未初始化时的 409）。

几个不显然的设计约束，写在 [`mdd-webui/README.md`](mdd-webui/README.md) 里：

- 会话 Cookie 是 `SameSite=Strict`，所以**前端必须与控制面同源**。放 Pages 直接跨域调
  网关 API 会登录失败，而且失败得很迷惑（Cookie 存下来了，但下一个请求不带上）。
- 4G 数据 / 飞行模式 / Wi-Fi Calling 是三个独立状态，且**不做乐观更新**。
- 前端**零第三方运行时依赖**，除了 React 和浏览器软电话用的 JsSIP —— 后者单独拆包，
  另外九个页面不为它付首屏代价。

---

## `mdd-addons/` —— 补齐功能

上游没有、但实际用起来会缺的六件事：

| 功能 | 解决什么 |
|---|---|
| **大疆模块驱动修复** | 让 `2ca3:4006` 被认出来。不写 NV、不改 USB 身份 |
| **AT / USSD 终端** | 直接问模块：信号、注册状态、PDP、服务代码。**线路运行中也能用** |
| **Bark / 邮件通知** | 通知渠道从四个变六个 |
| **Telegram 双向 Bot** | 在手机上执行命令（白名单 + 一次性确认 + 冷却） |
| **多 eUICC 清单** | 看有几张 eUICC、哪条线路用哪张 |
| 多语言文档 | 不做，界面中英双语够用 |

**全部是新增文件 + 少量登记行，不改上游既有逻辑**，所以合并上游更新不会冲突。

```bash
cd mdd-addons
python3 tools/test-modem-repair.py            # 19 项
python3 control/app/test-at-terminal.py       # 70 项
python3 control/app/test-notify-channels.py   # 59 项
python3 control/app/test-telegram-bot.py      # 52 项
python3 control/app/test-esim-inventory.py    # 35 项
```

**235 项断言，全部不需要硬件、不需要网关、不需要网络** —— 模块的导入都做了延迟处理，
测试里对 `requests` 做了桩。装之前先跑一遍，确认没问题再往 fork 里并。

安装步骤见 **[mdd-addons/安装说明.md](mdd-addons/安装说明.md)**。

---

## 文档

| 文档 | 给谁看 |
|---|---|
| [部署手册](mdd-webui/docs/部署手册.md) | 第一次从空主机装到能用 |
| [操作手册](mdd-webui/docs/操作手册.md) | 每天用的人 |
| [补齐功能安装说明](mdd-addons/安装说明.md) | 要把那六个功能并进 fork 的人 |
| [mdd-addons/README](mdd-addons/README.md) | 想知道**为什么这么设计**的人 |
| [Cloudflare 部署细节](mdd-webui/docs/DEPLOY-CLOUDFLARE.md) | 形态 A 的专项说明 |

---

## 一个必须知道的约束

控制面的会话 Cookie 是 `HttpOnly; Secure; SameSite=Strict`。这意味着**浏览器不会把它
附在任何跨站请求上** —— 前端放 `*.pages.dev`、网关在另一个域名，登录会「成功」但下一个
请求就掉登录态，而且原因不会告诉你。

正解是让浏览器只看到一个源：Cloudflare Worker（或 nginx / Caddy）绑在你的域名上，
`/api/*` 和 `/ws` 反代到网关，其余走静态资源。**不要**去把控制面改成 `SameSite=None` ——
那是防 CSRF 的第一道防线。

详见[部署手册](mdd-webui/docs/部署手册.md)第 5 节。

---

## 许可

- 本仓库的代码：控制台为原创实现；`mdd-addons/` 为原创实现。
- 底座 [MddIdd/mdd-sim-gateway](https://github.com/MddIdd/mdd-sim-gateway) 为 **GPL-3.0-only**，
  本仓库不包含其源码，`mdd-addons/` 是作为独立增量使用的。
- 本仓库不含任何第三方源码副本。
