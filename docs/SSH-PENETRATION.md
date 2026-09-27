# SSH 内网穿透：用你自己的服务器做公网入口

> 这是 dsh-pocket **第三种公网入口**（SSH 反向隧道）的完整教程。
> 适用：有 Cloudflare 账号但不想让流量过 Cloudflare、或者想用自己的 VPS 长期挂着的人。
>
> **本插件不会修改你的 VPS 配置，只建立隧道。** 它不写 `sshd_config`、不碰 Caddy/nginx、不装任何服务；
> 服务器侧的一切都由你按本文手动完成。停止隧道时，VPS 上的监听端口立即释放。

---

## 一、链路长这样

```
手机（4G / 任意网络）
  → https://dsh.example.com          ← 你域名，443，VPS 上的 Caddy/nginx 终结 TLS
  → 127.0.0.1:7788                   ← sshd 为反向转发监听的端口（只绑回环，公网扫不到）
  → SSH 隧道（电脑主动连出去的连接）
  → 127.0.0.1:3081                   ← 电脑上的 dsh-pocket 代理
  → DSH（3080）
```

方向是**电脑主动连服务器**（`ssh -R`），所以：不需要在 VPS 上装 dsh，不需要在路由器上做端口映射，
也不需要给电脑分配公网 IP。只要电脑能 SSH 出去，就能被访问到。

---

## 二、前置条件

| 需要什么 | 说明 |
| --- | --- |
| 一台服务器 | 有公网 IP 即可（VPS / 云主机 / 家里有公网 IP 的机器都行） |
| 一个**普通账号** | 不需要 root/sudo。它的 `authorized_keys` 里要放**电脑的公钥** |
| 域名 + DNS | 例如 `dsh.example.com` 的 A 记录指向服务器 IP |
| 反向代理 | Caddy（自动 HTTPS）或 nginx + certbot，把域名反代到 `127.0.0.1:7788` |
| sshd 默认配置 | `AllowTcpForwarding yes`（默认开）、`GatewayPorts` 保持默认 `no` —— 不用改 |
| 电脑侧 | 能 `ssh <user>@<host>` 免密登录（私钥或 ssh-agent 都行） |

---

## 三、第一步：服务器上准备账号与公钥

1. 建一个普通账号（示例用 `dsh`；已存在就跳过）：

   ```sh
   sudo adduser dsh          # Debian/Ubuntu；CentOS 用 sudo useradd -m dsh
   ```

2. 把**电脑的公钥**追加到该账号的 `authorized_keys`：

   ```sh
   # 在电脑上执行（会自动建目录、设权限）
   ssh-copy-id dsh@vps.example.com

   # 或者手动：把电脑 ~/.ssh/id_ed25519.pub 的内容追加到服务器上
   # /home/dsh/.ssh/authorized_keys（目录 700、文件 600）
   ```

3. 在电脑上验证免密登录（这一步必须成功，否则插件一定连不上）：

   ```sh
   ssh -o BatchMode=yes -o ConnectTimeout=10 dsh@vps.example.com true; echo "exit=$?"
   # 期望：exit=0（BatchMode 下不会弹密码提示）
   # 若提示 Permission denied (publickey) → 公钥没生效，见第八节故障排查
   ```

> 这台服务器上**不要**再跑一份 dsh-pocket 的 SSH 隧道，否则远端端口会撞车（见故障排查「端口被占用」）。

---

## 四、第二步：反向代理到 127.0.0.1:7788

### Caddy（推荐，证书自动申请）

`/etc/caddy/Caddyfile`：

```caddyfile
dsh.example.com {
    # Caddy 默认就会保留 Host 并补 X-Forwarded-Proto，这里显式写出来只是让意图更清楚
    reverse_proxy 127.0.0.1:7788 {
        header_up Host {host}
        header_up X-Forwarded-Proto {scheme}
    }
    # 不缓存动态页面（DSH 是实时界面）
    header {
        Cache-Control "no-store"
    }
}
```

改完执行 `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`。
域名解析生效后，Caddy 会自动签发 Let's Encrypt 证书。

### nginx（已有 nginx 或偏好 nginx）

```nginx
server {
    listen 443 ssl http2;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7788;

        # Host 与 X-Forwarded-Proto 必须有：Host 用于区分通道与通行密钥 rpId，
        # X-Forwarded-Proto 用于判断 https（插件优先读它，缺失时按「非回环 = https」兜底）
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # X-Forwarded-For 仅作日志参考：插件按 TCP 源地址限速，**不信任**这个头
        proxy_set_header X-Forwarded-For   $remote_addr;

        # WebSocket（DSH 的流式输出走 WS，必须透传 Upgrade）
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 流式响应不要缓冲，否则手机上看起来「卡住不滚」
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

证书用 `sudo certbot --nginx -d dsh.example.com` 申请/续期（`certbot` 会自己写入上面两行 ssl 配置）。

**为什么必须传 `Host` 与 `X-Forwarded-Proto`**：

- `Host` 决定请求属于哪条通道（插件按 Host 判定「这是不是当前公网入口」），也是通行密钥的 rpId 来源；
- `X-Forwarded-Proto` 告诉插件外面是 https（否则它按「非回环 = https」兜底，多数情况也对，但显式传更稳）。
  停掉隧道时，Caddy 会给出 `502 Bad Gateway` —— 这是**正常空载状态**，说明反代通、后端没挂。

> ⚠️ 不要让反代指向 `0.0.0.0:7788` 或直接把 7788 暴露到公网：隧道只绑回环，公网入口应该只有 443 这一个
> TLS 端口。想改绑地址可以用高级键 `sshRemoteBindHost`（默认 `127.0.0.1`，不建议动）。

---

## 五、第三步：插件侧配置

设置 → **手机访问** → 「🌐 公网（人在外面）」区块 → 「地址模式」选 **SSH** → 填下表 → 「保存」：

| 设置页字段 | 填什么 | 对应设置键 |
| --- | --- | --- |
| SSH 主机 | VPS 域名或 IP（`vps.example.com`；只填主机名） | `sshHost` |
| SSH 端口 | 默认 22 | `sshPort` |
| 用户名 | 服务器上的普通账号（`dsh`） | `sshUser` |
| 私钥路径（可留空） | 留空 = 用 ssh 默认逻辑（`~/.ssh/config` / ssh-agent / 默认身份文件）；填了就只用它。**插件不读取私钥内容** | `sshKeyPath` |
| 远端转发端口 | 默认 `7788`，**必须与反代目标一致** | `sshRemoteBindPort` |
| 访问协议 | `https`（Caddy 终结 TLS）；内网/自签才选 `http` | `accessProtocol` |
| 访问域名（可留空） | 留空 = 用 SSH 主机名；填 `dsh.example.com` | `accessHost` |
| 访问端口（0 = 默认） | `0` = https 443 / http 80；Caddy 用非标准端口才填 | `accessPort` |
| DSH 重启后自动恢复 | 默认开 | `sshAutoRestore` |

然后：

1. 点「**测试连接**」→ 期望「**✅ 连接正常**」（它真的连一次并等结论；失败会显示可读原因）；
2. 点「**开启公网访问**」→ 每次都先弹安全免责声明，勾选后才会启动 → 状态变「**✅ 隧道已连接**」，
   出现访问地址与二维码；
3. 手机开流量扫码 → 输入访问密码 → 打开的就是电脑上的 DSH；
4. 想收工时点「**停止隧道**」（或公网区块右上角「**关闭公网**」）→ 二维码/链接立即失效，VPS 上的 7788 立即释放。

> 「访问协议 / 访问域名 / 访问端口」只影响**二维码和链接里拼出来的地址**，不改变隧道本身。
> 选 `http` 时浏览器会把页面当作非安全上下文：PWA 安装、Web Push、通行密钥全部不可用（只能当降级通路）。

---

## 六、sshd 侧注意事项

- **`GatewayPorts` 保持默认 `no`**：反向转发只绑服务器的 `127.0.0.1`。这正是我们要的——公网唯一入口是 Caddy 的 443。
  设成 `yes` 会让 7788 对公网开放，等于开了一个**没有 TLS 的明文洞口**（DSH 能执行代码）。
- **`AllowTcpForwarding yes`**（默认）：关掉它会让 `-R` 直接被拒，客户端报
  `remote port forwarding failed for listen port 7788`。
- **不要给这个账号 `Restrict`/`no-port-forwarding`**：这类 key options 会禁掉端口转发。
  用 `ssh -v` 能看到服务端回显的 `key options: agent-forwarding port-forwarding …`，确认 `port-forwarding` 在列表里。
- **远端端口冲突怎么查**：

  ```sh
  ss -ltnp | grep 7788          # 或 sudo lsof -i :7788 / netstat -tlnp | grep 7788
  ```

  如果已被占用（例如上一次的隧道没退干净、或你在服务器上还装了一份别的转发），先释放它。
  插件默认带 `-o ExitOnForwardFailure=yes`：端口被占用会**立刻失败**而不是「连上了但不可用」，
  设置页会显示 `remote port forwarding failed for listen port 7788`，并且**不会**自动重试（重试也没用）。
- **首次连接会自动写 known_hosts**（`StrictHostKeyChecking=accept-new`）：正常噪音
  `Warning: Permanently added '…' to the list of known hosts.`。若主机密钥**变化**了，插件会拒绝连接并原样上报
  `Host key verification failed.` —— 这是安全保护，请人工核对服务器是否被重装/是否被劫持，不要绕过。

---

## 七、命令行对照（插件生成的命令 = 你手工能跑的命令）

插件实际执行的就是这条（`verbose` 常开，用来解析就绪行）：

```sh
ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    -i "~/.ssh/id_ed25519" -o IdentitiesOnly=yes \      # 只有填了「私钥路径」才有这一段
    -p 22 \                                             # 只有端口不是 22 才有这一段
    -v \
    -R 127.0.0.1:7788:127.0.0.1:3081 \
    dsh@vps.example.com
```

- `-N -T`：只要转发，不要 shell/pty；
- `-o BatchMode=yes`：禁止一切交互提问（无终端场景不会挂死）；
- `-o ServerAliveInterval/CountMax`：半死连接约 90 秒内被发现并触发自动重连（退避 1s→30s 封顶）；
- `-R 127.0.0.1:7788:127.0.0.1:3081`：`<远端绑定>:<远端端口>:<本机地址>:<本机端口>`（本机 3081 是 dsh-pocket 代理端口）。
- 判定「真的转发成功」的关键行（`-v`）：`debug1: remote forward success for: listen 127.0.0.1:7788, connect 127.0.0.1:3081`。

**平台差异**：命令本身在 Windows / macOS / Linux 完全一致（Windows 自带 OpenSSH 即可）：
`C:\Windows\System32\OpenSSH\ssh.exe`、`/usr/bin/ssh` 都行。差别只在引号与路径写法：

```powershell
# Windows PowerShell（路径含空格要加引号）
ssh -N -T -o ExitOnForwardFailure=yes -o BatchMode=yes -v -R 127.0.0.1:7788:127.0.0.1:3081 dsh@vps.example.com
```

```zsh
# macOS / Linux（后台跑，日志留档，验证完 kill 掉）
ssh -N -T -o ExitOnForwardFailure=yes -o BatchMode=yes -v \
    -R 127.0.0.1:7788:127.0.0.1:3081 dsh@vps.example.com 2> /tmp/dsh-tunnel.log &
```

手工验证穿透是否真的通了（在服务器上执行）：

```sh
curl -I http://127.0.0.1:7788/      # 期望 200/302（转发链路通；Host 是回环，不会再要密码）
curl -I https://dsh.example.com/    # 期望不是 502（未登录时是登录页）；502 = 隧道没挂上
```

### 可选：把隧道做成常驻（不用插件自带的重连）

> 插件**已经自带**自动重连与「DSH 重启后自动恢复」，正常情况下你不需要这一段。
> 只有在「不使用插件的 SSH 通道，想自己在系统层跑一条隧道」时才用它。
> ⚠️ 两者不能同时开：远端端口只有一个。

**Linux（systemd user 服务）**

```ini
# ~/.config/systemd/user/dsh-pocket-tunnel.service
[Unit]
Description=DSH Pocket SSH reverse tunnel
After=network-online.target

[Service]
ExecStart=/usr/bin/ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes -R 127.0.0.1:7788:127.0.0.1:3081 dsh@vps.example.com
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-pocket-tunnel
systemctl --user status dsh-pocket-tunnel
```

**macOS（launchd）**

```xml
<!-- ~/Library/LaunchAgents/com.example.dsh-pocket-tunnel.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.dsh-pocket-tunnel</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/ssh</string>
    <string>-N</string><string>-T</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=30</string>
    <string>-R</string><string>127.0.0.1:7788:127.0.0.1:3081</string>
    <string>dsh@vps.example.com</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/com.example.dsh-pocket-tunnel.plist`

**Windows（计划任务）**

```powershell
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$args = '-N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `-o BatchMode=yes -R 127.0.0.1:7788:127.0.0.1:3081 dsh@vps.example.com'
$action  = New-ScheduledTaskAction -Execute $ssh -Argument $args
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'dsh-pocket-ssh-tunnel' -Action $action -Trigger $trigger -RunLevel Limited
```

---

## 八、故障排查

| 现象 | 原始报错（设置页「最近错误」/ stderr） | 原因与解决 |
| --- | --- | --- |
| 连不上，密码提示被拒 | `Permission denied (publickey).` | 公钥没生效：确认服务器 `~/.ssh/authorized_keys` 里有电脑公钥、权限 `700/600`；确认用的是对的那把密钥（`ssh -v` 看 `Offering public key:`）。**插件不会重试**——这是配置问题 |
| 主机密钥被拒 | `Host key verification failed.` / `REMOTE HOST IDENTIFICATION HAS CHANGED` | 服务器被重装或换了密钥。**人工核对**后删除电脑上 `~/.ssh/known_hosts` 里对应行再重连；不要绕过校验 |
| 隧道连上了但公网 502 | 客户端可能没有任何错误 | 典型两类：① 反代目标端口与「远端转发端口」不一致（Caddy 写 7788、插件填 7789）；② 隧道没在跑（Caddy 空载）。用服务器上 `curl -I http://127.0.0.1:7788/` 验证，或看公网区块状态是否「✅ 隧道已连接」 |
| 远端端口被占用 | `remote port forwarding failed for listen port 7788` | 服务器上 7788 已被占：`ss -ltnp \| grep 7788` 找到进程（可能是你自己上一次的隧道）；换成别的「远端转发端口」并同步改反代目标 |
| 服务端拒绝转发 | 同上（客户端文本一样） | 账号被 `Restrict` / `no-port-forwarding`，或 `AllowTcpForwarding no`。检查 `sshd_config` 与 `authorized_keys` 的 key options |
| 域名证书没签下来 | 浏览器证书错误 / `curl` 报证书失败 | DNS 未生效或 80/443 未放行：`dig +short dsh.example.com` 应等于服务器 IP；安全组/防火墙放行 80（签发）与 443；Caddy 用 `sudo journalctl -u caddy -e` 看 ACME 日志 |
| 打不开、连接被拒 | `Connection refused` / `Connection timed out` | SSH 端口不对或被防火墙拦：确认「SSH 端口」与实际 sshd 一致，安全组放行该端口；超时可重试（插件会自动退避重连） |
| 装不到主屏（PWA） | 页面显示「非 HTTPS：浏览器不允许安装到主屏」 | 必须用 **HTTPS 域名**打开（本教程的 Caddy/nginx 就是为此）：`https://dsh.example.com`。`http://` 或纯 IP 一律不行——Service Worker 要求安全上下文。另外 iOS 只能在 Safari 里「分享 → 添加到主屏幕」 |
| 推送收不到 | 「最近推送」显示失败/无订阅 | ① 先点「发送测试通知」看结果；② 必须 HTTPS + 已添加到主屏（Service Worker 才可以显示通知）；③ Android 的 Web Push 走 Google FCM，国内可能收不到 → 改用 Webhook（企业微信/钉钉/飞书/ntfy/Bark）；④ iOS 需 16.4+ 且已添加到主屏；⑤ 手机系统通知权限/省电策略会拦 |
| 通行密钥注册失败 / 没有按钮 | 页面提示需要 HTTPS 或按钮不出现 | 通行密钥只在 **HTTPS + 固定域名**（Named 或 SSH 通道）且「🔐 通行密钥设备」开关打开时可用。非 HTTPS（http、纯 IP、局域网 IP）时浏览器根本不提供 WebAuthn，插件也会直接说明。另外登录页的通行密钥按钮需要先用访问密码登录过一次才出现 |
| 换了域名后通行密钥失效 | 登录页点通行密钥提示「这台设备没有注册通行密钥」 | 正常：通行密钥按域名（rpId）隔离。Caddy 域名与 Cloudflare 域名是两套凭据，换域名后在新域名上重新注册一次 |
| 手机上一切正常，但重启电脑后要重新输密码 | — | 共享访问密码的登录会话绑定 dsh web 进程，重启即失效（设计如此）；通行密钥/设备 Cookie 不受影响（180 天） |

> 所有 ssh 原始输出都会保留在设置页 SSH 区块的「最近错误：…」里，直接对照本表即可。

---

## 九、安全边界（读完再开放公网）

- **公网暴露的是什么**：只有你 VPS 上 Caddy 的 443。VPS 的 7788 只绑 `127.0.0.1`，公网扫不到；隧道断开即释放。
- **访问密码依然生效**：SSH 通道与随机域名/固定域名通道共用同一套公网访问密码（PIN）。
  默认每次开启公网换新的 8 位随机密码，也可以「自定义」固定 8–64 位。
- **共享 PIN 会在 dsh web 重启后失效**（要重新输入）；**通行密钥 / 设备 Cookie 长期有效**（180 天），
  撤销入口在设置页「🔐 通行密钥设备」（本机或已登录的手机都能打开；管理接口要求已登录会话，匿名公网访问拿不到），
  撤销**立即生效**（删除 `$DSH_HOME/dsh-pocket/passkeys.json` 则一次清空）。
- **插件做了什么、没做什么**：只执行 `ssh -N -T -R …` 并监控它；不读私钥内容、不写你的 `~/.ssh`、
  不改服务器配置、不装服务器端组件。要停就停：设置页「停止隧道」或「关闭公网」。
- **本机与局域网**：DSH 仍在 `127.0.0.1:3080`；代理监听 `:3081`（局域网扫码用的就是它）。公网请求一律过访问密码闸门；
  局域网请求按「局域网访问」开关与「局域网访问密码」判定（关闭局域网访问后，局域网 Host 直接被拒）。本机 `127.0.0.1` 访问不受任何开关影响。
- **善后**：不用了就把隧道停掉；服务器上的域名/反代可以留着，不影响安全（没有隧道时它只会返回 502）。
- **已知差异：SSH 通道下登录限速是「一个桶」**。限速按**来源 IP** 计数，来源 IP 取的是 TCP 源地址；
  SSH 通道进来的请求源地址都是隧道口的**回环地址**，所以所有公网访客共用一个桶——有人连续输错 5 次，
  这 60 秒的锁会一起加给所有人（Cloudflare 通道因为 Cloudflare 会写 `cf-connecting-ip`，能按真实客户端 IP 分开计）。
  个人自用无影响；要把链接分享给多人时请留意。

---

## 十、字段与代码对照（排查时用）

| 设置页字段 / 行为 | `settings.json` 键 | 实现位置 |
| --- | --- | --- |
| 公网模式（随机域名/固定域名/SSH 三选一） | `tunnelMode` | `lib/settings.mjs` `tunnelMode()` / `lib/service.mjs` `syncTunnelMode()` |
| SSH 主机 / 端口 / 用户名 | `sshHost` / `sshPort` / `sshUser` | `lib/settings.mjs`、`lib/ssh-channel.mjs` |
| 私钥路径（只传路径，不回显） | `sshKeyPath` | `lib/settings.mjs` `sshKeyPath()`（RPC 只回 `keyPathSet`） |
| 远端绑定地址（默认 127.0.0.1，高级） | `sshRemoteBindHost` | `lib/settings.mjs` `sshRemoteBindHost()` |
| 远端转发端口 | `sshRemoteBindPort` | `lib/settings.mjs`、`lib/ssh.mjs` `buildSshArgs()` |
| 访问协议 / 访问域名 / 访问端口 | `accessProtocol` / `accessHost` / `accessPort` | `lib/settings.mjs`、`lib/ssh-channel.mjs` `buildAccessUrl()` |
| DSH 重启后自动恢复 | `sshAutoRestore` | `lib/service.mjs` `restoreTunnelIfNeeded()` |
| 隧道 argv、错误分类、重连 | — | `lib/ssh.mjs`（`buildSshArgs` / `classifySshLine` / `createSshTunnel`） |
| 隧道编排、一次性「测试连接」 | — | `lib/ssh-channel.mjs`、`lib/service.mjs` `testSshConnection()` |
| 公网通道判定（Host 必须匹配当前通道，否则 403） | — | `lib/proxy.mjs` `publicChannelForHost()` |

设置文件：`$DSH_HOME/dsh-pocket/settings.json`（`$DSH_HOME` 默认 `~/.dsh`，Windows 是 `%USERPROFILE%\.dsh`）。
