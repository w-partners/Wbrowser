<div align="center">

# 🤖 Wbrowser

**不是给 AI 造一个浏览器，而是在你自己的 Chrome 里给它一个座位。**

这不是 AI 浏览器。这就是你机器上的 Chrome，**由你亲手登录一次**，
助手可以在**你看得见、也能一起用的窗口里**操作。

无需 API 密钥。无需配置集成。登录一次之后就一直保持。关掉窗口就结束了。

🔵 把安装说清楚：Chrome 136+ 不允许对默认配置文件做远程调试，
所以本工具会启动一个**专用配置文件，你在那里登录一次**。之后会话就一直有效 ——
在我们实测的一个配置文件上，一次 Google 登录同时带上了 YouTube 和两个使用
「用 Google 登录」的内部系统。**不是零配置，而是配置一次。**

可在 **Windows、macOS、Linux 和 WSL** 上运行 —— 每一项都在真实硬件上实测，
由**另一台机器上的另一个人**验证，而不是写这部分代码的人：

| 环境 | Chrome | 验证者 |
|---|---|---|
| Windows 10 | 151 | 另一台机器·另一个人 · 含端到端 |
| macOS 15 | 151 | 另一台机器·另一个人 |
| Linux（无显示器） | 148 | 另一台机器·另一个人 · 含安全审查 |
| WSL2 | 151 | 维护者（自行验证） |

<sub>2026-08-24 实测。并非每一项都在每个环境下测过 —— 详见下文平台说明。
WSL2 是维护者自己的环境，属于自行验证，而非独立验证。</sub>

[English](../README.md) · [한국어](README.ko.md) · [中文](README.zh.md) · [Español](README.es.md)

[![check](https://github.com/w-partners/Wbrowser/actions/workflows/check.yml/badge.svg)](https://github.com/w-partners/Wbrowser/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![Platforms](https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-independently%20verified-success)


</div>

---

## 为什么要做这个

AI 浏览器的形态都一样：你要**安装一个全新的浏览器**，助手装在里面 ——
**Aside**、**Comet**、**Dia**。这种形态要付出三样东西：

| 他们的形态 | 代价 |
|---|---|
| 要装一个新浏览器 | 新的配置文件、新的登录、新的默认设置 |
| 助手住在里面 | 你的会话放在**别人的构建**里 |
| 平台由他们决定 | Aside 和 Dia 目前仅支持 macOS |

**我们采取了相反的安排。** 没有要装的浏览器，也没有要迁移的东西 ——
它驱动的就是你机器上已有的 Chrome，在**一个你能看着、也能一起用的窗口**里。
你看着每一次点击落在哪里，而这些点击发生在**它自己打开的标签页**里。
没有什么要迁移，也没有什么要交出去。

🔵 为避免误解，说清楚它做什么、不做什么：助手**不会占用你正在看的标签页，也不会把窗口拉到最前**，
所以你可以在旁边继续工作。但它**不会因为你动鼠标就暂停** —— 不是你打断了它而它让位，
而是你们本来就没有共用同一个标签页。想让它处理你正在看的页面时，
用 `./wb take <编号>` **由你亲手交给它。**

正因为这个选择，它能在 Windows、macOS、Linux 和 WSL 上运行——
**我们没有造浏览器，所以也没有平台需要挑选。**

> **需要什么，就自己做。**
>
> 就这么简单。不是等着别人排期的产品，而是一个属于你自己的小工具——
> 跑在你本来就在用的电脑上，操控你亲手登录过的浏览器。
> JavaScript、Python 和 Shell 加起来约 2,600 行——一个下午就能读完。
> 读它、改它、把它变成你的。

Wbrowser 支持 **Windows、macOS、Linux 和 WSL**。
macOS、原生 Linux、WSL2 和 Windows 原生四个环境均已真机验证。
但并非每项检查都在每个环境上运行过（见下表）。

*"你用什么系统？"* 不该成为你无法自动化自己浏览器的理由。

---

## 这是什么？

大多数自动化工具给 AI 的是一个**全新的空白浏览器**。所以它看不到你的邮箱、
后台面板，任何需要登录的东西都进不去——除非你交出密码，或者为每个网站单独配置 API。

Wbrowser 反过来做：**你亲手登录一次**，之后终端（或 AI 助手）就能直接操控那个窗口，
处处都是已登录状态。

```bash
./wb go https://mail.example.com   # 用你已登录的会话打开
./wb read                          # 告诉你屏幕上有什么
./wb click '#compose'              # 点击它
```

**Wbrowser 永远看不到你的密码。** 你输入——输入到 Chrome，或者输入一次到引擎读取的
本地加密保险库（`wb login`，可选启用；AES-256-GCM，scrypt 派生密钥，仅本人可读 0600）。
无论哪种方式，AI 都不会拿到密码；Wbrowser 只是操控那个已经打开的窗口。

---

### 不是复制数据 —— 就是你的账号本身

这一点值得说清楚，因为它正是本项目与同类工具的分界。

Wbrowser **不保存你的数据副本**。配置文件夹里只有 cookie，也就是"你已登录"的凭证，
除此之外什么都没有。邮件、文件、仪表盘全都留在服务商的服务器上，和你的手机一样。
代理看到它们的方式也一样：出示那份凭证，然后向服务器请求。

```
Google 服务器            你的账号与数据
    |
    +-- 笔记本的 Chrome    一个会话
    +-- 手机              一个会话
    +-- Wbrowser          一个会话   <- 你登录时创建的
```

由此得出两个结论，两个都要记住：

- 🔵 **没有过期副本、无需同步、也没有第二处需要防护的地方。** 在 Google 那边退出登录，
  所有会话（包括这个）都会结束。不会有东西留在文件夹里等着被偷。
- 🔴 **这是活的账号，不是沙箱。** 代理打开邮件时，那就是你的邮件。
  权限范围与你本人完全一致 —— 不多，也不少。

> ⚠️ 复制配置文件夹本来就行不通。我们试过：685 个 cookie 变成了 3 个。
> Chrome 会让它不认识的配置文件失效。手动登录不是绕过这个限制的办法，
> 而是**唯一成立的做法**。

### 一次登录，打开许多站点

这是让整套配置值得的部分。在那个窗口里**登录一次 Google**，然后：

```
Google 自身      google.com · youtube.com · 你的 Workspace 应用
使用 Google SSO   "使用 Google 登录" 能到的一切 ——
                 内部系统、预约系统、后台面板
其他站点         手动登录一次，之后一直保持
```

真实档案实测：**一次 Google 登录**顺带打开了 YouTube 和
**两个从未单独登录过的内部业务系统**（它们使用 Google SSO）。
其余（GitHub、Reddit 等）手动登录一次后一直有效。

也就是说初始成本约为：**一次 Google 登录 + 不使用 Google 的站点各一次**。
之后你的 AI 就能触达全部。

🔴 反过来也是同一件事：**能操控这个浏览器的人，就能在上述所有站点上以你的身份行动。**
请阅读[安全](#安全)一节。

## 快速开始

**macOS · Linux · WSL** —— 一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/w-partners/Wbrowser/main/setup.sh | bash
```

它会检查环境、克隆代码、安装依赖、把 `wb` 加到 PATH，并打开浏览器窗口。
然后你在那个窗口里像平常一样**手动登录**，安装就完成了。

<details>
<summary><b>Windows 原生（PowerShell，不用 WSL）</b></summary>

```powershell
git clone https://github.com/w-partners/Wbrowser.git
cd Wbrowser
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm install
node launch.js          # 在打开的窗口里登录你的网站
node engine.js          # 这个窗口保持运行
node bin\wbrowser.js go https://github.com
```

`wb` 是 bash 脚本，在 Windows 上跑不了，用 `node bin\wbrowser.js` 代替即可，其余完全一致。

🔵 **WSL 更省事**：`wsl --install` 一次，然后在 Ubuntu 里执行上面那条命令。
两种方式最终操作的都是**你的 Windows Chrome**。
</details>

<details>
<summary><b>想手动装（任意平台）</b></summary>

```bash
git clone https://github.com/w-partners/Wbrowser.git
cd Wbrowser
# Wbrowser 使用*系统已安装的* Chrome，无需 Playwright 自带浏览器。
# 跳过下载可节省约 400MB：
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

node launch.js       # 1. 打开一个专用 Chrome 窗口
                     # 2. 在那个窗口里手动登录你的网站
node engine.js       # 3. 启动控制引擎
./wb go https://example.com
```

**只有第 2 步需要人工操作**。
</details>

### 如果安装中断

它不会装到一半就结束，而是**停下来并说明原因**。最常见的两种：

| 提示 | 处理 |
|---|---|
| `several user folders`（WSL） | `ls /mnt/c/Users` 找到你的账号目录，然后<br>`WBROWSER_PROFILE_DIR=/mnt/c/Users/<你>/.wbrowser ./wb up` |
| 找不到 Chrome | `WBROWSER_CHROME=/chrome/路径 ./wb up` |

> **如果 `./wb` 提示 "Permission denied"** —— 克隆时执行权限丢失了。执行一次即可：
> ```bash
> chmod +x wb install.sh autostart.sh sync-session.sh
> ```

> **无显示器的服务器：** 检测到没有 `$DISPLAY` 时会自动以 headless 模式启动 Chrome。
> 可用 `WBROWSER_HEADLESS=1` / `=0` 强制指定。
> 🔵 没有屏幕就无法手动登录——请在桌面机器上 `./sync-session.sh export`，
> 再到服务器 `import`。

---

## 为什么要用单独的 Chrome 窗口？

从 **Chrome 136（2025 年 3 月）** 开始，`--remote-debugging-port` 对 Chrome 默认
配置目录**无效**。因为攻击者曾利用远程调试窃取 Cookie，谷歌做了这项安全变更。

所以现在**必须**使用非默认的 `--user-data-dir`。Wbrowser 会在 `~/.wbrowser`
创建一个并从那里启动 Chrome。

**这意味着你现有的登录状态不会带过来。** 在新窗口里登录一次，之后就会一直保持。

> ⚠️ **复制 Chrome 配置文件夹行不通。** 我们试过：685 个 Cookie 只剩 **3 个**，
> 所有会话 Cookie 全部失效。Chrome 会让它不认识的配置文件失效。
> 直接重新登录吧——一分钟的事，而且确实管用。

---

## 命令

```bash
./wb go <网址>             打开页面并返回结构
./wb read                  概览当前页面
./wb click <选择器>         点击元素
./wb type <选择器> <文本>    填写输入框
./wb press Enter           按键
./wb eval '<js>'           在页面中运行 JavaScript
./wb console [正则]         控制台日志 + 未捕获异常
./wb network               失败的请求（4xx/5xx、CORS、超时）
./wb shot [文件.png]        截图
./wb tabs                  带编号的标签页列表 — 以及每个标签页由谁在操作
./wb take <编号>            把你正在看的标签页交给代理
./wb release               把该标签页收回
./wb close                 只关闭你自己打开的标签页
./wb status                运行状态、当前配置文件
./wb show                  把浏览器窗口调到最前
```

### 不要猜选择器

`./wb read` 会返回页面上**真实存在**的可点击元素：

```
inputs(1):
  - #searchbox_input  (搜索，不被追踪)
buttons(3): 搜索, 登录, 设置
```

直接从这里复制。

> 真实案例：我们曾猜搜索框是 `input[name=q]`，结果失败了——它其实是 `textarea`。
> 而 `read` 从一开始就给出了正确答案。

---

## 从 AI 助手使用（MCP）

Wbrowser 支持 [Model Context Protocol](https://modelcontextprotocol.io)，
任何支持 MCP 的助手都能操控你的浏览器。

**本地（stdio）：**
```json
{
  "mcpServers": {
    "wbrowser": {
      "command": "node",
      "args": ["/安装路径/Wbrowser/mcp-server.js"]
    }
  }
}
```

**远程（HTTP）：**
```bash
export WBROWSER_MCP_TOKEN=$(openssl rand -hex 32)
node mcp-server.js --http --port 7982 --host 127.0.0.1
```

然后直接对助手说：

> *"打开我的后台，总结一下今天的数据。"*
> *"看看那个购物网站的购物车里有什么。"*

> 🔴 **远程服务器没有令牌就拒绝启动。** 这不是可选项——它操控的浏览器装着你所有的
> 登录状态。能访问那个端口的人，就等于是你本人。

---

## 定时任务（cron）

创建 `jobs/morning-check.json`：

```json
{
  "schedule": "0 9 * * 1-5",
  "tab": "morning",
  "steps": [
    { "goto": "https://dashboard.example.com", "wait": 2000 },
    { "eval": "document.querySelector('.total').innerText" },
    { "shot": true }
  ]
}
```

```bash
node cron.js list      查看已注册任务
node cron.js next      每个任务下次运行时间
node cron.js run <名称>  立即运行一次
node cron.js daemon    按计划自动运行
```

`0 9 * * 1-5` 表示**工作日上午 9 点整**。标准五段式 cron：`分 时 日 月 周`。

### 不可逆操作默认被拦截

无人值守的自动化意味着**出问题时没人在看**。所以看起来像提交 / 支付 / 删除的步骤会被**拒绝**：

```
⛔ 第 2 步被拦截 — 看起来不可逆 (click: #submit-payment)
   如果确实需要，请在任务文件中添加 "allowIrreversible": true。
```

这是**逐个任务**授权，不是全局开关。

---

## 谁在操控？（可视提示）

当代理正在操控浏览器时，你能看见：

- **半透明边框**，带标签：`🤖 my-agent 控制中`
- **标签页标题**加前缀：`[my-agent] 仪表盘`

停止操作 6 秒后边框淡出，所以"控制中"确实表示**此刻**。颜色由代理名生成，
多个代理同时接入也能一眼分辨。

标签页前缀**在页面跳转后依然保留**——`MutationObserver` 会在页面重写标题时
立即补回（单页应用会频繁重写标题）。

---

## 中途把标签页交给代理

你已经点进去三层了：筛完列表、填了半张表单、翻进了某个仪表盘。看样子还得再花二十分钟，
而你并不想自己做完。指一下那个标签页，让代理接着做：

```bash
./wb tabs
  #  driven by      title                                url
  1  — (yours)      预订 — 三月                           https://…/bookings?from=03-01
  2  — (yours)      发票 4417                            https://…/invoices/4417
  3  my-agent       [my-agent] GitHub                    https://github.com/…

./wb take 1          # 代理从你停下的地方接手第 1 个标签页
./wb release         # 你再收回来
```

不用重新登录，不用重新点一遍，也不用解释你已经做了什么 —— 代理拿到的就是**你搭好的那个页面状态**。

🔴 **代理绝不会自己拿走标签页。** 它只开自己的标签页、只操作自己的；唯一会碰到你标签页的途径，
就是你按编号交给它。这不是一条规定，而是查找方式本身如此 —— 代理没有办法称呼一个不是它打开的页面。

> 0.2.0 之前并非如此。代理的默认标签页会**接管已经打开的页面**，而那通常正是*你*在看的那个 ——
> 之后它就会在你的标签页里点击、输入，还会改掉标题。检查哪些标签页"看起来没人用"是修不好的：
> 你手动打开的标签页没有任何归属，用任何检查方式看都是空闲的。所以直接取消了接管。

`./wb release` 同时会清掉 `[代理]` 标签，免得标签栏继续显示有人在操作一个已经归还给你的页面。

---

## 多账号

在同一个窗口里打开多个 Chrome 配置文件，Wbrowser 可以分别指定：

```bash
./wb -a work@example.com go https://mail.example.com
./wb windows                    # 列出已打开的配置文件
```

或在 `accounts.json` 中按网站映射：

```json
{
  "sites": {
    "mail.example.com": { "account": "work@example.com" }
  }
}
```

> 🔴 **如果指定的账号没有打开，Wbrowser 会直接失败**，而不是猜一个相近的。
> 用错账号发邮件，比一条错误提示糟糕得多。

---

## 平台支持

| 系统 | Chrome 自动检测 |
|---|---|
| **Windows** | `Program Files`、`AppData`、Edge |
| **macOS** | `/Applications/Google Chrome.app`、Chromium、Edge |
| **Linux** | `google-chrome`、`chromium`、snap、Edge |
| **WSL** | 优先使用 Windows Chrome（你实际在用的浏览器） |

检测失败时用 `WBROWSER_CHROME=/chrome/路径` 指定。

> **已在真实设备上验证**（2026-08-24）：
>
> | 环境 | Chrome | 验证者 | 该环境实际测量的项目 |
> |---|---|---|---|
> | macOS 15 | 151 | 另一位操作者 | 启动·引擎·CLI·状态路径 |
> | Linux（原生·无显示器） | 148 | 另一位操作者 | 以上 + **安全审查** |
> | WSL2 + Windows Chrome | 151 | 维护者 | 以上 |
> | Windows 10（原生） | 151 | 另一位操作者 | 以上 + **端到端实测** |
>
> 🔵 **并非每项检查都在每个平台上运行过。** 安全审查（用 `ss` 确认无令牌时拒绝启动、
> 引擎在回环之外不可达）在 Linux 上完成；端到端（`/health` → `/act` → 真实页面提取）在
> Windows 上完成。UNC 路径（`\\wsl.localhost\...`）同样可用——实测推翻了我们的预期。
>
> 安全审查在另一台 Linux 机器上完成：没有令牌时 MCP HTTP 服务器直接退出，
> **根本不打开套接字**（用 `ss` 确认）；引擎仅绑定 `127.0.0.1`，同网段也无法访问。

---

## 安全

这个工具操控的浏览器装着**你所有的登录状态**，请谨慎对待。

- 🔴 **`127.0.0.1` 不是围墙——它意味着"以你的身份运行的进程都能进来"。**
  Chrome 调试端口（9222）**没有任何认证**。该机器上任何本地进程——其他应用、
  npm 安装钩子、随手运行的脚本——都能连上并操作你已登录的全部会话。
  实测：一个无关进程无需凭据即可通过 `GET http://127.0.0.1:9222/json/list` 列出所有标签页。
  **只有当你信任这台机器上以你身份运行的一切时**才使用本工具。
- 引擎**只绑定 `127.0.0.1`**。切勿直接暴露到公网。
- 🔴 `mcp-server.js --host 0.0.0.0` 选项存在，且**会绑定到所有网络接口**。
  代码会打印警告，但那时端口已经打开。除非在受信任的专用网络（VPN/tailnet），
  否则请使用 `127.0.0.1`，且无论如何都必须带令牌。
- MCP HTTP 服务器**必须有令牌**，否则拒绝启动。
- `./wb type` **不记录**输入内容——那可能是密码。
- Cookie 的值**永远不会**被打印、记录或返回。
- 🔴 **不要用它输入密码、卡号或身份证号。**
  请手动登录，Wbrowser 会复用该会话。

### 会话备份

```bash
./sync-session.sh export   Cookie → 加密存储
./sync-session.sh import   在另一台机器上恢复
./sync-session.sh status   查看备份内容
```

> 🔴 **Cookie 和密码同等敏感**——它本身**就是**登录凭证。
> 目标位置若未真正加密，脚本会**拒绝写入**。

---

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `WBROWSER_CHROME` | 自动检测 | Chrome 可执行文件路径 |
| `WBROWSER_PROFILE_DIR` | `~/.wbrowser` | 配置文件目录 |
| `WBROWSER_PROFILE` | `Default` | 目录内的配置文件名 |
| `WBROWSER_CDP_PORT` | `9222` | Chrome 调试端口 |
| `WBROWSER_PORT` | `7981` | 控制引擎端口 |
| `WBROWSER_AGENT` | 自动 | 边框和标签页显示的名称 |
| `WBROWSER_MCP_TOKEN` | — | 远程 MCP **必需** |
| `WBROWSER_NOTES` | — | 工作日志目录（可选） |

---

## 重启之后

一条命令就够了：

```bash
cd /path/to/Wbrowser && ./wb up
```

它会同时启动 Chrome 和引擎，已经在运行的就不去动它。
之后用 `./wb status` 看登录状态是否还在——配置文件存在磁盘上，通常都还在。

### 让引擎自动启动

```bash
# Linux / WSL（systemd 用户服务）
./install.sh
systemctl --user status wbrowser
```

这只覆盖**引擎**。**浏览器仍需手动打开**——它是桌面进程，而且一登录就悄悄弹出浏览器窗口的工具，
你并不会想用。所以重启之后仍然是 `./wb up`，或者你自己打开 Chrome，让已在运行的引擎接上去。

**macOS 和 Windows** 目前还没有对应的安装脚本：需要时执行 `./wb up` 即可。
（launchd plist 和启动文件夹快捷方式都不难写，但还没有人在真实机器上实测过，
所以没有写进来——本文档不写没有跑过的东西。）

> 🔴 **不要自己做一个在常用配置文件上加 `--remote-debugging-port` 的快捷方式。**
> 从 Chrome 136（2025 年 3 月）起，那里的这个参数会被**忽略**——Chrome 启动了，端口却没开，
> 而且不会告诉你原因。`launch.js` 传的是专用的 `--user-data-dir`，这是目前 Chrome 唯一还认的方式。
> 交给 `./wb up` 就好。

---

## 已知限制

- **不内置自然语言循环。** 选择器由代理决定；`read` 会提供真实的选择器，无需猜测。
- **仅支持 Chrome/Chromium。** Firefox 不支持 CDP。
- **一个 CDP 端口对应一个 Chrome 进程。** 从该窗口内打开的配置文件可见；
  另行启动的 Chrome 不可见。

---

## 保持最新

```bash
./wb version          # 你的版本，以及是否有新发布
```

```
wbrowser 0.4.0
🔵 A newer release is available: v0.5.0 (you have v0.4.0)
```

更新：

```bash
git pull && npm install                                  # clone 的情况
git pull https://github.com/w-partners/Wbrowser main     # fork 的情况
```

🔵 **fork 不会自动跟随本仓库** —— GitHub 不会把我们的提交推送到你的副本。
上面第二条命令就是你想要时把它们拉过来的方式。

🔴 如果连不上 GitHub，它会**明说连不上**，绝不会把「没问成」说成「已是最新」。
想完全跳过网络检查：`WBROWSER_NO_UPDATE_CHECK=1` —— 两种情况下都不会阻塞命令。

不想运行任何命令也能收到消息：在[仓库页面](https://github.com/w-partners/Wbrowser)
选择 **Watch → Releases only**。

---

## 参与贡献 · 安全

- [CONTRIBUTING.md](../CONTRIBUTING.md) — 塑造这份代码的规则，以及如何测试
- [SECURITY.md](../SECURITY.md) — 🔴 威胁模型。在共享机器上运行前请务必阅读：
  Chrome 调试端口**没有认证**，任何以你身份运行的本地进程都能操作你的会话。

发现安全问题请通过
[私密 advisory](https://github.com/w-partners/Wbrowser/security/advisories/new) 报告，不要开公开 issue。

## 许可证

MIT — 参见 [LICENSE](../LICENSE)。
