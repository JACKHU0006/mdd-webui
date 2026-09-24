# VoCat vs MDD Sim Gateway 全面对比

> 调研日期：2026-09-22
> 调研对象：`MengMengCode/VoCat`（含你给的 fork `EchoHS/VoCat`） vs `MddIdd/mdd-sim-gateway`
> 使用者背景：中国大陆，硬件为大疆一代 4G 模块（DJI Cellular Dongle，USB `2ca3:4006`，芯片 Quectel EG25-G），目标是把项目放到自己的 GitHub + Cloudflare/Vercel

---

## 0. 先说结论

**许可层面，VoCat 在你当前场景下直接不可用，这不是"要不要遵守"的问题，是作者主动设计的排除。**

三条硬阻断，全部有源码或许可原文佐证：

1. **地域**：许可 §4「Geographic Authorization」明确写着 *"operation of the Software is permitted only within the United States"*，并声明「Compilation, deployment, operation, or execution of the Software from unauthorized jurisdictions is prohibited」，且保留加入地理位置校验技术手段的权利。
2. **运营商代码**：许可 §6 点名 *"SIM cards associated with MCC 460"*。代码里已落地——`internal/device/region.go`：

   ```go
   // BlockedMCCs lists the mobile country codes whose SIM cards must not be
   // served by this product. The product does not provide service to mainland
   // China cards; ...
   var BlockedMCCs = map[string]string{
       "460": "中国",
       "461": "中国",
   }
   ```

   命中后的用户可见提示是：*「SIM 卡归属地为%s（MCC %s），本服务不向该地区卡片提供数据/短信/VoWiFi」*。阻断点覆盖 `internal/device/data.go`（数据）、`internal/device/sms.go`（短信）、`cmd/vocat/main.go`（会写入 `auto_region_block` 卡策略，并把飞行模式作为兜底强制执行）。
3. **有效期**：许可 §8 给每个安装实例 **14 天评估期**，到期必须停用并删除安装。

许可 §9 还声明软件「may contain technical safeguards」，包括授权校验、完整性校验、过期控制、运行时完整性检查与自动禁用；§11 禁止发布任何移除这些机制的分支。也就是说，**把它 fork 到你自己 GitHub 再魔改绕过，是许可明文禁止的行为**。

反观 MDD Sim Gateway：**GPL-3.0-only**，无地域限制、无评估期、无 MCC 黑名单、无授权校验。你可以合法 fork、改、发布，唯一义务是衍生作品继续以 GPL-3.0 开源并保留 NOTICE。

> **结论**：如果要用国内卡，MDD 是唯一合规可选的基座。VoCat 值得作为**架构参考**读源码，但不适合作为你的分支起点。

---

## 1. 项目身份与许可

| | VoCat | MDD Sim Gateway |
|---|---|---|
| 上游仓库 | `MengMengCode/VoCat` | `MddIdd/mdd-sim-gateway` |
| 你给的链接 | `EchoHS/VoCat` = 上游的**空 fork**（0 star / 0 fork，无 Release） | 即上游本体 |
| Star / Fork | 927 / 290 | 614 / 276 |
| 创建 / 最后推送 | 2026-08-09 / 2026-09-17 | 2026-08-10 / 2026-09-21 |
| 许可 | **Vocat Research & Evaluation License v1.0**（源码可见，非开源，SPDX: NOASSERTION） | **GPL-3.0-only** |
| 地域限制 | 仅限美国（§4） | 无 |
| 有效期 | 14 天（§8） | 无 |
| 商用 | 禁止（§3） | 允许 |
| 允许的用途 | 个人非商用硬件开发、学术教育、非营利、授权测试卡 | 任意（含商用） |
| 分支政策 | 允许，但不得移除反滥用机制、不得绕过地域/卡资格/设备数/过期限制（§11） | 允许，须继续 GPL-3.0 开源 |
| 商标 | 不得暗示与 VoCat 有关联（§19） | 无此条款 |

两个项目创建时间只差一天（8/09 vs 8/10），是同一赛道的同期竞品。

---

## 2. 技术架构

| | VoCat | MDD Sim Gateway |
|---|---|---|
| 后端语言 | **Go 1.25** | Python（FastAPI） |
| 交付形态 | **单个静态二进制** + SQLite，前端编译进二进制 | 控制面容器 + 每 SIM 一个引擎容器 + 宿主 orchestrator |
| 前端 | React 19 + TypeScript 5.8 + Tailwind 3 + Vite 7 | React + JS + Vite |
| 进程模型 | 一个 systemd 服务 | systemd（控制面 / orchestrator）+ Docker 多容器 |
| 语音/VoWiFi 实现 | **Go 自研**：`internal/vowifi/ike`（IKEv2）+ `internal/vowifi/ims`（IMS、SMS、通话运行时）+ `internal/vowifi/ec20_adapter.go` | 打补丁的 **SWu-IKEv2/IPsec** + **sysmocom Asterisk**（含 IMS-AKA 补丁），每张 SIM 一个隔离容器 |
| 是否需要 Asterisk | **否** | **是**（且需在设备上打 7 个补丁重新编译） |
| 内核依赖 | Linux **XFRM/IPsec**（`ip xfrm state list` 可用） | Docker + 内核 **TUN** |
| 依赖数量 | 10 个直接 Go 依赖，全部轻量 | FastAPI + React + sing-box + Xray-core + lpac + PCSC/CCID(打补丁) + PyCryptodome + panoramisk 等 |
| 持久化 | SQLite（`modernc.org/sqlite`，纯 Go，无 CGO） | SQLite / 配置文件（root 0600 原子写） |
| 磁盘占用 | 单二进制（数十 MB 量级） | Engine 镜像 **607 MB**，两代镜像共享基础层后约 676 MB，控制面另需 355 MB；根分区安装前需 **≥2 GiB**，升级建议留 3 GiB |
| 支持平台 | Linux amd64/386/arm64/aarch64/armv7，**含 OpenWrt/Kwrt** | Debian / Ubuntu / Armbian **ARM64** |

**架构取向差异很明显**：VoCat 走"单二进制、少依赖、能塞进路由器"；MDD 走"容器隔离、每 SIM 一套完整 Asterisk、功能优先"。

---

## 3. 功能对比

| 能力 | VoCat | MDD Sim Gateway |
|---|---|---|
| 设备发现 | 自动串口/USB 发现，多模块 | ModemManager + PC/SC，多模块 + 读卡器 |
| 射频/网络 | 注册状态、运营商、RSRP/RSRQ/SINR、频段、信道、手动选网 | 同级别，且 4G / 飞行模式 / VoWiFi **三态独立** |
| AT / USSD 终端 | **有**（交互式 AT 终端 + 命令历史 + USSD 流程） | 有 USSD |
| 蜂窝短信 | 有（直接蜂窝 + IMS） | 有 |
| IMS 短信 | 有 | 有 |
| **浏览器软电话** | **无**（前端无 WebRTC/JsSIP，无 Calls 页面；VoWiFi 语音信令未开放，`call_api.go` 对语音直接返回 `501 vowifi_voice_unavailable`） | **有**（JsSIP 浏览器软电话、通话记录、未接来电通知、本地语音留言） |
| MMS | 无 | **有**（PDU 编解码、图片处理、独立传输设置） |
| eSIM / eUICC | eUICC 发现、EID、证书元数据、多 eUICC 清单、启用/禁用/切换、下载、改名、删除 | lpac 管理，支持需显式选安全元件的双 SE 卡 |
| 卡策略 | ICCID 维度的 VoWiFi / 飞行模式策略 | 按 ICCID 自动建线路草稿 |
| 代理 / 国家出口 | **自研** `internal/exportproxy`（SOCKS + HTTP + Linux bind + ipinfo）+ `internal/proxy/probe`；国家规则、设备绑定、TCP 可达性 + **UDP Associate 检查** | **sing-box 每国独立 TUN**（如 `mdd-jp`）+ **Xray-core 承载 Reality/XHTTP**（仅回环 SOCKS）；候选节点须过 UDP 健康检查，失败按 SIM 故障关闭 |
| 余额 / 保号 | **无** | **有**（余额、套餐到期、在线状态、定时发送真实计费保号短信、续费余额监测） |
| Telegram | **双向 Bot**：`/status`、`/esim`、`/switch`、`/wfc`、`/sms`，敏感操作需一次性确认 | **仅单向推送**（明确不接受远程控制指令） |
| 其他通知 | Telegram / Bark / 邮件 / PushPlus / 签名 webhook，每条短信单独推送 | Webhook / Telegram（含国家出口路由）/ PushPlus / 多个飞书·Lark 机器人（支持签名校验、按线路路由） |
| 自动化任务 | 有（`AutomaticTasksPage`） | 有（保号定时、更新检查每 6 小时） |
| 系统更新 | 内置 GitHub Release 自更新 + SHA-256 校验 | 后台版本检查 + `update-policy.json` 授权式无人值守升级 + 镜像回滚 |
| 审计 / 日志 | 审计事件、实时日志、日志留存 | 审计记录、日志捕获、脱敏支持包 |
| 多语言 | **文档 8 种语言**（英/阿/简中/繁中/法/俄/西/日），界面 en/zh | 界面 中文/English |
| 深浅色主题 | 有 | 有 |
| 认证安全 | 会话 + CSRF + 访问策略 + 安全 Cookie | scrypt 加盐、HttpOnly/Secure/SameSite=Strict、CSRF、防暴力登录、安装级随机引擎令牌 |

---

## 4. 硬件支持（重点：大疆一代）

| | VoCat | MDD Sim Gateway |
|---|---|---|
| 目标模块 | Quectel EC20 / EC25 / **EG25 family** / EG600 | ModemManager 全系蜂窝模块 + 大疆/Quectel EC25 类 |
| 内置 VID/PID 表 | 按 Quectel `2c7c` 识别；**另有 DJI 专用路径** | 仅一条：`{"name": "DJI/Quectel EC25", "vid": "2c7c", "pid": "0125", "at_interface": 2}` |
| 大疆一代 `2ca3:4006` | **原生支持**：`vocat doctor --repair-dji-qmi` 把接口 0–3 绑到 `option`、接口 4 绑到 `qmi_wwan`，断言 DTR，**不写 NV、不改 USB 身份** | 无内置条目，需自行处理 |
| USB 读卡器 | PC/SC（自动装 pcscd + libccid） | PC/SC（且打补丁支持三体 SCR Prime `04d9:c001`） |
| QMI | `qmicli` + `qmi-proxy`，数据面用内置 QMI WDS 客户端 | ModemManager / NetworkManager bearer |
| 虚拟读卡通道 | 内置 `ec20_adapter.go` | vpcd（虚拟 PC/SC 驱动）创建 3 条逻辑通道：PIN 保活 / SWu-EAP-AKA / IMS-Asterisk |
| 部署形态 | 二进制 / Docker（需 `--privileged` + `--network host`）/ OpenWrt init | Docker + systemd |

### 关于你的大疆一代模块

大疆一代 4G 模块（DJI Cellular Dongle / DJI 百旺 QDC507）本质是移远 **EG25-G 公版模组**，只是 USB VID/PID 被写成大疆私有值 `2ca3:4006`。

- **VoCat 路径**：开箱即用，`--repair-dji-qmi` 只做 sysfs 驱动绑定 + DTR 断言，不碰 NV，风险最低。**但 MCC 460 阻断让它对国内卡不可用。**
- **MDD 路径**：有两条，第二条更优。
  - 方案 A（社区常见）：改写模块 USB VID/PID 回移远 `2c7c:0125`。这是**写 NV / 改 USB 身份**的操作，有变砖风险，需要备份与恢复手段。
  - 方案 B（**推荐，无需改硬件**）：MDD 的模块表是配置项，不是硬编码。`host/mdd_orchestrator.py::usb_modems()` 按 `(idVendor, idProduct)` 匹配 `hardware.modem_profiles`，再在 `at_interface` 指定的接口上找 `ttyUSB*`/`ttyACM*`：

    ```python
    profiles = {(str(p.get("vid","")).lower(), str(p.get("pid","")).lower()): p
                for p in hardware.get("modem_profiles") or []}
    ...
    interface = int(profile.get("at_interface", 2))
    ports = sorted(usb_root.glob(f"{node.name}:1.{interface}/ttyUSB*"))
    ```

    所以只要在硬件配置里加一条：

    ```json
    {"name": "DJI Cellular Dongle", "vid": "2ca3", "pid": "4006", "at_interface": 2}
    ```

    并确保 `2ca3:4006` 的接口 0–3 已绑定到 `option` 驱动（这一步和 VoCat 的做法一致，纯 sysfs 操作，不写 NV），MDD 就能认这块模块。

    > `at_interface: 2` 与 VoCat 的 `djiATIndex = 2` 一致，说明两边的接口布局假设是相同的。
    > **此方案基于源码分析，未经实机验证**，建议先在备用机上测。

---

## 5. 成熟度与生态

| | VoCat | MDD Sim Gateway |
|---|---|---|
| 代码规模 | 769 文件，Go 主体，`go test ./...` | 285 文件，71 个测试文件 |
| CI | GitHub Actions 出 5 架构二进制 + 多架构 Docker 镜像到 GHCR | CI 构建镜像，安装脚本按架构下载并校验 SHA-256 |
| 文档 | README 8 语言 + `docs/`（含 Carrier IPCC 导入） | README 中英 + `docs/`（架构、安装、开发、故障排查、发布清单） |
| 第三方许可 | `NOTICE` + `LICENSES/`（quectel-qmi-go MIT、go-plist BSD-2） | `THIRD_PARTY_LICENSES.md` 完整清单 + `NOTICE`，上游 pagecat/vowifi_gateway MIT 通知完整保留 |
| 合规态度 | 以**技术手段排除**特定地域与 MCC | 以**用户承诺 + 使用边界声明**约束，不设技术阻断 |

---

## 6. 对你这个具体场景的建议

你的约束：**中国大陆 + 国内 SIM（MCC 460） + 大疆一代 EG25-G + 想 fork 到自己的 GitHub + 静态部分上 Cloudflare/Vercel**。

| 诉求 | 选择 |
|---|---|
| 能不能用 VoCat | **不能**。地域 + MCC 460 双重阻断，且许可禁止绕过 |
| 能不能 fork VoCat | **不建议**。fork 本身被许可允许，但你在国内运行即违约，且不得移除阻断机制 |
| VoCat 还有什么价值 | **作为架构参考**。Go 原生 IMS/IKE 实现、单二进制交付、OpenWrt 支持、DJI QMI 修复思路，都值得读 |
| 分支基座 | **MDD Sim Gateway**（GPL-3.0，无地域限制） |
| 前端 | 你已选定的方向：重写 WebUI，静态产物上 Cloudflare Pages/Vercel，网关用 cloudflared Tunnel 接入 |
| 大疆模块接入 | 优先走"加配置条目 + sysfs 绑驱动"，避免写 NV 改 USB 身份 |
| 若非要 VoCat 的轻量架构 | 可以用 Go 重写一个**你自己的**网关（借鉴 VoCat 的架构思路，但不使用其代码），这样不落入它的许可约束 |

---

## 7. 附：本次调研的证据位置

源码与文档已留存于 `mdd-research/`：

```
mdd-research/
├── mdd_src/                    MDD 完整源码（main 分支）
│   ├── control/app/config.py            模块 VID/PID 表
│   ├── host/mdd_orchestrator.py         usb_modems() 匹配逻辑
│   └── THIRD_PARTY_LICENSES.md          第三方许可清单
├── vocat_src/                  VoCat 完整源码（master，来自 EchoHS fork）
│   ├── LICENSE                          Research & Evaluation License 全文
│   ├── internal/device/region.go        BlockedMCCs = 460/461
│   ├── internal/server/call_api.go      语音信令 501
│   └── cmd/vocat/doctor_dji_linux.go    2ca3:4006 修复实现
├── vocat/                      VoCat 关键文档单文件副本
└── README_upstream.md / up_ARCHITECTURE.md / up_INSTALL.md
```

---

*本报告基于 2026-09-22 的仓库快照。两个项目都在活跃开发中，结论可能随上游变更而失效。*
