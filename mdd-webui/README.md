# MDD Gateway Console

一个重写的 [MDD Sim Gateway](https://github.com/MddIdd/mdd-sim-gateway) 前端。

保留上游网关内核（FastAPI 控制面 + 每 SIM 的 Asterisk 引擎），前端从零重写为 TypeScript，
静态产物可部署到 Cloudflare Workers / Pages，网关本身留在本地、用 cloudflared Tunnel 接入。

---

## 为什么重写

上游 WebUI 是一个约 3000 行的 `UnifiedPages.jsx` 加一个 101 KB 的 `i18n.jsx`，
没有类型、没有 API 契约、没有测试。改一个字段要靠全局搜索确认它在哪里被消费。

这次重写的取舍：

- **契约先行**：`src/lib/types.ts` 是控制面 105 个路由的 TypeScript 投影，字段名与
  Python 响应逐字对应，不做 camelCase 转换。契约错了编译期就报错。
- **类型安全的 i18n**：`zh` 表按 `en` 表的键集合定型，只加一种语言的文案会构建失败。
- **运行时依赖只有两个**：React，以及浏览器软电话用的 **JsSIP**。路由是 60 行的 hash
  router，状态是 `useState` + Context，没有状态管理框架。JsSIP 是唯一一个为了「必须
  由浏览器说 SIP」才引入的库 —— 这一页单独拆成 chunk，其它八个页面不为它付首屏代价
  （主包 444 KB / gzip 132 KB，通话页 271 KB / gzip 62 KB，按需加载）。
- **可脱机开发**：`mock/server.mjs` 复刻了控制面里那些最容易搞错的行为（Cookie 属性、
  CSRF 校验、4401 关闭码、未初始化时的 409），所以没有硬件也能开发和演示。

---

## 快速开始

```bash
npm install

# 终端 1：Mock 控制面（无硬件）
node mock/server.mjs

# 终端 2：开发服务器，自动代理到 Mock
MDD_GATEWAY=http://127.0.0.1:8788 npx vite --port 5173
```

打开 http://localhost:5173 —— 首次会进入创建管理员流程（密码至少 10 位）。

### 连真实网关

```bash
MDD_GATEWAY=https://192.168.1.50:8443 npx vite --port 5173
```

网关是自签证书，Vite 代理已设 `secure: false`。注意控制面把会话 Cookie 设成
`Secure`，所以浏览器必须把该地址当作可信来源 —— `localhost` 与 `127.0.0.1` 满足，
局域网 IP 不满足，那种情况下需要给控制面配一张真证书或改用 Tunnel。

### 其他命令

```bash
npm run build            # 类型检查 + 生产构建
npm run typecheck        # 仅类型检查
npm run preview          # 预览构建产物
npm run verify:settings  # 设置页端到端校验（需先起 mock + vite）
npm run screenshots      # 桌面与移动端截图（需先起 mock + vite）
```
---

## 目录结构

```
src/
├── lib/
│   ├── types.ts      控制面 API 契约（105 路由的 TypeScript 投影）
│   ├── api.ts        带 CSRF 的类型化客户端
│   ├── auth.tsx      会话状态与登录/首次设置流程
│   ├── store.tsx     实时状态：WebSocket 优先，30 秒轮询兜底
│   ├── ws.ts         WebSocket 客户端（重连退避 + 4401 处理）
│   ├── i18n.tsx      中英文案，键集合受类型约束
│   ├── router.ts     hash 路由
│   ├── theme.ts      浅色/深色 + 强调色
│   ├── format.ts     字节/时长/时间戳格式化，缺值一律渲染成占位符
│   └── softphone.ts  JsSIP 软电话（本地媒体接管、静音轨回退、服务代码转义）
├── components/
│   ├── Shell.tsx     侧栏、顶栏、连接状态
│   └── ui.tsx        能力卡片、状态点、徽章等
└── views/
    ├── Login.tsx     登录 / 首次设置
    ├── Overview.tsx  概览
    ├── Devices.tsx   设备与三个独立能力开关
    ├── Lines.tsx     线路启停 / 编辑 / 在线率时间线 / 引擎日志
    ├── Messages.tsx  短信会话与发送
    ├── Keepalive.tsx 余额快照 / 查询规则 / 保号计划
    ├── Esim.tsx      读卡 / 配置启停 / 下载九步进度
    ├── Egress.tsx    代理库 / 国家出口 / 节点锁定 / UDP 校验
    ├── Notifications.tsx  四渠道 / 十事件开关 / 模板 / 投递日志
    ├── Calls.tsx     浏览器软电话 / 蜂窝通话 / 通话记录 / 语音留言
    ├── Settings.tsx  设置（硬件/模块配置、新设备默认值、VoWiFi 与通话、主机、eSIM、管理员）
    └── Placeholder.tsx  未知 hash 的兜底（路线图表已清空）
```

通话页是唯一被拆成独立 chunk 的视图（见上文的 JsSIP 说明）。

---

## 当前进度

| 页面 | 状态 |
|---|---|
| 登录 / 首次设置 | 完成 |
| 概览 | 完成 |
| 设备（三态能力开关） | 完成 |
| 短信（会话 + 发送） | 完成 |
| 设置（含大疆模块 `modem_profiles` 配置） | 完成 |
| 线路（启停 / 编辑 / 在线率时间线 / 引擎日志） | 完成 |
| 余额与保号（余额快照 / 查询规则 / 保号计划 / 手动执行） | 完成 |
| eSIM（读卡 / 缓存优先 / 配置启停与重命名 / 下载九步进度 / 通知 / 多 eUICC 清单） | 完成 |
| 网络出口（代理库 / 国家出口 / 节点锁定 / UDP 校验 / 状态新鲜度） | 完成 |
| 通知（六渠道 / 十事件开关 / 模板校验 / 测试投递 / 投递日志） | 完成 |
| 通话（浏览器软电话 / 蜂窝通话 / 通话记录 / 语音留言） | 完成 |
| AT 终端（AT 命令 / USSD 服务代码 / 三档命令策略 / 历史） | 完成 |

**十个页面全部完成。** 占位页仍然保留着，但路线图表已经是空的 —— 它现在只负责让一个
未知的 hash 落到一个有答复的页面上，而不是白屏。
设置页里的 eSIM 分区只编辑 lpac 的三项配置，profile 增删改与下载进度属于 eSIM 页。

### 自动化校验

```bash
node mock/server.mjs                      # 终端 1（MOCK_CONFIGURED=1 可跳过首次设置）
npx vite --port 5173                      # 终端 2
node scripts/verify-settings.mjs          # 设置页端到端：29 项断言
node scripts/verify-esim.mjs              # eSIM 页（含 eUICC 清单）：22 项断言
node scripts/verify-egress.mjs            # 网络出口页：20 项断言
node scripts/verify-notifications.mjs     # 通知页：27 项断言
node scripts/verify-calls.mjs             # 通话页：25 项断言
node scripts/verify-terminal.mjs          # AT 终端：20 项断言
node scripts/verify-softphone.mjs         # 软电话纯逻辑：14 项断言
MOCK_PASSWORD=mdd-demo-password node scripts/screenshots.mjs   # 桌面 + 移动截图
```

`verify-settings.mjs` 重点验证的正是设置页最容易悄悄破坏配置的地方：只改一个分区时
其它分区（包括本 UI 从不渲染的 `proxy`）是否原样保留、非法输入是否在客户端就被拦下、
保存后是否以服务端返回的文档重新建立基线。

`verify-egress.mjs` 验证的是「失败必须读起来像失败」：UDP 检测不过就是不过，
不显示成「慢」，也不显示任何延迟数字 —— 通过 TCP 探测的节点完全可能承载不了
IKEv2/ESP NAT-T，而这个页面的全部价值就在于不掩盖这一点。

`verify-notifications.mjs` 验证的是投递语义里最容易撒谎的几处：关闭的渠道点不动测试、
开着但没有事件开关的渠道不会投递、模板里的错别字在本地就被点出来、以及
PushPlus / 飞书回 200 但应用层报错时日志必须显示为失败。

`verify-calls.mjs` 验证的是通话页里几处「看起来正常但其实是错的」：页面打开时不会
自己注册（注册要开一条 WSS 会话，必须由人按）、未注册时拨号按钮不可点、WebRTC 端点
被关闭的线路既说明原因也点不动、蜂窝通话在没有任何浏览器注册的情况下也能拨出、
运营商未确认的拨号必须显示为「未确认」而不是成功或失败。

`verify-softphone.mjs` 不需要 Asterisk：它只验证那些**因为显而易见的写法在真实环境里
失败过**才存在的分支 —— 没有麦克风时仍能造出一条真实可用的静音音轨（否则 WebRTC
根本构不出 offer，通话在发出 INVITE 前就死了）、服务代码里的 `#` 在拼 URI 之前被转义
（RFC 3261 不允许，JsSIP 会直接拒绝整个 URI），以及每种麦克风故障被区分成不同文案。

四个校验脚本都可重复运行。

---

## 三个必须理解的约束

### 1. 会话 Cookie 是 `SameSite=Strict`

控制面这样设 Cookie：

```python
response.set_cookie("mdd_session", ..., httponly=True, secure=True, samesite="strict", path="/")
```

浏览器**不会**把它附到跨站请求上。所以前端必须与控制面同源 —— 生产环境靠
`worker/index.ts` 做同源前置。前端放 Pages、直接跨域调网关 API 会登录失败，
而且失败得很迷惑（Cookie 存下来了，但下一个请求不带上）。

**不要**为此把控制面改成 `SameSite=None`。详见 [部署文档](docs/DEPLOY-CLOUDFLARE.md)。

### 2. 三个能力互相独立

4G 数据、飞行模式、Wi-Fi Calling 是三个独立状态。关掉 4G 不会停 ModemManager，
也不会隐式进入飞行模式。前端对每个开关单独发一次
`PATCH /api/devices/{id}/capabilities`，每次只带一个键，**并且不做乐观更新** ——
能力变更会重启引擎的一部分，把"期望值"渲染成"实际值"会让操作员误以为隧道已经起来了。

### 3. `PUT /api/settings` 是顶层浅合并，但嵌套对象是整体替换

这两件事经常被混为一谈，而它们决定了设置页的写法。

**顶层是浅合并**：`config.update_settings()` 就是 `data["settings"].update(patch)`。
所以只提交改动过的顶层键是安全的，没提到的键不会被重置 —— 设置页正是这么做的，
它把草稿与服务端文档做 diff，只发脏掉的键。

（早期版本的本文档写的是「整体替换，必须先读再合并」，那是错的。实测：只提交
`rekey` 之后，`proxy`、`hardware`、`timezone` 全部原样保留。）

**嵌套对象是整体替换**：`{"hardware": {"modem_backend": "serial"}}` 会覆盖整个
`hardware` 对象。因此凡是编辑某个分区，都必须把该分区**完整**发出去。设置页的做法是
`{...服务端已存的分区, ...本页编辑过的字段}`，这样本页不渲染的键也不会被悄悄丢掉。

**唯一的例外是 `hardware`**：路由在写入前会先与已存值合并，所以只发后端开关不会
把 `modem_profiles` 一起抹掉。

校验是按键做的，失败返回 `400 {"detail": "..."}`。`proxy` / `updates` / 四个通知渠道 /
`hardware` 各有自己的规则；设置页在客户端复刻了同一套规则，因为一个被拒绝的 `PUT`
只值一次往返，而 400 的 detail 远不如「是哪一行哪个字段错了」有用。

### 4. 宿主只认登记过的 USB 模块

编排器拿 `(idVendor, idProduct)` 去 `hardware.modem_profiles` 里查表
（`host/mdd_orchestrator.py::usb_modems()`），查不到就当这块设备不存在 —— 插着也没用。
大疆一代蜂窝模块是 `2ca3:4006`（Quectel EG25-G），AT 口在 USB 接口 2，所以需要一条：

```json
{"name": "DJI Cellular Dongle", "vid": "2ca3", "pid": "4006", "at_interface": 2}
```

设置页的「硬件」页里有一键加入这条配置的按钮。VID/PID 写错与设备没插在表现上完全一样，
所以表单会拦下不是四位十六进制的输入。

---

## 文档

| 文档 | 给谁看 | 内容 |
|---|---|---|
| [部署手册](docs/部署手册.md) | 第一次装的人 | 网关本体安装、控制台构建、三种接入形态（CF Worker / 反向代理 / 纯演示）、**软电话证书**这一最易漏的步骤、升级卸载、部署自检清单与排障 |
| [操作手册](docs/操作手册.md) | 每天用的人 | 五分钟上手、九个页面与设置页的实际操作、危险操作速查、常见任务、出问题先看哪里 |
| [Cloudflare 部署细节](docs/DEPLOY-CLOUDFLARE.md) | 形态 A | Tunnel + Worker 同源前置的专项说明与 Cookie 排查清单 |
| [补齐功能安装说明](../mdd-addons/安装说明.md) | 要装那六个功能的人 | AT 终端 / Bark·邮件 / Telegram Bot / eUICC 清单 / 大疆驱动修复 —— 步骤、补丁、验证、回滚 |

部署形态速览：

- **Cloudflare Worker 同源前置（推荐）** —— 不需要公网 IP，一个域名搞定
- **自有域名 + nginx/Caddy 反向代理** —— 已有公网 IP 或已有反代
- **Cloudflare Pages 纯演示** —— 不接硬件，只展示界面
- Vercel **只适合纯演示**：它的 Serverless Function 不支持 WebSocket，实时状态推送会失效

---

## 许可

前端代码为本次重写的原创实现。

上游 MDD Sim Gateway 以 **GPL-3.0-only** 发布，因此本前端作为其衍生作品同样以
GPL-3.0-only 分发。若你把它并入上游仓库，必须保留上游的 `LICENSE`、`NOTICE` 与
`THIRD_PARTY_LICENSES.md`。

本仓库**不包含**任何来自 VoCat 的代码。VoCat 使用自定义的
「Vocat Research & Evaluation License」，该许可含地域限制与非商用限制，与 GPL-3.0
不兼容，两者不能合并。详见工作区的 `VoCat_vs_MDD_对比报告.md`。
