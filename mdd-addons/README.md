# mdd-addons —— 功能补齐

这个目录装的是**往 MDD Sim Gateway 上补的功能**，用来把它缺的那几项补齐。

分两部分看：

- **MDD 本体**（Python 控制面 + 宿主脚本）—— 这个目录里的东西，按下面的路径并进你的 fork。
- **控制台**（`../mdd-webui/`）—— 已经做完，九个页面全部可用。

两边的边界很清楚：**内核/宿主层的东西在这里，界面在 mdd-webui。**

---

> **要动手装？直接看 [安装说明](安装说明.md)** —— 六个功能的步骤、所有上游补丁、
> 验证方法和回滚都在那一份里。本文讲的是「每个功能解决什么问题、以及设计取舍」。

## 怎么并进你自己的 fork

这些文件是按 MDD 的目录结构放的，直接拷进去就行：

```bash
git clone https://github.com/MddIdd/mdd-sim-gateway.git my-gateway
cd my-gateway
cp -r /path/to/mdd-addons/tools/* tools/
```

然后 `git add` 提交。没有需要改的既有文件 —— 每一件都是新增的独立文件，
不改上游任何代码，这样以后合并上游更新不会冲突。

---

## 进度

| # | 功能 | 状态 | 文件 |
|---|---|---|---|
| 1 | **大疆模块驱动修复** | ✅ 完成 | `tools/mdd-modem-driver-repair.py` |
| 2 | **交互式 AT / USSD 终端** | ✅ 完成 | `control/app/at_terminal.py` + `mdd-webui/src/views/Terminal.tsx` |
| 3 | **Bark / 邮件通知渠道** | ✅ 完成 | `control/app/notify_channels.py` |
| 4 | **Telegram 双向 Bot** | ✅ 完成 | `control/app/telegram_bot.py` |
| 5 | **多 eUICC 清单** | ✅ 完成 | `control/app/esim_inventory.py` |
| 6 | 多语言文档 | ❌ 不需要（用户只用中文） | — |

---

## 1. 大疆模块驱动修复 ✅

### 它解决什么

MDD 通过 `hardware.modem_profiles` 里的 `(VID, PID)` 认模块，再去 `at_interface`
指定的接口上找 tty。**这个配置项是必要条件，但不充分** —— 模块还必须绑对内核驱动。

大疆一代模块（`2ca3:4006`，本质是 Quectel EG25-G）的 USB 布局是五个接口：

```
接口 0,1,2,3  ->  option      （串口；接口 2 是 AT 口）
接口 4        ->  qmi_wwan    （QMI 数据）
```

两件事会出错，**第二件才是真正麻烦的那个**：

1. 没有任何驱动认领这些厂商自定义接口 → 根本没有 tty，MDD 完全没法跟模块说话。

2. **`qmi_wwan` 的 USB 动态 ID 是「整设备级」的，不是「单接口级」的。**
   一旦你注册了 `2ca3 4006` 去让接口 4 被认领，这个驱动**会顺带探测同一设备上所有
   其它厂商自定义接口**。在这个布局下，接口 1–3 会被变成假的 `cdc-wdm` 设备，
   **接口 2 上的 AT 口就此失效** —— 而 `lsusb` 看起来完全正常，tty 甚至可能还在。

   所以动态 ID 必须在接口 4 绑好之后**再摘掉**，并且任何错误的 QMI 认领都必须在
   `option` 开始探测**之前**解除。

另外还有一个 DTR 步骤：QDC507 会在 QMI 固件就绪**之前**就确认
`SET_CONTROL_LINE_STATE` 控制传输，所以要把线路状态翻转一次然后等一秒。
这是真实需求，不是仪式 —— 但可以用 `--no-dtr` 跳过，方便你确认它在你的模块上到底有没有用。

### 它不做什么

**不写 NV、不改 USB VID/PID、不刷任何东西。** 每一个操作不是 sysfs 写就是 USB 控制传输，
拔插一下就全部还原。

网上常见的建议是把模块的 USB 身份改写成移远的 `2c7c:0125` —— 那是**永久写 NV**，
有真实的变砖风险，而且**完全没必要**：MDD 的模块表是配置项，不是硬编码。

### 用法

```bash
# 预览（默认，不做任何改动）
sudo python3 tools/mdd-modem-driver-repair.py

# 应用
sudo python3 tools/mdd-modem-driver-repair.py --apply

# 别的 Quectel 模块，或不同的接口布局
sudo python3 tools/mdd-modem-driver-repair.py --vid 2c7c --pid 0125 \
    --serial-interfaces 0-3 --at-interface 2 --qmi-interface 4

# 跳过 DTR（用来判断它在你的模块上是否必要）
sudo python3 tools/mdd-modem-driver-repair.py --apply --no-dtr

# 不接硬件，只验证 ioctl 编码
python3 tools/mdd-modem-driver-repair.py --self-test
```

跑完它还会打印出该填进 **设置 → 硬件** 的 `hardware.modem_profiles` 条目 ——
驱动布局和这条配置是同一件事的两半，缺一不可。

> **改动不是永久的**：拔插模块后要重新跑一次。如果想让它在开机时自动跑，
> 把它挂到 systemd 或 udev 规则上（还没做，见下面的「下一步」）。

### 测试

```bash
python3 tools/test-modem-repair.py
```

19 项断言，不需要硬件。跑的是真实的诊断与修复代码，只把两个**纯 sysfs 读取**函数
换成合成实现（`driver` 符号链接需要管理员权限；接口目录名里的 `:` 在 Windows 上非法）。
**写入顺序是真的在测**，因为顺序就是这个功能的全部意义。

`--self-test` 另外单独验证 ioctl 的编码 —— 结构体里那个 4 字节填充如果算错，
内核会去解引用一个垃圾指针，而报错会出现在离原因很远的地方。

### 开发过程中修掉的一个真 bug

第一版把接口的驱动名直接和 `"option"` 比。但 `option` 是 **usb-serial** 驱动，
usb-serial 每个实例注册一个目录（`option1`、`option2`…），所以接口的 `driver`
符号链接解析出来是 **`option1`**。

后果是：**一个绑得好好的模块会被判成「未绑定」**，脚本每次跑都会去「修」一个健康的设备，
然后把自己的验证结果报成 FAIL。

修法是加一层 `driver_family()` 归一化，把 `option<N>` 收敛成 `option`。
只归一化 `option` 家族 —— 无差别地去掉结尾数字会把真正不同的驱动混为一谈。

---

## 2. 交互式 AT / USSD 终端 ✅

### 它解决什么

模块不听话的时候，最快的办法是直接问它。MDD 没有任何办法做到这一点 ——
信号质量、注册状态、PDP 上下文、USSD 服务代码，以及所有结构化面板没暴露的东西，全是盲区。

### 走 ModemManager，不抢串口

这是整个设计的核心取舍。`mms_transport.SerialAtChannel` 已经存在而且快得多
（它独占一个网关自己的串口），但**「独占串口」正是这里绝不能做的事**：
引擎此刻可能正握着 AT 口，而一个「为了回答一个问题就把线路搞停」的调试工具，
比没有工具更糟。

`ModemCommand` 走 ModemManager 的 `Modem.Command` 方法，**共享**模块，因此
**线路运行中也能用** —— 而这恰恰是最需要它的时候。代价是每条命令约一秒，手动敲命令的人不会察觉。

### 三档命令策略（`AtCommandPolicy`）

按**「损坏要花多大代价才能撤销」**分档，不是按命令看起来吓不吓人：

| 档位 | 内容 | 行为 |
|---|---|---|
| **已阻止** | IMEI/NV 写入（`AT+EGMR`、`AT+QPRTPARA`）、原始 SIM APDU（`AT+CSIM`、`AT+CRSM`）、改波特率（`AT+IPR`）、固件下载模式、SIM 锁 | 直接拒绝，**没有绕过开关** |
| **需要确认** | 射频开关（`AT+CFUN=`）、复位（`AT&F`）、PIN 输入（`AT+CPIN=`）、PDP 上下文写入、选网、发短信 | 确认框里写明后果后才执行 |
| **允许** | 只读查询（`?` 结尾）、裸信息命令（`ATI`/`AT+CGMI`/`AT+CSQ`）、USSD | 直接执行 |

几个判定细节值得说明：

- **查询永远允许**，因为它不可能改变状态。
- **「没有等号」不等于「只读」** —— `ATD` 是拨号、`ATA` 是接听、`ATH` 是挂断，
  都是裸命令，其中一个还花钱。所以裸信息命令是**显式白名单**，白名单外的一律按「动作」处理，需要确认。
- **「已阻止」就是已阻止**，查询形式也拒（`AT+IPR?`）。带例外的规则每次加新规则都得重新审一遍，
  而丢掉的只是一个没人会想念的诊断。
- **确认在服务端强制**。UI 的对话框只是便利 —— 一个跳过对话框的客户端依然拿不到那条命令。
- **只读模式**（`MDD_AT_TERMINAL_ACTIONS=0`）下只放行查询和 USSD。
  「需要确认」不等于「允许」，否则只读主机确认一下就能改射频。

### 安装

新增两个文件，**`main.py` 只需加两行**：

```python
from . import at_terminal_api                    # 放在其它模块 import 旁边
...
app.include_router(at_terminal_api.router)       # 放在 app 创建之后
```

前端那半已经在 `../mdd-webui/` 里做好了（`src/views/Terminal.tsx`，导航第 4 项「AT 终端」）。

### 测试

```bash
python3 control/app/test-at-terminal.py     # 70 项断言，不需要硬件
```

覆盖：九条破坏性命令全部被拒、十条需要确认、查询放行、裸命令的两种命运、
只读模式真的只读、大小写不能绕过黑名单、以及 `probe()` 在拒绝时**根本没有碰过模块**
（这是最关键的一条 —— 策略说不行，命令就不能发出去）。

策略与执行逻辑和路由分开（`at_terminal.py` / `at_terminal_api.py`），
所以策略可以在没有 FastAPI、没有模块的情况下测试。

### 开发中修掉的两个真问题

1. **`ATD<号码>;` 被判为非法输入**。命令形式正则没允许 `;`，而 `;` 是语音拨号的结束符
   （`ATD>1` 的 `>` 同理）。这不是安全问题 —— 命令是作为普通字符串交给 D-Bus 方法的，
   全链路没有 shell —— 但会让合法的拨号命令发不出去。
2. **只读模式下 `AT+CFUN=0` 居然是「允许（待确认）」**。因为确认列表在只读判定之前。
   语义上「需要确认」不等于「允许」，顺序错了就等于只读主机确认一下就能关射频。

---

## 3. Bark / 邮件通知渠道 ✅

### Bark

国内 iOS 上最省事的推送方式：不用建 bot、不用拉群、不用关联账号，一个设备 Key 加一个
HTTPS 请求就够了。

**关键设计：服务器地址可配。** Bark 自建很常见，而自建服务器常常是明文 HTTP ——
设备 Key 会跟着请求一起明文发出去。所以两种都允许（自建是正常需求，不是错误），
但页面上直说了这件事的代价。

用 JSON 推送接口（`POST {server}/push`）而不是 `/key/title/body` 路径形式：
标题和正文是任意中文，路径段需要百分号编码，而且可读 URL 形式有长度上限，
模板很容易超。

**Bark 和 PushPlus 一样，HTTP 200 不代表投递成功** —— 它用自己响应体里的 `code` 表示结果，
所以只检查状态码会把「被拒绝的推送」报成「已送达」。

### 邮件

用标准库 `smtplib`，**不引入任何新依赖**。

三种传输方式都保留，因为三种都还在用：465 隐式 TLS、587 STARTTLS、25 明文。
**端口跟随传输方式**，除非显式指定 —— 这是唯一不会让人意外的默认值。

用 `EmailMessage` 而不是手拼 MIME：手工拼的 `Subject:` 头里塞非 ASCII 是经典的乱码来源，
而且只在部分客户端上才看得出来。

### 安装

新增一个文件，**`notify_push.py` 两处、`main.py` 一处**（完整补丁见
`control/app/notify_channels.py` 末尾的 `INSTALL_NOTES`）：

```python
# notify_push.dispatch()：把新渠道并入投递列表
from . import notify_channels
for key, sender in notify_channels.CHANNELS.items():
    extra = settings.get(key) or {}
    if extra.get("enabled") and _events_enabled(extra).get(event):
        deliveries.append((key, sender, extra))

# notify_push.has_enabled_channel()：把新键算进「有没有可用渠道」
for key in ("webhook", "telegram", "pushplus", *notify_channels.SETTINGS_KEYS))

# main.py：保存时校验 + 两个测试端点
```

设计上刻意让 `notify_push` **不需要知道 Bark 和邮件是什么** —— 它只迭代一个注册表。
加第三个渠道时改动量是一样的。

### 测试

```bash
python3 control/app/test-notify-channels.py    # 59 项断言，不需要真实服务
```

覆盖：HTTP 200 但应用层报错必须判为失败、**凭据不会出现在错误信息里**（Bark 的 Key 在
请求体里、SMTP 密码在登录调用里，异常若回显就会进投递日志，而日志只该存元数据）、
端口跟随传输方式、中文主题正确编码、三种传输方式各自连对、只对启用的渠道做校验
（关着的半成品配置是草稿，不是错误）。

### 前端

通知页从四个渠道扩到六个，复用同一套事件开关与模板机制。
顺手把测试发送的分发改成了查表 —— 原来是一串嵌套三元，**任何未列出的渠道都会
静默落到飞书**，加渠道就会得到一个「报错渠道名不对」的测试。

---

## 4. Telegram 双向 Bot ✅

MDD 原本**刻意只推不收**（`notify_push.send_telegram` 是单向的）。这个模块补上「听」的那一半，
所以**安全边界才是工作量，命令本身不是**。

### 四条承重设计

**1. 空名单 = 谁都不许，不是谁都行。** `allowed_chat_ids` 是 bot token 和「任何找到这个 bot 的人」
之间唯一的东西。所以 `authorize()` 对空集合返回 False，而且**名单为空时监听器根本不启动**。
把它理解反了 —— 把「还没配置」当成「不限制」—— 是这个模块能有的最严重的 bug，
也是测试第一条要查的。

**2. 未授权的会话得到的是沉默，不是「未授权」。** 回复等于确认 bot 活着，并邀请对方试探。
拒绝只记在服务端日志里。

**3. 花钱或会打断线路的操作需要一次性确认。** 发短信会计费、切 eSIM 会断线、改射频也会。
确认框里写的是**具体后果**，因为「确定吗？」这种没有理由的确认只会训练人闭眼点。
令牌一次性、会过期、**绑定到发起它的会话** —— 泄到群里的令牌别人用不了。

**4. 长轮询，不用 webhook。** 网关通常在 NAT 或 Cloudflare Tunnel 后面，没有入站 URL 可以给
Telegram。长轮询只需要出站 HTTPS，而通知渠道本来就需要。

另外：**bot token 永远不会出现在错误信息里**。它在请求 URL 里，所以 `requests` 的默认异常文本
会把它带进日志 —— 这里统一换成一句不带 URL 的 `RuntimeError`。

### 命令

| 命令 | 需要确认 | 说明 |
|---|---|---|
| `/help` `/status` `/lines` `/esim <线路>` | — | 只读 |
| `/sms <线路> <号码> <内容>` | ✅ | 会真的发短信并计费 |
| `/balance <线路>` | ✅ | 查询会向运营商发短信 |
| `/switch <线路> <ICCID>` | ✅ | 会断线 |
| `/wfc <线路> on\|off` | ✅ | 会改射频状态 |
| `/confirm <令牌>` `/cancel` | — | 确认 / 取消 |

还有一个**同一会话内 30 秒的执行冷却**：确认解决的是「手滑」，冷却解决的是「连点」。

### 测试

```bash
python3 control/app/test-telegram-bot.py    # 52 项断言，不需要网络也不需要 token
```

重点是「它拒绝做什么」：空名单不放行任何人、未授权会话连回复都没有、
破坏性命令第一条消息**不执行**（断言动作回调一次都没被调用）、令牌不能重放、
不能跨会话使用、会过期、被取消后失效、参数不全直接拒绝、冷却会生效也会过期、
以及 **token 不会出现在错误信息里**（故意让假异常带上 token，断言最终消息里没有它）。

还断言了**这个模块不 import 任何控制面模块** —— 所以它能脱离控制面测试，
更重要的是：它能触达的东西是一张写下来的清单，而不是「能 import 到的一切」。

---

## 5. 多 eUICC 清单 ✅

MDD 一次管一张卡（`/api/esim/chip` 读一个读卡器）。有几张 eUICC 时（板载的、可插拔的、
一张双 SE 卡会呈现两个安全元件），没有任何地方能回答「我有哪些 eUICC、哪条线路用哪张」。

### 三件必须小心的事

**1. 读卡是排他的、串行的，所以是可选动作。** lpac 在所有读卡器之间是单线程的，
而一次读卡会把读卡器从引擎手里拿走。每次打开页面都读一遍所有卡，等于为了回答一个没人问的
问题去打断正在跑的线路。所以**默认走缓存**，`refresh` 是一次明确的动作 ——
和 eSIM 页本来就有的「读卡 / 读缓存」是同一个取舍。

**2. 缓存以 EID 为键，卡被取走后记录还在。** 一个只在缓存里的 eUICC 不代表它还在。
所以 `present` 是**三态**：`true` = 刚刚被读卡器报告，`null` = 只在缓存里，
**不说它在，也不说它不在**。把它报成 `false` 是在声称网关并不掌握的知识。

**3. 「这个读卡器里没有 eUICC」不是错误。** 读卡器里插一张普通 USIM 是常态，
读失败才是异常。混为一谈会让任何插了普通 SIM 的主机满屏报错。

### 交付

- `control/app/esim_inventory.py` —— 组装逻辑（纯函数，读卡器行为注入，无 I/O）
- `control/app/esim_inventory_api.py` —— HTTP 路由（含安装说明）
- `control/app/test-esim-inventory.py` —— **35 项断言**
- 前端：eSIM 页底部新增「eUICC 清单」面板（`src/views/EsimInventory.tsx`）
- `verify-esim.mjs` 从 14 项扩到 **22 项**

`unseen` 字段报告「刷新后有多少张缓存卡没被任何读卡器报告」—— 这是唯一能发现
「卡被拔了但缓存还留着」的信号。

### 6. 多语言文档 ⏳

纯工作量，无技术风险。目前界面是中/英两种。

---

## 下一步

建议顺序：**2（AT 终端）→ 3（通知渠道）→ 4（Telegram Bot）**。

第 2 项最值得先做：它是排障能力的缺口，而且前端那半我在 `mdd-webui` 里有现成的模式。
第 4 项工作量最大，因为安全边界要从零设计。

## 目录

```
mdd-addons/
├── README.md                          # 本文件
├── control/app/
│   ├── at_terminal.py                 # AT/USSD 终端：命令策略与执行（纯逻辑，无框架依赖）
│   ├── at_terminal_api.py             # 它的 HTTP 路由（唯一需要 FastAPI 的部分）
│   ├── test-at-terminal.py            # 行为测试（70 项，无需硬件）
│   ├── notify_channels.py             # Bark + 邮件两个通知渠道（含安装补丁）
│   ├── test-notify-channels.py        # 行为测试（59 项，无需真实服务）
│   ├── telegram_bot.py                # Telegram 双向 Bot（含安装补丁）
│   ├── test-telegram-bot.py           # 行为测试（52 项，无需网络）
│   ├── esim_inventory.py              # 多 eUICC 清单（纯函数）
│   ├── esim_inventory_api.py          # 它的 HTTP 路由
│   └── test-esim-inventory.py         # 行为测试（35 项）
└── tools/
    ├── mdd-modem-driver-repair.py     # 大疆/Quectel 模块驱动修复
    └── test-modem-repair.py           # 它的行为测试（19 项，无需硬件）
```

前端（终端页）在 `../mdd-webui/`：`src/views/Terminal.tsx`，验证脚本
`../mdd-webui/scripts/verify-terminal.mjs`（20 项）。
