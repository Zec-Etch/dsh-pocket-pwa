<p align="center">
  <img src="docs/banner.jpg" alt="DSH Pocket" width="100%">
</p>

<h1 align="center">DSH Pocket</h1>

<p align="center"><a href="README.en.md">English</a> | <a href="README.md">中文</a></p>

<p align="center"><a href="https://trendshift.io/repositories/166736?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-166736" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/166736/daily?language=JavaScript" alt="shaobeichen%2Fdsh-pocket | Trendshift" width="250" height="55"/></a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="npm" src="https://img.shields.io/npm/v/dsh-pocket?color=4d6bfe&label=npm"></a>
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="downloads" src="https://img.shields.io/npm/dm/dsh-pocket?color=4d6bfe"></a>
  <a href="https://github.com/shaobeichen/dsh-pocket/actions"><img alt="CI" src="https://github.com/shaobeichen/dsh-pocket/actions/workflows/release.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-GPL--2.0-red.svg"></a>
  <a href="https://github.com/shaobeichen/dsh-pocket/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/shaobeichen/dsh-pocket"></a>
  <a href="https://awesome-dsh-plugin.com/zh/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

> 把 **DeepSeek Harness 装进你的口袋**：一个包、一个设置页，手机扫二维码就实时看到电脑上的同一个界面——人在外面也能用。

<p align="center">
  ⭐ 顺手留颗 Star，作者能高兴一整天 &nbsp;·&nbsp; <a href="https://github.com/shaobeichen/dsh-pocket">行，给你一颗 Star</a>
</p>

## 这是什么

**你不在电脑前，也想用电脑上的 DeepSeek Harness。**

- 下班路上，agent 在电脑上跑任务，你想掏出手机看看它干到哪了、结果如何
- 出门在外，突然想让电脑上的 agent 查点资料、写段代码，但没有远程桌面、没有 SSH
- 电脑在宿舍/办公室，你人在外面，想随时"操控你的 DeepSeek Harness"——发任务、看输出、点审批

DSH Pocket 就是干这个的：**装上它，手机扫个码，就能实时看到并操控电脑上的 DeepSeek Harness 界面**——人在外面也能用。

实际效果——手机上的界面就是电脑上的界面，实时同步：

<p align="center">
  <img src="docs/interface.jpg" alt="手机上的 DSH 界面" width="100%">
</p>

本插件在所有屏幕上保持宿主原版 WebUI：不添加侧边栏按钮、不改抽屉布局或样式、不拦截文件点击。通行密钥注册入口位于插件的「手机访问」设置页。

## ✨ 特性

| 特性                    | 说明                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📶 局域网扫码           | 装好即用：设置 → 手机访问，打开就有局域网二维码，手机连同一 WiFi 扫码即开（自动识别本机局域网 IP，**WSL 环境自动取 Windows 物理网卡 IP**）                                         |
| 🚪 局域网开关           | 设置页可**一键关闭/开启局域网访问**（切换时弹窗提醒）：关闭后局域网二维码/链接立即失效，仅公网可用                                                                                 |
| 🌐 公网扫码（人在外面） | 点「开启公网访问」→ cloudflared 隧道 → 出公网二维码，4G/任何网络都能访问                                                                                                           |
| 🏷️ 公网固定域名         | 可选「**命名隧道**」模式：填 Cloudflare Tunnel Token + 自己的域名，公网地址**固定不变**（重启不再变；见下方说明）                                                                  |
| 🛰️ 自有 VPS 隧道        | 第三种公网入口「**SSH 反向隧道**」：用你自己的服务器 + 域名（能 SSH 登录的普通账号即可），插件只建隧道、**不改你的服务器配置**；地址固定、不经过 Cloudflare，国内网络更稳（见 [SSH 内网穿透教程](docs/SSH-PENETRATION.md)） |
| 📲 安装到主屏（PWA）    | HTTPS 域名下可把页面「**添加到主屏幕**」，像 App 一样全屏打开（非 HTTPS / 纯 IP 装不了）                                                                                            |
| 🔔 任务完成通知         | 电脑上的 agent 跑完任务就推到你手机：**Web Push**（需 HTTPS + 已添加到主屏）或 **Webhook**（企业微信 / 钉钉 / 飞书 / ntfy / Bark / 通用 JSON）兜底                                      |
| 🆔 通行密钥免密登录     | 手机先用访问密码登录一次 → 在该设备注册**通行密钥**（指纹 / 面容）→ 之后免密码进入；设备可在设置页**重命名 / 撤销**，撤销立即失效                                                    |
| 🔐 访问密码             | 公网链接默认使用 **8 位随机密码**（每次开启公网自动换新；**可自定义固定密码**——自定义后不再换新）；局域网有独立的默认 **8 位随机密码**（默认开启，设置页可**一键关闭**——关闭后局域网扫码直连） |
| 🔑 自定义密码           | 公网/局域网密码都可在设置页**设成自己固定的 8–64 位密码（英文字母大小写或数字）**（自定义后公网不再自动换新）                                                                         |
| 🧘 会话保持             | 手机输一次密码后**长期免输**（登录状态绑定电脑上的 dsh web 进程：只要它不重启，手机不用再输；**dsh web 重启/更新后需重新输入一次**）                                               |
| ⚡ 实时同步             | 流式输出走 WebSocket 全透传——**电脑上在输出，手机上同步在滚**，可双向操作；内置心跳保活（防路由器 NAT/省电机制静默断链，断线自动重连）                                             |
| 🗜️ 传输压缩             | 大 JSON 响应自动 gzip/brotli（长会话 17MB → ~1MB，brotli 质量 6：快且省流量），手机加载更快、更省流量                                                                              |
| 🔁 隧道自动恢复         | DSH 重启后自动重新拉起之前开着的公网入口（SSH 通道可用「DSH 重启后自动恢复」开关关掉）                                                                                             |
| 🧩 零依赖安装           | 一个 npm 包、一个设置页，没有核心/适配器要分开装；不需要账号，也不需要服务器（**可选**用自有 VPS 走 SSH 通道）                                                                      |

## 🚀 怎么用

**入口在哪**：安装完成并重启 `dsh web` 后，打开 **设置**，左侧边栏就能看到 **「手机访问」** 入口（和「通用设置」「模型」同级）：

<p align="center">
  <img src="docs/entry.jpg" alt="手机访问入口" width="70%">
</p>

**前提**：电脑上已装好 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。如果终端提示 `dsh: command not found`（找不到 dsh 命令），先安装：

```sh
npm install -g @deepseek-ai/dsh     # 全局安装；验证：dsh --version
# 不想全局装？每次命令前加 npx：npx @deepseek-ai/dsh <命令>
```

```sh
# 1. 装插件（一个包全都有）
dsh plugin --profile web add dsh-pocket -w

# 2. 重启 dsh web
npx @deepseek-ai/dsh web
```

### 局域网（同一 WiFi）

设置 → **手机访问** → 手机扫「📶 局域网」二维码 → 打开链接**输入局域网密码**（显示在设置页局域网区块，点「刷新」可换新，或点「自定义」设成自己固定的 8–64 位密码——英文字母大小写或数字）→ 打开的就是电脑上的 DSH，实时同步。

> 「**局域网访问**」开关默认**开**：可一键**关闭/开启**（切换时弹窗提醒）——关闭后局域网二维码/链接立即失效（手机打不开），**公网不受影响**；想恢复时再点「开」即可。
>
> 局域网密码**默认开启**（安全优先）。如果只有自己用、嫌每次输密码麻烦，可在设置页局域网区块把「局域网访问密码」切到**关**——之后局域网扫码直连、无需密码（仅同一局域网设备可访问；**公网始终要密码**，不受影响）。
>
> 手机登录一次后**长期免输**：只要电脑上的 dsh web 不重启，再次打开手机不用再输入（**dsh web 重启/更新后需重新输入一次**）。
>
> 高级选项：自动识别在 Tailscale/VPN 等场景下可能选不到可达地址。可在「局域网地址」下拉框手动选择已检测到的 IP；一般不需要修改。

### 公网（人在外面）

同一页点「**开启公网访问**」→ **每次都会先弹出安全免责声明**，勾选「我已知情」后才能开启（公司/涉密网络请先确认合规）→ 等隧道建立（首次会下载 cloudflared，macOS/Linux 走清华镜像秒下）→ 手机扫「🌐 公网」二维码 → 打开链接**输入访问密码**（密码显示在设置页公网区块，默认是**每次开启公网变新的 8 位随机密码**，也可点「自定义」设成 8–64 位固定密码——英文字母大小写或数字，自定义后不再换新）→ 人在外面（4G/公司网）也能访问。

> 更新到新版本：`dsh plugin --profile web update dsh-pocket --latest -w`（跨大版本时 `--latest` 是必须的，`^0.x` 范围不会自动升到 1.x）。

### 公网固定域名（命名隧道，可选）

默认「快速隧道」的公网地址每次重启都会变（前缀随机）。想要**固定公网地址**，可用 Cloudflare **命名隧道**（需要 Cloudflare 账号 + 自己的域名）：

1. 在 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Tunnels** 创建一条 Tunnel，复制 **Tunnel Token**
2. 在该 Tunnel 的 **Public Hostname** 里把你的域名（如 `pocket.example.com`）的 Service 指向 `http://127.0.0.1:3081`
3. 回到设置页公网区块：「地址模式」切到「**固定域名**」，粘贴 Tunnel Token、填写固定域名，保存
4. 点「开启公网访问」→ 公网地址固定为你的域名，**重启不再变化**

注意：命名隧道模式下公网密码**不自动轮换**（地址固定，重启后密码不变），建议配合「自定义密码」主动管理；Tunnel Token 只存本机（`$DSH_HOME/dsh-pocket/settings.json`，仅本机可读），设置页不回显。

### 自有 VPS + SSH 反向隧道（第三种入口）

**没有 Cloudflare 账号、或者不想让流量经过 Cloudflare？** 用你自己的服务器：插件从电脑主动 `ssh` 到你的 VPS，把 VPS 上的一个回环端口反向映射到本机的 dsh-pocket 代理，VPS 上的 Caddy/nginx 再把你的域名反代到这个端口。

```
手机 → https://<你的域名>（VPS 上的 Caddy，443）
      → VPS 127.0.0.1:7788（sshd 反向转发监听口）
      → SSH 隧道 → 电脑 127.0.0.1:3081（dsh-pocket 代理）→ DSH
```

> 🔒 **本插件不会修改你的服务器配置**：它只建立一条 SSH 隧道（`ssh -N -T -R …`），退出/停止时隧道立即释放；服务器上不需要装 dsh、不需要装 cloudflared，也不需要 root。

**VPS 侧需要准备什么**：

1. 一台能 SSH 登录的服务器（有公网 IP 即可），和一个**普通账号**（不需要 sudo）；
2. 该账号的 `authorized_keys` 里放上电脑的公钥（`ssh-copy-id` 或手动追加），确认免密登录可用；
3. 一个域名解析到这台服务器（如 `dsh.example.com` 的 A 记录）；
4. 服务器上的 Caddy（自动申请证书）或 nginx + certbot，把域名**反向代理到 `127.0.0.1:7788`**，并原样传递 `Host` 与 `X-Forwarded-Proto`；
5. sshd 保持默认即可：`AllowTcpForwarding yes`（默认开）、`GatewayPorts` 保持默认 `no`（隧道只绑 `127.0.0.1`，公网入口只有 Caddy 的 443）。

完整的 Caddyfile / nginx 示例、命令行对照与故障排查见 **[docs/SSH-PENETRATION.md](docs/SSH-PENETRATION.md)**。

**插件侧要填什么**（设置 → 手机访问 → 公网区块 → 模式选「**SSH**」）：

| 字段 | 怎么填 |
| --- | --- |
| SSH 主机 | 你的 VPS 域名或 IP，如 `vps.example.com`（只填主机名，不要带 `ssh://`、路径或端口） |
| SSH 端口 | 默认 `22`；改过 sshd 端口才需要改 |
| 用户名 | 服务器上的普通账号，如 `dsh` |
| 私钥路径（可留空） | **留空 = 用 ssh 默认逻辑**（`~/.ssh/config`、ssh-agent、默认身份文件）；填了就用它并只用它。只传路径，**插件不读取、不复制、不上传私钥内容** |
| 远端转发端口 | 默认 `7788`：**必须和 Caddy/nginx 反代的目标端口一致** |
| 访问协议 | `https`（Caddy 终结 TLS）；只有内网或自签证书时才选 `http` |
| 访问域名（可留空） | 留空 = 用 SSH 主机名；填了就是二维码/链接里用的域名（如 `dsh.example.com`） |
| 访问端口（0 = 默认） | `0` = 协议默认端口（https 443 / http 80）；Caddy 监听非标准端口时才填（如 `8443`） |
| DSH 重启后自动恢复 | 默认**开**：DSH 重启后自动把这条隧道拉起来（地址固定，适合常驻）；关掉后每次重启都要手动开启 |

**怎么确认成功了**：

1. 点「保存」（保存即把公网入口切到 SSH，三个入口互斥）；
2. 点「测试连接」→ 期望显示 **「✅ 连接正常」**；它会真的连一次并等结论（失败会显示可读原因，例如 `Permission denied (publickey)`、`remote port forwarding failed for listen port 7788`）；
3. 点「开启公网访问」→ **每次都会先弹安全免责声明**，勾选后才能开 → 状态变「✅ 隧道已连接」，出现访问地址与二维码；
4. 手机用流量扫码 → 输入访问密码 → 打开的就是电脑上的 DSH；
5. 命令行自查（可选）：`curl -I https://dsh.example.com/` **不再是 502**（502 = Caddy 找不到后端 = 隧道没挂上）；未登录时拿到的是登录页。也可以直接看 SSH 区块有没有「最近错误：…」这一行。

> 运行状态、访问地址、二维码、最近错误都显示在 SSH 区块里；「停止隧道」或公网区块右上角的「关闭公网」会立即停止并释放 VPS 上的端口。

### 覆写访问协议 / 访问域名 / 访问端口

SSH 通道的「访问协议 / 访问域名 / 访问端口」只影响**二维码和链接里拼出来的地址**，不改变隧道本身（隧道永远是 `-R 127.0.0.1:<远端转发端口>:127.0.0.1:3081`）：

- 默认组合 = `https` + 域名留空（用 SSH 主机名）→ 地址就是 `https://<SSH 主机>`；
- 端口填 `0` 或协议默认端口（https 443 / http 80）时不显示端口；填了非默认端口就拼成 `https://dsh.example.com:8443`；
- 「访问域名」里自带端口（`dsh.example.com:8443`）也认，不会重复再拼一次；
- 选 **`http`** 时浏览器会把这个页面当作**非安全上下文**：Service Worker / PWA 安装 / Web Push / 通行密钥**全部不可用**，只能当降级通路（照样能看会话、发任务），并且**明文传输可被同一网络监听**——只在你明确知道自己处在可信网络（例如内网穿透的临时排障）时才用。

> Quick（随机域名）和 Named（固定域名）通道不使用这三个字段：它们各自的地址由 Cloudflare 提供。

## 📲 安装到主屏（PWA）

在 **HTTPS 域名**（Cloudflare 固定域名或自有 VPS 域名）下打开页面，就能把它装到主屏，像 App 一样全屏使用（顺带一提：**Web Push 通知也只有在 HTTPS 域名下才可能**，见下一节）：

- **Android Chrome**：设置 → 手机访问 → 「🔔 通知与 PWA」区块 → 出现「**安装到主屏**」按钮就点它；也可以直接点浏览器菜单 →「安装应用 / 添加到主屏幕」。
- **iOS Safari**：点底部分享按钮 → 「**添加到主屏幕**」。（iOS 只能这样安装，而且**必须先添加到主屏，iOS 16.4+ 才能收到 Web Push**。）
- 浏览器自带的那条安装路径（菜单 / 分享）**不依赖插件设置页**：页面本身带着 PWA 标记，**登录页**（还没输密码时）也能直接「添加到主屏幕」；插件里那颗「安装到主屏」按钮则需要先登录进设置页（它消费的是浏览器给的安装事件）。
- 装好后的好处：全屏、没有地址栏；Service Worker 可以显示推送通知；离线打开时给一个「暂时连不上电脑」的提示页。

**什么情况下装不了**（按钮位置会直接写明原因）：

| 提示 | 原因 |
| --- | --- |
| 非 HTTPS：浏览器不允许安装到主屏 | 局域网 `http://192.168.x.x` 或任何纯 IP / http 地址都装不了（Service Worker 只允许在安全上下文注册）；用域名 + HTTPS 打开 |
| 此浏览器不支持安装到主屏 | 桌面 Firefox 等没有安装入口；用 Chrome / Edge / Safari |
| 已在主屏应用中打开 | 已经装过了 |
| 暂不可安装 | 浏览器还没给出安装条件（需 HTTPS + Service Worker 注册完成，有时要等一会儿或刷新一次） |

> 安装的是**同一份网页**：登录状态、密码、通行密钥都跟浏览器一致，不会另外复制一份数据。

## 🔔 任务完成通知（Web Push / Webhook）

电脑上的 agent 跑完一轮任务时，把消息推到手机上。两个渠道可以同时开，都在设置 → 手机访问 → 「**🔔 通知与 PWA**」区块：

**① Web Push（手机通知栏提醒）**

1. 打开「**Web Push 推送**」开关；
2. **在这台手机上**打开设置页，点「**注册本机订阅**」→ 浏览器会请求通知权限（浏览器只允许在点击手势里弹权限框，所以必须点按钮）；
3. 「已订阅设备：N 台」显示当前订阅数量；换手机/换浏览器后可以「注册本机订阅」再订一台；
4. 点「**发送测试通知**」自检：渠道没开或还没订阅时会给可读原因（例如「没有已订阅的设备」）；
5. 卸载订阅用「取消本机订阅」（只退这一台）或「清空全部订阅」（清掉所有设备，换手机后残留的订阅也建议清一次）。

**② Webhook（推到自己的机器人，国内更推荐）**

- 打开「**Webhook 推送**」开关 → 选「预设」→ 填 URL，需要签名的（钉钉）再填「密钥」；
- 预设：`通用 JSON` / `企业微信机器人` / `钉钉机器人`（支持加签密钥）/ `飞书机器人` / `ntfy` / `Bark`；
- 「密钥（可选）」**只写不回显**：已设置时显示「已设置」，留空保存 = 保持原来的密钥不变；
- 「任务完成时推送」控制是否在任务结束时发；「最小推送间隔（秒）」默认 `10`，同一会话在这个间隔内只推一次，避免连刷。

**触发时机与内容**：DSH 会话里一轮任务结束（`turn/end` + agent 空闲）时触发；**子代理会话不推**；标题取会话标题（取不到用「DSH 任务完成」），正文是结束原因 + 会话标题，点击通知跳转到当前公网入口地址。

> ⚠️ **国内网络请诚实评估**：Android Chrome 的 Web Push 走 **Google FCM**，国内直连基本收不到；iOS 走 Apple 推送（需 iOS 16.4+ 且已添加到主屏），一般可用。所以国内用户**优先用 Webhook**（企业微信 / 钉钉 / 飞书 / ntfy / Bark 都能直连），或把页面添加到主屏后靠站内提示自己看。
>
> Web Push 还有两个硬前提：**HTTPS 安全上下文** + **Service Worker 已注册**（也就是页面得能装到主屏）。
>
> ⚠️ 因此**纯 http 的局域网地址（`http://192.168.x.x`）根本收不到推送**——这不是插件的问题：浏览器在非安全上下文里既不给注册 Service Worker，也不给推送订阅，点「注册本机订阅」必然失败（页面会显示「此浏览器不支持 Web Push」或订阅失败的原因）。
> 想收通知，请改用**HTTPS 域名**打开设置页再订阅：自有 VPS（SSH 通道，Caddy 签证书）或 Cloudflare 固定域名都行；**从 http 地址换到 https 域名后，本机订阅要重新注册一次**（推送订阅按站点保存，不跟着换域名走）。局域网地址下看会话、发任务不受影响，只是收不到通知——那种场景请用 Webhook。
>
> 存储位置：通知开关与 Webhook 配置在 `$DSH_HOME/dsh-pocket/settings.json`；推送订阅与 VAPID 密钥在 `$DSH_HOME/dsh-pocket/push.json`（仅本机可读，网页端不回显任何密钥）。

## 🔑 通行密钥（免密登录 + 设备管理）

手机每次输访问密码太麻烦？用**通行密钥**（WebAuthn / 指纹 / 面容）记住设备：

1. **先用访问密码登录一次**（`http(s)://<你的域名>` 打开登录页，输入设置页显示的访问密码）；
2. 登录后页面底部出现「**🔑 在此设备注册通行密钥，下次一键登录**」→ 点「注册」→ 手机指纹 / 面容确认（**设置页的「🔐 通行密钥设备」区块右侧开关要处于打开状态**，默认关闭）；
3. 之后打开登录页，点「**🔑 用通行密钥登录**」即可进入，不用再输密码；
4. 在设置页「**🔐 通行密钥设备**」查看：「当前域名（rpId）」+ 设备列表（名称 / 注册时间 / 最后登录），可以「**重命名**」「**撤销**」（撤销会先说明后果，确认后该设备立即失效，需要重新注册）。

**前提与限制（很重要）**：

- 通行密钥只在**固定域名 + HTTPS** 下可用：Named 隧道（你自己的 Cloudflare 域名）或 SSH 通道（自有 VPS 域名）。**Quick 随机域名和局域网 IP 都不行**——通行密钥按域名（rpId）隔离，域名/IP 一变就失效；
- 所以**换了域名就是新的凭据**：Caddy 域名与 Cloudflare 域名是两套通行密钥，需要各自注册一次；
- 设备记录保存在 `$DSH_HOME/dsh-pocket/passkeys.json`（只本机可读，只存哈希，不存明文令牌）；
- 设备凭据（Cookie `pocket_device`）有效期 **180 天**；清除浏览器数据 = 需要重新注册；
- **忘记密码 / 换手机**：没有"找回"流程——在**新设备上重新注册**一个通行密钥即可；旧设备不要了就在设置页「撤销」；
- 关闭「🔐 通行密钥设备」区块右侧的开关只会隐藏登录页的通行密钥入口，**已注册设备记录会保留**，随时可以再打开；
- 通行密钥是**附加**通道：访问密码始终可用（通行密钥打不开时随时回到输密码这条路）。

## ⚠️ 安全（必读）

- **DSH 能执行你电脑上的代码**。**局域网**二维码/URL 配上独立 **8 位密码**才是钥匙（密码**默认开启**，可关——关闭后局域网扫码直连，仅同一网络设备可访问），**请勿把局域网二维码、URL 或密码发给别人**
- **开启公网访问前必须阅读并勾选免责声明**（每次开启都会弹框；服务端强制校验，无法绕过）：公网 = 把能执行代码的 DSH 暴露到互联网，请使用强密码、用完即关、涉密网络勿用
- **公网**默认有 **8 位随机密码**保护：链接随机分配、默认每次开启换新密码、旧链接立即作废——泄露了也进不来，改密码/重开即可作废；**自定义密码可设为 8–64 位英文字母或数字，且不再自动换新**
- 手机登录状态与电脑上的 dsh web 进程绑定：**电脑 dsh web 一直开着就不用重复输入；重启/更新后需重新输入一次**
- **登录限速**（防暴力破解）：同一 IP 连续输错 **5 次**锁定 **60 秒**；全局失败超阈值时短暂全锁（防换 IP 分布式扫描）；输对密码后计数清零
- 公网 URL 由 cloudflared 随机分配，**每次重启会变化**（旧链接自动失效，相当于天然轮换）；**命名隧道固定域名**模式下地址不变、密码不自动轮换，请配合自定义密码管理
- **公网判定是 fail closed**（issue #66）：除本机（loopback）和局域网私网地址外，**一切陌生域名（包括你自建隧道/反向代理指向本机端口的固定域名）一律按公网处理、强制公网密码**——不存在「换域名绕过密码」的口子
- **公网入口三选一（互斥）**：随机域名（Quick）/ 固定域名（Named）/ 自有 VPS（SSH）同一时刻只有一个在跑——切换模式、保存 SSH 配置或开启另一条通道时，插件会先关掉上一条。家用/临时用 Quick，长期用 Named 或 SSH
- **自有 VPS（SSH）通道**：公网只暴露你服务器上 Caddy 的 443；隧道端口只绑服务器的 `127.0.0.1`（`GatewayPorts` 保持默认 `no`），公网扫不到明文端口；访问密码（共享 PIN）与另外两条通道完全一致；**插件不会读取私钥内容、不会修改你的服务器配置**
- **共享访问密码**是「每次开启公网变新的 8 位随机密码」（自定义后固定不再轮换）；**登录会话绑定 dsh web 进程：重启/更新后手机需要重新输入一次**
- **通行密钥 / 设备 Cookie 是长期凭据**（180 天）：手机登记一次就长期免密。撤销入口在设置页「🔐 通行密钥设备」（本机浏览器或已登录的手机都能打开这个设置页），**撤销立即生效**（删掉 `$DSH_HOME/dsh-pocket/passkeys.json` 则一次清空）；手机丢了就尽快撤销那台设备
- **注册通行密钥需要先登录一次 + HTTPS 固定域名**（防远程陌生人给自己登记设备）；设备管理接口同样要求**已登录的浏览器会话**（匿名公网访问拿不到），所以能撤销你设备的人本来就已经进得来了
- **忘记密码/换手机**：没有"找回"流程，在新设备上重新注册一个通行密钥即可（旧设备记录可随时撤销）
- **通知与 Webhook 是出站流量**：Web Push 由浏览器厂商的推送服务中转；Webhook 会把任务标题与结束原因发到你填的那个地址——别填不可信的服务
- **故障时一键关闭公网入口**：设置 → 手机访问 → 公网区块右上角「**关闭公网**」（或 SSH 区块的「**停止隧道**」）→ 二维码/链接立即失效、隧道进程退出；局域网访问另有独立开关，关掉后局域网也进不来（本机不受影响）
- 局域网模式不暴露公网，只有同一网络内的设备能访问
- 适合个人自用；公网密码存本机 `$DSH_HOME/dsh-pocket/token`（默认每次开启公网自动换新，**自定义后不换**），局域网密码存 `$DSH_HOME/dsh-pocket/token-lan`（设置页手动刷新），开关/自定义标记存 `$DSH_HOME/dsh-pocket/settings.json`
- **CLI 模式（命令行直跑 `dsh-pocket`）也有密码**（issue #90 修复前这条路是无认证的）：默认随机生成 8 位密码，打印在终端、并已内嵌进二维码（**扫码体验不变**），手动敲地址时需要填写，本机访问免密。`--pin <值>` 或 `DSH_POCKET_PIN=<值>` 自定义（至少 6 位）；`--no-auth` 可关闭，**不推荐**——那等于把能执行代码的 DSH 裸暴露给任何能连上该端口的人

## 💻 DSH Desktop（桌面版）

- 桌面版里 dsh-pocket 的**扫码同屏**正常可用；**更新/重启由桌面版管理**（插件内这两项自动停用）
- ⚠️ 桌面端 **advanced 模式**暂不支持手机访问（该模式禁用网页布局、手机拿不到 layout 服务，会白屏）——请切回 **compatibility** 模式后重启；advanced 模式下手机打开会看到明确的提示层

## 🩹 常见问题（别踩的坑）

| 现象                                        | 原因与解决                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh: command not found` / 提示 DSH 未定义  | dsh CLI 没装：`npm install -g @deepseek-ai/dsh`，或命令前加 `npx @deepseek-ai/dsh`                                                                                                                                                                                                                                                                      |
| `ERR_PNPM_ADDING_TO_ROOT`                   | pnpm 9 对 workspace 根的限制：安装/更新命令**末尾加 `-w`**（`--workspace-root`）                                                                                                                                                                                                                                                                        |
| 装完/更新了但界面没变化                     | **必须重启 `dsh web`** 才生效；运行中的进程仍加载旧代码                                                                                                                                                                                                                                                                                                 |
| `listen EADDRINUSE ... :3081`               | 旧 dsh-pocket 进程还占着端口：macOS/Linux `lsof -ti :3081 \| xargs kill -9`；Windows `netstat -ano \| findstr :3081`（找 LISTENING 的 PID）→ `taskkill /PID <PID> /F`，后重试                                                                                                                                                                           |
| 想换端口（issue #70）                       | 插件模式：在 `$DSH_HOME/dsh-pocket/settings.json` 写 `"proxyPort": 3082` 后重启 `dsh web`。CLI 模式：`dsh-pocket --port 3082`。端口被占会报 `EADDRINUSE`，杀掉旧进程或换一个端口                                                                                                                                                                        |
| 想给访客一个临时密码                        | 暂不支持：issue #69 的「临时访问 PIN」功能已在 2.6.x 移除（撤销时会崩）。现在分享访问：把主密码或 `?token=<主密码>` 链接发给对方，用完在设置页点「刷新」换掉即可                                                                                                                                                                                        |
| Linux 服务器装不上 cloudflared（issue #45） | 远程 Linux 国内/企业网下所有 CDN 源（GitHub/ghproxy/gh.ddlc/gh-proxy）都连不上时：在服务器上手动装 `cloudflared`（如 `apt install cloudflared`、`dnf install cloudflared`、或下载 tgz 解压到任意目录），然后在 `$DSH_HOME/dsh-pocket/settings.json` 加 `"cloudflaredPath": "/path/to/cloudflared"`，重启 `dsh web` 后插件直接调用它，**不再走自动下载** |
| 版本停在 0.x 升不上去                       | `^0.x` 范围不允许升到 1.x：更新用 `--latest`（`dsh plugin --profile web update dsh-pocket --latest -w`）                                                                                                                                                                                                                                                |
| 公网 `error 1033`                           | 见下方「公网隧道常见问题」——多半是本机代理/VPN（Clash 等 TUN 模式）掐断了隧道                                                                                                                                                                                                                                                                           |
| 点「重启 dsh web」后页面提示进程在后台运行  | 自重启的新进程是 detached 后台进程（不挂终端），是页内更新的标准做法；停止它：macOS/Linux `lsof -ti :3080 \| xargs kill -9`；Windows `netstat -ano \| findstr :3080` → `taskkill /PID <PID> /F`（日志在 `$DSH_HOME` 下 `dsh-pocket-restart-*.log`）                                                                                                     |
| SSH 隧道连不上（认证失败 / 端口占用 / 502） | 设置页 SSH 区块会显示「最近错误」原文（如 `Permission denied (publickey)`、`remote port forwarding failed for listen port 7788`）；对照 [SSH 内网穿透教程](docs/SSH-PENETRATION.md) 的故障排查表逐条排查 |
| 模式里看不到「SSH」模式                     | 装的是旧版插件（三通道是后加的）。更新并重启：`dsh plugin --profile web update dsh-pocket --latest -w` → 重启 `dsh web`                                                                                                                                                                                                                               |
| 装不到主屏 / 没有「安装到主屏」按钮         | PWA 安装要求 **HTTPS 域名**（局域网 `http://192.168.x.x`、纯 IP 一律不行）；iOS 只能走 Safari 分享 →「添加到主屏幕」；按钮位置会写明不可安装的原因                                                                                                                                                                                                    |
| 推送收不到                                  | ① 先点「发送测试通知」看「最近推送」结果；② Android 的 Web Push 走 Google 服务，国内可能收不到 → 改用 Webhook；③ iOS 需 16.4+ 且**必须先添加到主屏**；④ 系统通知权限/省电策略会拦，检查手机的「通知」设置和插件页面的权限                                                                                                                             |
| 通行密钥注册失败 / 登录页没有通行密钥按钮   | 只支持 **HTTPS + 固定域名**（Named 或 SSH 通道），Quick 随机域名与局域网 IP 不支持；另外设置页「🔐 通行密钥设备」开关必须打开。非 HTTPS 时浏览器根本不提供 WebAuthn，页面会直接说明                                                                                                                                                                     |
| 想撤掉某台手机的免密登录 / 清掉推送订阅     | 设置 → 手机访问 → 「🔐 通行密钥设备」里对该设备点「撤销」（立即失效，需重新注册）；「🔔 通知与 PWA」里可「清空全部订阅」                                                                                                                                                                                                                              |

## ⚠️ 公网隧道常见问题（必读）

**现象**：点「开启公网访问」后，手机上打开公网地址报 `error 1033`（Tunnel error）。

**最常见原因：本机开着代理/VPN（Clash、Surge、v2ray、sing-box 等，尤其 TUN 模式）**。
这类工具会接管全部流量，并常常把 cloudflared 的隧道边缘连接
（`*.argotunnel.com`、Cloudflare 边缘 IP）掐断，导致隧道注册成功但数据面连不上。

**解决（从轻到重，按顺序试）**：

1. 先**只关闭代理的 TUN 模式**，不用退出代理软件——多数情况这一步就够：
   - Clash：设置里关掉「**TUN 模式**」开关（或右键菜单栏图标 → 取消勾选 TUN 模式）
   - Surge：关「**增强模式**」；v2ray/sing-box：关「**虚拟网卡/路由接管**」
   - 然后回设置页重新点「开启公网访问」
2. 仍不行就**彻底退出代理软件**（不只是关界面：Clash 要右键菜单栏图标 → 退出；若装有
   后台服务还要在服务管理器里停掉，`ps aux | grep clash` 确认进程消失），再重试
3. 给代理加**直连规则**，放行隧道域名与 Cloudflare 边缘（Clash 规则示例）：
   ```yaml
   - DOMAIN-SUFFIX,argotunnel.com,DIRECT
   - DOMAIN-SUFFIX,trycloudflare.com,DIRECT
   - IP-CIDR,198.41.192.0/24,DIRECT,no-resolve
   ```
4. 网络实在不通时，改用**局域网模式**：手机开热点 → 电脑连手机热点 → 扫局域网码，
   效果完全一样（人在外面也能用）

**其他可能**：企业防火墙/校园网拦截出站；此时请让 IT 放行或改用热点。

**首次开启时「下载 cloudflared」失败/卡住**：

- **macOS/Linux**：优先走**清华镜像**（实测 ~3MB/s，几秒下完）；失败自动回退官方 GitHub + 加速源。
- **Windows**：无清华镜像（Homebrew 不支持 Windows），走官方直连下载（约 50MB，**单线程会慢，属正常**，耐心等几分钟；也可挂代理加速）。
- 全部失败时设置页会给出提示。备选方案（任选其一）：

1. 手动装好命令行 cloudflared 后重试（装好后 dsh-pocket 直接用 PATH 里的，不再下载）：
   - macOS：`brew install cloudflared`；Linux：`sudo apt install cloudflared` 或官网下载
   - Windows：`winget install cloudflared` 或官网下载
   - 任何平台：`npm i -g cloudflared`
2. 挂代理（系统代理/Clash 等）后重新点「开启公网访问」
3. 手动下载二进制放到 `$DSH_HOME/dsh-pocket/bin/` 目录（`$DSH_HOME` 一般是 `~/.dsh`，Windows 是 `%USERPROFILE%\.dsh`；文件名用 `cloudflared`（Windows 加 `.exe`）或发布资产名均可，插件都认）

## 🗂 架构（单包）

| 文件                 | 说明                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/index.js`       | 插件入口：自动起代理 + 注册 RPC + 访问密码管理（公网 8 位每次开启变新；局域网独立 8 位可手动刷新/开关）+ 局域网访问总开关 + 桌面端环境适配 + 通知事件挂载                                      |
| `lib/settings.mjs`   | 设置持久化：局域网开关/密码、公网模式（quick / named / ssh）、SSH 参数、通知与 Webhook、通行密钥开关，存 `$DSH_HOME/dsh-pocket/settings.json`（0o600）                                     |
| `lib/service.mjs`    | 服务：代理生命周期（端口自适应）、公网通道编排（cloudflared 与 SSH 互斥）、自动恢复、状态快照（含二维码）                                                                              |
| `lib/ssh.mjs`        | SSH 反向隧道核心：argv 构造（注入防护）+ stderr 分类（就绪/致命/可重试）+ 退避重连 + 状态机                                                                                            |
| `lib/ssh-channel.mjs`| SSH 通道编排：配置归一化、`-R` 转发、访问地址拼接（`accessProtocol`+`accessHost`+`accessPort`）、一次性「测试连接」                                                                      |
| `lib/proxy.mjs`      | 改头反向代理：Host/Origin → loopback，HTTP + WebSocket 透传 + polyfill 注入 + gzip/brotli 压缩 + 按 Host 区分的访问令牌认证 + 免认证 PWA 静态资源 + 通行密钥/推送 HTTP 端点               |
| `lib/pwa-assets.mjs` | PWA：Web App Manifest、Service Worker（install/activate/fetch/push/notificationclick）、图标（base64 内联，不落盘）                                                                  |
| `lib/push.mjs`       | Web Push：VAPID 密钥、RFC 8291 加密与发送（404/410 自动清理失效订阅）                                                                                                                |
| `lib/push-store.mjs` | 推送订阅与 VAPID 密钥存储（`$DSH_HOME/dsh-pocket/push.json`，只本机可读）                                                                                                              |
| `lib/webhook.mjs`    | Webhook 六种预设的请求构造与发送（钉钉加签）                                                                                                                                          |
| `lib/webauthn.mjs`   | 通行密钥校验：零依赖 CBOR 解码 + ES256 验签 + challenge/origin/rpId 校验（5 分钟一次性挑战）                                                                                           |
| `lib/passkey-store.mjs`| 设备凭据与令牌存储（`$DSH_HOME/dsh-pocket/passkeys.json`，只存哈希，原子写 0o600）                                                                                                    |
| `lib/notify-hook.mjs`| 任务完成通知：`turn/end` + agent 空闲判定、子代理过滤、去抖、发送与最近结果                                                                                                            |
| `lib/tunnel.mjs`     | cloudflared：多镜像源下载（清华优先）/自适应多线程/启动/解析公网 URL（HTTP/2）                                                                                                     |
| `lib/web-rpc.js`     | loopback RPC：`status` / `tunnel.*` / `lan.*` / `ssh.*` / `notify.*` / `passkey.*` / `version` / `update` / `restart`                                                                |
| `client/`            | 设置页「手机访问」（三通道 + PWA/通知 + 通行密钥设备）                                                                                              |
| `bin/dsh-pocket.mjs` | CLI：局域网/公网模式，打印 URL + 二维码                                                                                                                                            |

## 🛠 开发

```sh
npm install
node client/build.mjs   # 改 client/ 后重新打包
npm test                # 代理 / 认证 / 隧道 / SSH / 推送 / 通行密钥 / 设置 全量用例
```

**改完想在本机先试？** 不用发版：把插件换成指向本地仓库的软链，重启 dsh web 就是本地代码。完整步骤（含怎么换回 npm 官方版本）见 [LOCAL-DEV.md](./LOCAL-DEV.md)。

## 🤝 致谢

- 公网隧道基于 [cloudflared](https://github.com/cloudflare/cloudflared)

## 📄 License

[GPL-2.0](LICENSE) —— 自由软件许可：可自由使用、修改、分发，但**修改版必须同样以 GPL 开源**并保留版权声明；商用同样适用。


---

**有问题？欢迎反馈**：遇到 Bug、有想法、想提需求，请到 [GitHub Issues](https://github.com/shaobeichen/dsh-pocket/issues) 告诉我们 🙏
