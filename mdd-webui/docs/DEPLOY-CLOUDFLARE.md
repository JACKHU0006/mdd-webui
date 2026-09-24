# 部署到 Cloudflare

本前端有两种部署形态，选哪种取决于你想暴露什么。

| 形态 | 前端在哪 | 网关在哪 | 适用 |
|---|---|---|---|
| **A. 同源前置（推荐）** | Cloudflare Worker 静态资源 | 家里/机房 + Tunnel | 日常使用，一个域名搞定 |
| **B. 纯演示** | Cloudflare Pages | 不存在，用 Mock | 展示 UI，不接硬件 |

形态 B 只需 `npm run build` 后把 `dist/` 传上去，没有后端。

形态 A 是本文重点，因为它绕开了一个必须先讲清楚的坑。

---

## 为什么不能"前端放 Pages，直接调网关 API"

控制面的会话 Cookie 是这么设的（`control/app/auth.py`）：

```python
SESSION_COOKIE = "mdd_session"
response.set_cookie(..., httponly=True, secure=True, samesite="strict", path="/")
```

`SameSite=Strict` 的含义是：**浏览器不会把这个 Cookie 附在任何跨站请求上**。

如果前端在 `mdd-console.pages.dev`、网关在 `gateway.example.com`，那么从前者请求后者就是跨站 —— 即使两个域名都是你的、都是 HTTPS。结果是一个很迷惑的现象：

1. 登录请求成功，响应里带 `Set-Cookie`
2. 浏览器**确实存下了**这个 Cookie
3. 但下一个请求（`GET /api/devices`）浏览器不会带上它
4. 控制面返回 `401 authentication required`，界面跳回登录页

你会以为是密码错了或后端坏了，其实只是 Cookie 根本没发出去。

**不要试图去改控制面**把 `SameSite` 改成 `None`。那会削弱一个刻意的安全设计（Strict 是防 CSRF 的第一道防线），而且 `SameSite=None` 还要求 `Secure` 且必须显式配 CORS `Access-Control-Allow-Credentials`，等于为了部署方便把攻击面扩大。

**正解是让浏览器只看到一个源**：Worker 绑在 `gateway.example.com`，`/api/*` 和 `/ws` 反代到 Tunnel，其余走静态资源。这样 Cookie 是同站的，CSRF 头原样工作，控制面一行都不用改。

---

## 形态 A：Worker 同源前置

### 1. 在网关主机上建 Tunnel

网关本身不需要公网 IP，也不需要开放任何入站端口。

```bash
# 在网关主机上（Debian/Ubuntu/Armbian）
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list

sudo apt-get update && sudo apt-get install -y cloudflared

cloudflared tunnel login
cloudflared tunnel create mdd-origin
```

创建 `~/.cloudflared/config.yml`：

```yaml
tunnel: mdd-origin
credentials-file: /root/.cloudflared/<TUNNEL-UUID>.json

ingress:
  # 控制面监听 8443，自签证书。noTLSVerify 是必须的：Tunnel 出口到源站这一段
  # 已经在 Cloudflare 的加密通道内，源站证书只是自签，验证它没有意义。
  - hostname: mdd-origin.example.net
    service: https://127.0.0.1:8443
    originRequest:
      noTLSVerify: true
      # WebSocket 是控制面推送状态的主通道，必须允许。
      httpHostHeader: 127.0.0.1:8443

  - service: http_status:404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

> **注意**：Tunnel 只承载 HTTP/HTTPS/TCP。IKEv2/ESP 需要的 UDP 500/4500 **不能**通过 Tunnel 暴露 —— 但这不需要：VoWiFi 是网关**主动出站**到运营商 ePDG 的，不依赖任何入站端口。Tunnel 只用来访问管理界面。

### 2. 配置并部署 Worker

```bash
npm install -D wrangler
npx wrangler login
```

编辑 `wrangler.jsonc`，把两处占位符改掉：

```jsonc
"routes": [
  { "pattern": "gateway.example.com", "custom_domain": true }
],
"vars": { "ORIGIN": "" }   // 保持为空，用 secret 注入
```

```bash
npx wrangler secret put ORIGIN
# 输入：https://mdd-origin.example.net

npm run build
npx wrangler deploy
```

访问 `https://gateway.example.com` 即可。首次打开会进创建管理员流程。

### 3. 验证 Cookie 确实发出去了

这是排查时最有用的一条命令 —— 直接看响应头：

```bash
curl -sI --noproxy '*' https://gateway.example.com/api/auth/status
```

应该看到 `set-cookie: mdd_session=...; HttpOnly; Secure; SameSite=Strict`。如果浏览器仍然登录不上，打开开发者工具 → Application → Cookies，确认 `gateway.example.com` 下**有** `mdd_session`，再看 Network 里 `/api/devices` 的请求头是否带了 `Cookie`。

---

## 形态 B：纯演示（Pages）

不接后端，用于展示界面。

```bash
VITE_DEMO_MODE=1 npm run build
npx wrangler pages deploy dist --project-name mdd-console-demo
```

部署后界面顶部会出现"演示模式"提示条。注意 `VITE_DEMO_MODE=1` 只是加提示，**不会**自动接上 Mock 后端 —— 如果要让演示版真的能点，需要把 `mock/server.mjs` 改造成 Pages Functions 或单独部署到一个 Node 环境。静态 Pages 只能展示只读骨架。

---

## Vercel

Vercel 上做同源前置要用 `vercel.json` 的 rewrites 加一个 Serverless/Edge Function，原理与 Worker 相同，但要注意两点：

1. Vercel 的 Serverless Function **不支持 WebSocket**。控制面的实时状态推送会失效，界面会一直显示"重连中"，只能靠 30 秒轮询兜底。
2. Vercel 无法承载 UDP，也无法承载网关本体（没有 USB、没有 TUN、没有 root）。

所以 Vercel 适合形态 B（演示），不适合形态 A。**实时状态推送是 Cloudflare Workers 才能给的**，这也是推荐 CF 而不是 Vercel 的原因。

---

## 自检清单

- [ ] `https://gateway.example.com/api/auth/status` 返回 JSON，且带 `set-cookie`
- [ ] 浏览器里 `mdd_session` 的 Domain 是 `gateway.example.com`，不是 Pages 域名
- [ ] 开发者工具 Network 中，`/api/devices` 请求头里有 `Cookie: mdd_session=...`
- [ ] 界面左下角连接状态显示"实时"，不是"重连中"
- [ ] 发一条短信后，`/ws` 的 Messages 帧里能看到 `{"type":"sms",...}`
