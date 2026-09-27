<p align="center">
  <img src="docs/banner.jpg" alt="DSH Pocket" width="100%">
</p>

<h1 align="center">DSH Pocket</h1>

<p align="center"><a href="README.en.md">English</a> | <a href="README.md">中文</a></p>

<p align="center"><a href="https://trendshift.io/repositories/166736?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-166736" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/166736/daily?language=JavaScript" alt="shaobeichen%2Fdsh-pocket | Trendshift" width="250" height="55"/></a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="npm" src="https://img.shields.io/npm/v/dsh-pocket?color=4d6bfe&label=npm"></a>
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="downloads" src="https://img.shields.io/npm/dm/dsh-pocket?color=4d6bfe"></a>
  <a href="https://github.com/shaobeichen/dsh-pocket/actions"><img alt="CI" src="https://github.com/shaobeichen/dsh-pocket/actions/workflows/npm-publish.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-GPL--2.0-red.svg"></a>
  <a href="https://github.com/shaobeichen/dsh-pocket/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/shaobeichen/dsh-pocket"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

> Put **DeepSeek Harness in your pocket**: one package, one settings tab — scan a QR code and your phone shows exactly what's on your computer screen, live, from anywhere.

<p align="center">
  ⭐ A Star would make the author's day &nbsp;·&nbsp; <a href="https://github.com/shaobeichen/dsh-pocket">Here, take one</a>
</p>

## What is this

**You want to use DeepSeek Harness on your computer, even when you're not at the computer.**

- On your way home, the agent is running a task on your computer — pull out your phone and see where it is, what it produced.
- Out and about, you want the agent on your computer to look something up or write a snippet — no remote desktop, no SSH.
- The computer is at home or in the office, you're elsewhere, and you want to **drive your DeepSeek Harness from your phone** — send tasks, watch the output, tap approvals.

That's what DSH Pocket does: **install it, scan a QR code, and your phone shows and controls the DeepSeek Harness UI in real time — from anywhere.**

What it looks like — the phone shows the exact same UI as your computer, live:

<p align="center">
  <img src="docs/interface.jpg" alt="DSH UI on the phone" width="100%">
</p>

## ✨ Features

| Feature                      | Description                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📶 LAN QR access             | Works out of the box: Settings → Phone access — scan the LAN QR on the same Wi-Fi (auto-detects the LAN IP; **under WSL it picks the Windows host's physical NIC IP**)                                                                                                            |
| 🚪 LAN switch                | **Turn LAN access off/on with one click** in Settings (a confirmation dialog shows each time): off kills the LAN QR code and link instantly; public access is unaffected                                                                                                          |
| 🌐 Public QR (from anywhere) | Click "Enable anywhere" → cloudflared tunnel → scan the public QR over 4G / any network                                                                                                                                                                                           |
| 🏷️ Fixed public hostname     | Optional "**Named tunnel**" mode: paste a Cloudflare Tunnel Token + your own domain — the public address stays **fixed across restarts** (see below)                                                                                                                              |
| 🛰️ Your own VPS tunnel       | Third public entry: an **SSH reverse tunnel** through your own server + domain (any account you can SSH into). The plugin only opens a tunnel — **it never touches your server config**; the address is fixed and no traffic goes through Cloudflare (see the [SSH penetration guide](docs/SSH-PENETRATION.md), in Chinese) |
| 📲 Install to home screen    | Under an HTTPS hostname the page can be **added to the home screen** and opened full-screen like an app (plain HTTP / bare IP cannot install)                                                                                                                                     |
| 🔔 Task-completion alerts    | When a task finishes on the computer, notify the phone: **Web Push** (needs HTTPS + home-screen install) or a **Webhook** (WeCom / DingTalk / Feishu / ntfy / Bark / generic JSON) as the reliable fallback                                                    |
| 🆔 Passkey sign-in           | Sign in once with the access PIN → register a **passkey** (fingerprint / face) on that device → no PIN afterwards. Devices can be **renamed / revoked** in Settings; revoking takes effect immediately                                                  |
| 🔐 Access PIN                | Public links use an **8-digit random PIN** by default (rotated on every tunnel start; **customizable to a fixed PIN** — custom PINs are not rotated); LAN has its own separate **8-digit random PIN** (on by default; switchable off in Settings — then LAN scans connect directly) |
| 🔑 Custom PINs               | Both the public and LAN PINs can be **set to a fixed 8–64-character PIN using letters and digits in Settings** (custom PINs are never auto-rotated)                                                                                                                               |
| 🧘 Session persistence       | Enter the PIN once and you're set for a long time (login is tied to the computer's dsh web process: as long as it stays up, the phone won't ask again; **after a dsh web restart/update, enter it once more**)                                                                    |
| ⚡ Real-time sync            | Streaming output passes through WebSocket untouched — what the computer renders, the phone renders live; fully interactive both ways; built-in WS heartbeat keep-alive (defeats silent NAT/battery link drops with auto-reconnect)                                                |
| 📱 Mobile-adaptive layout    | Narrow screens get a drawer layout automatically (ported from dsh-web-mobile, MIT): sidebar drawer, full-width conversation, safe-area insets, touch optimizations                                                                                                                |
| 🧭 Optional right sidebar    | Shows the native right-sidebar entry on mobile; disable it for a compact phone header or keep it available alongside the terminal dock on an unfolded display                                                                                                                     |
| 📁 File browser              | The mobile "Files" entries need a host-side explorer panel (a dsh-web-ui component); on stock DSH without it the entries are auto-hidden instead of doing nothing                                                                                                                 |
| 🗜️ Transfer compression      | Large JSON responses are gzip/brotli'd on the fly (17MB session history → ~1MB; brotli quality 6: fast and bandwidth-friendly) — faster loads, less mobile data                                                                                                                   |
| 🔁 Tunnel auto-restore       | After a DSH restart the previously-running public entry comes back automatically (the SSH channel can opt out with its own "auto-restore" switch)                                                                                                                                  |
| 🧩 Zero-dependency install   | One npm package, one settings tab — no core/adapter split and no account needed; no server needed either (**optional**: bring your own VPS for the SSH channel)                                                                                                                     |

## 🚀 Usage

**Where the entry is**: after installing and restarting `dsh web`, open **Settings** — the left sidebar shows **"Phone access"** at the top level (same level as General / Models):

<p align="center">
  <img src="docs/entry.jpg" alt="Phone access entry" width="70%">
</p>

**Prerequisite**: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installed. If your terminal says `dsh: command not found`, install it first:

```sh
npm install -g @deepseek-ai/dsh     # global install; verify: dsh --version
# No global install? Prefix every command with: npx @deepseek-ai/dsh
```

```sh
# 1. Install the plugin (everything in one package)
dsh plugin --profile web add dsh-pocket -w

# 2. Restart dsh web
npx @deepseek-ai/dsh web
```

### LAN (same Wi-Fi)

Settings → **Phone access** → scan the "📶 LAN" QR code → enter the **LAN PIN** (shown in the LAN block; hit **Refresh** to roll a new one, or **Customize** to set an 8–64-character alphanumeric PIN) → the phone opens the exact same DSH, in real time.

> The "**LAN access**" switch is **on by default** and can be **turned off/on with one click** (a confirmation dialog shows each time). Off kills the LAN QR code and link instantly (phones can't open them); **public access is unaffected**. Tap "On" to restore it.
>
> The LAN PIN is **on by default** (security-first). If you're the only user and find typing it every time annoying, flip "LAN access PIN" to **Off** in the LAN block — LAN scans then connect directly with no PIN (LAN-only devices; the **public tunnel always requires a PIN**, unaffected).
>
> After logging in once, the phone **won't ask again**: as long as the computer's dsh web keeps running, reopening the phone needs no PIN (**a dsh web restart/update asks for it once more**).
>
> Advanced option: auto-detection may not pick a reachable address for Tailscale/VPN setups. You can select a detected IP from the "LAN address" dropdown; normally no change is needed.

### Public (from anywhere)

On the same page click "**Enable anywhere**" → **a security disclaimer pops up every time — check "I understand and agree" to proceed** (on a corporate/classified network, confirm compliance first) → wait for the tunnel (first run downloads cloudflared; macOS/Linux use the Tsinghua mirror, seconds) → scan the "🌐 Public" QR code → the phone opens the link and **enters the access PIN** (shown in the settings page's public section; the default is an **8-digit random PIN rotated on every tunnel start**, or use **Customize** for a fixed 8–64-character alphanumeric PIN that is never rotated) → works from outside (4G / office network).

> Upgrading: `dsh plugin --profile web update dsh-pocket --latest -w` (`--latest` is required across major versions — a `^0.x` range won't auto-jump to 1.x).

### Fixed public hostname (named tunnel, optional)

The default "quick tunnel" gets a new random URL on every restart. For a **fixed public address**, use a Cloudflare **named tunnel** (requires a Cloudflare account + your own domain):

1. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Tunnels**, create a Tunnel and copy the **Tunnel Token**
2. In that Tunnel's **Public Hostname**, point your domain (e.g. `pocket.example.com`) to `http://127.0.0.1:3081`
3. Back in the settings page's public block: switch the mode to "**Fixed domain**", paste the Tunnel Token, enter the fixed hostname, and save
4. Click "Enable anywhere" → the public address is now your own hostname and **survives restarts**

Note: in named-tunnel mode the public PIN is **not auto-rotated** (the address is fixed, so the PIN stays the same across restarts) — manage it proactively with a custom PIN. The Tunnel Token is stored locally only (`$DSH_HOME/dsh-pocket/settings.json`, readable by your user only) and is never echoed back in the UI.

### Your own VPS + SSH reverse tunnel (third entry)

**No Cloudflare account, or you'd rather not route traffic through Cloudflare?** Use your own server: the plugin runs `ssh` from the computer to your VPS, forwarding a loopback port on the VPS back to the local dsh-pocket proxy; Caddy/nginx on the VPS then reverse-proxies your domain to that port.

```
Phone → https://<your domain> (Caddy on the VPS, 443)
      → VPS 127.0.0.1:7788 (the port sshd listens on for the remote forward)
      → SSH tunnel → computer 127.0.0.1:3081 (dsh-pocket proxy) → DSH
```

> 🔒 **The plugin never modifies your server**: it only opens an SSH tunnel (`ssh -N -T -R …`) and releases it when stopped. The server needs no dsh, no cloudflared and no root.

**What the VPS needs**:

1. A server you can SSH into (any public IP) and a **normal account** (no sudo needed);
2. That account's `authorized_keys` holding your computer's public key (`ssh-copy-id` or append manually) — password-less login must work;
3. A domain pointing at the server (an A record for e.g. `dsh.example.com`);
4. Caddy (auto TLS) or nginx + certbot reverse-proxying the domain to **`127.0.0.1:7788`**, passing `Host` and `X-Forwarded-Proto` through unchanged;
5. sshd defaults: `AllowTcpForwarding yes` (default) and `GatewayPorts` left at the default `no` (the tunnel binds `127.0.0.1` only; the only public port is Caddy's 443).

Full Caddyfile / nginx examples, command-line equivalents and a troubleshooting table live in **[docs/SSH-PENETRATION.md](docs/SSH-PENETRATION.md)** (Chinese).

**What to fill in the plugin** (Settings → Phone access → public block → mode "**SSH**"):

| Field | What to put |
| --- | --- |
| SSH host | Your VPS hostname or IP, e.g. `vps.example.com` (host only — no `ssh://`, no path, no port) |
| SSH port | `22` unless your sshd listens elsewhere |
| Username | A normal account on the server, e.g. `dsh` |
| Private key path (optional) | **Blank = use ssh's own defaults** (`~/.ssh/config`, ssh-agent, default identity files). If set, that key is used and only that key. Only the path is passed — **the plugin never reads, copies or uploads key contents** |
| Remote forward port | `7788` by default: **must match what Caddy/nginx proxies to** |
| Access protocol | `https` (Caddy terminates TLS); pick `http` only for internal networks or self-signed setups |
| Public hostname (optional) | Blank = use the SSH hostname; otherwise the hostname used in the QR code / link (e.g. `dsh.example.com`) |
| Public port (0 = default) | `0` = the protocol default (443 for https / 80 for http); set it only if Caddy listens elsewhere (e.g. `8443`) |
| Auto-restore after a DSH restart | **On** by default: the tunnel is brought back after a DSH restart (fixed address, built to stay up); turn it off to enable manually every time |

**How to confirm it works**:

1. Click "Save" (saving switches the public entry to SSH — the three entries are mutually exclusive);
2. Click "Test connection" → expect **"✅ Connection OK"**; it really connects and waits for the outcome (failures show readable causes such as `Permission denied (publickey)` or `remote port forwarding failed for listen port 7788`);
3. Click "Enable anywhere" → **the security disclaimer pops up every time**; tick it to continue → status becomes "✅ Tunnel connected" with an address and QR code;
4. Scan the QR over mobile data → enter the access PIN → you're on your computer's DSH;
5. Optional check from a shell: `curl -I https://dsh.example.com/` is **no longer 502** (a 502 means Caddy has no backend — the tunnel is down); an unauthenticated request gets the login page. Or simply check whether the SSH block still shows a "Last error: …" line.

> Run state, address, QR code and the last error all live in the SSH block; "Stop tunnel" (or "Stop" at the top of the public block) stops it immediately and releases the port on the VPS.

### Overriding access protocol / hostname / port

For the SSH channel, "Access protocol / Public hostname / Public port" only affect **the address printed in the QR code and link** — the tunnel itself is always `-R 127.0.0.1:<remote forward port>:127.0.0.1:3081`:

- Default combination = `https` + blank hostname (use the SSH host) → the address is `https://<ssh host>`;
- Port `0` or the protocol default (443 / 80) is omitted; any other port is appended (`https://dsh.example.com:8443`);
- A hostname that already carries a port (`dsh.example.com:8443`) is accepted and the port is not appended twice;
- With **`http`** the browser treats the page as an **insecure context**: Service Worker, PWA install, Web Push and passkeys are all unavailable — it is a degraded path only (you can still read sessions and run tasks), and **plaintext can be sniffed on the same network**. Use it only on a network you trust (e.g. a temporary internal-network workaround).

> Quick (random URL) and Named (fixed hostname) channels do not use these fields — Cloudflare provides their addresses.

## 📲 Install to home screen (PWA)

Open the page over an **HTTPS hostname** (a Cloudflare fixed hostname or your own VPS domain) and install it to the home screen for a full-screen, app-like experience:

- **Android Chrome**: Settings → Phone access → the "🔔 Notifications & PWA" block → click "**Install to home screen**" when the button appears; or use the browser menu → "Install app / Add to Home screen".
- **iOS Safari**: tap Share → "**Add to Home Screen**". (That's the only way on iOS — and it is a **prerequisite for Web Push on iOS 16.4+**.)
- Why bother: full screen with no address bar; the service worker can show push notifications; offline opens show a "can't reach the computer" notice page.

**When it can't install** (the reason is printed where the button would be):

| Message | Cause |
| --- | --- |
| Not HTTPS: browsers will not install to the home screen | LAN `http://192.168.x.x`, bare IPs and any plain-http origin cannot install (service workers require a secure context); use a domain over HTTPS |
| This browser cannot install to the home screen | Desktop Firefox and friends have no install entry point; use Chrome / Edge / Safari |
| Already running from the home screen | It's already installed |
| Not installable yet | The browser has not offered the install prompt (needs HTTPS + a registered service worker; it can take a moment or a reload) |

> It installs **the same web page**: login state, PIN and passkeys are shared with the browser tab — no second copy of your data.

## 🔔 Task-completion notifications (Web Push / Webhook)

When a task finishes on the computer, notify your phone. Both channels can be on at once, all under Settings → Phone access → "**🔔 Notifications & PWA**":

**① Web Push (phone notification)**

1. Turn on "**Web Push**";
2. **On the phone you want notified**, open the settings page and click "**Subscribe this device**" — the browser asks for notification permission (browsers only allow the permission prompt inside a click, hence the button);
3. "Subscribed devices: N" shows the current count; subscribe another device the same way;
4. Click "**Send a test notification**" to self-check: with no channel enabled or no subscription you get a readable reason (e.g. "no push subscriptions yet");
5. Use "Unsubscribe this device" (one device) or "Clear all subscriptions" (everything — handy after switching phones).

**② Webhook (post to your own bot — the reliable choice in mainland China)**

- Turn on "**Webhook**" → pick a "Preset" → enter the URL (plus the signing secret for DingTalk);
- Presets: `Generic JSON` / `WeCom bot` / `DingTalk bot` (signing secret supported) / `Feishu bot` / `ntfy` / `Bark`;
- "Secret (optional)" is **write-only**: once set it shows "set", and saving with it blank keeps the existing secret;
- "Push when a task finishes" toggles the trigger; "Minimum push interval (s)" defaults to `10` so one session can't spam you.

**Trigger and payload**: one finished turn in a DSH session (`turn/end` + agent idle); **sub-agent sessions are skipped**; the title is the session title (the built-in fallback is the Chinese string "DSH 任务完成"), the body is the end reason plus the session title, and tapping the notification opens the current public address.

> ⚠️ **Be honest about mainland-China networking**: Android Chrome Web Push goes through **Google FCM** and generally does not arrive there; iOS uses Apple's push service (requires iOS 16.4+ and a home-screen install) and usually works. So in mainland China **prefer the Webhook** (WeCom / DingTalk / Feishu / ntfy / Bark are all reachable), or install the page to the home screen and check it yourself.
>
> Web Push has two hard prerequisites: an **HTTPS secure context** and a **registered service worker** (i.e. the page must be installable). Subscribing from LAN `http://192.168.x.x` always fails.
>
> Storage: switches and Webhook config live in `$DSH_HOME/dsh-pocket/settings.json`; push subscriptions and the VAPID key live in `$DSH_HOME/dsh-pocket/push.json` (local-only; no secret is ever echoed to the page).

## 🔑 Passkeys (password-free sign-in + device management)

Typing the access PIN on a phone gets old. Use a **passkey** (WebAuthn / fingerprint / face) to remember the device:

1. **Sign in once with the access PIN** (open `http(s)://<your hostname>` and enter the PIN shown in Settings);
2. After signing in, a bar appears at the bottom: "**🔑 Register a passkey on this device**" → click "Register" → confirm with fingerprint/face (the switch on the right of the Settings "🔐 Passkey devices" block must be **on**; it is off by default);
3. Next time, click "**🔑 Sign in with a passkey**" on the login page — no PIN;
4. In Settings → "**🔐 Passkey devices**" you can see "Current domain (rpId)" plus the device list (name / registered / last sign-in) and "**Rename**" or "**Revoke**" a device (revoking first explains the consequence; after confirming, that device stops working immediately and must register again).

**Prerequisites and limits (important)**:

- Passkeys require **HTTPS + a fixed hostname**: a Named tunnel (your Cloudflare hostname) or the SSH channel (your own VPS domain). **Quick random URLs and LAN IPs do not work** — passkeys are scoped by domain (rpId), so a changing domain or IP loses them;
- Therefore **a different hostname means different credentials**: your Caddy hostname and your Cloudflare hostname are two separate sets of passkeys — register on each;
- Device records live in `$DSH_HOME/dsh-pocket/passkeys.json` (local-only; hashes only, never plaintext tokens);
- The device cookie (`pocket_device`) lasts **180 days**; clearing browser data means registering again;
- **Forgot / new phone**: there is no recovery flow — just **register a new passkey** on the new device; revoke the old device in Settings if you no longer use it;
- Turning the passkey switch off only hides the login-page entry; **device records are kept** and can be re-enabled any time;
- Passkeys are an **additional** path: the access PIN always works, so you can fall back to it.

## ⚠️ Security (read first)

- **DSH can execute code on your computer.** **LAN** QR/URL plus its own **8-character PIN** is the key (PIN **on by default**, switchable off — then LAN scans connect directly, same-network devices only) — **never share the LAN QR, URL or PIN**.
- **Read and accept the security disclaimer before enabling public access** (the dialog shows on every enable; the server enforces it, so it can't be bypassed): public = exposing a code-executing DSH to the internet — use a strong PIN, turn it off when done, never on classified networks.
- **Public** access uses an **8-digit random PIN** by default: the link is random, the PIN rotates on every tunnel start, and old links die instantly — even a leaked link can't get in. **A custom PIN may contain 8–64 letters and digits and is never auto-rotated**.
- Phone login state is tied to the computer's dsh web process: **no re-entry while dsh web stays up; one re-entry after a restart/update**.
- **Login rate limiting** (anti brute-force): **5** consecutive wrong PINs from the same IP lock it for **60s**; a global failure threshold briefly locks everyone (blocks distributed IP-rotation scans); a successful login resets the counter.
- The public URL is randomly assigned by cloudflared and **changes on every restart** (old links die automatically — a natural key rotation); in **named-tunnel fixed-hostname** mode the address stays and the PIN is not auto-rotated — manage it with a custom PIN.
- **Public detection is fail-closed** (issue #66): everything except loopback and private LAN addresses is treated as **public and PIN-gated** — including any self-hosted tunnel / reverse proxy pointing at the local port with its own hostname. There is no "change the domain to bypass the PIN" hole.
- **The three public entries are mutually exclusive**: Quick (random URL) / Named (fixed hostname) / SSH (your own VPS) — only one runs at a time; switching modes or saving the SSH config stops the previous one first. Use Quick for a one-off, Named or SSH for long-term access.
- **Own-VPS (SSH) channel**: the only public port is Caddy's 443 on your server; the tunnel binds `127.0.0.1` there (`GatewayPorts` stays at the default `no`), so no plaintext port is scannable; the same shared access PIN applies as on the other two channels; **the plugin never reads private-key contents and never changes your server config**.
- The **shared access PIN** is an 8-digit random PIN **rotated on every tunnel start** (a custom PIN is not rotated); **the login session is tied to the dsh web process — after a restart/update the phone asks once more**.
- **Passkeys / device cookies are long-lived credentials** (180 days): register once and the phone stays signed in. Revoke them in Settings → "🔐 Passkey devices" (open it on the computer or on an already signed-in phone); **revoking is immediate** (or delete `$DSH_HOME/dsh-pocket/passkeys.json` to clear everything). If the phone is lost, revoke that device right away.
- **Registering a passkey requires a prior PIN login + HTTPS on a fixed hostname** (so a remote stranger cannot enrol their own device); device management also requires an **authenticated browser session** (anonymous public requests cannot reach it), so anyone able to revoke your devices had already got in.
- **Forgot / new phone**: there is no recovery flow — register a new passkey on the new device (and revoke the old record whenever you like).
- **Notifications and Webhooks are outbound traffic**: Web Push is relayed by the browser vendor's push service; a Webhook sends the task title and end reason to whatever URL you configure — don't point it at a service you don't trust.
- **One-click shutdown of the public entry**: Settings → Phone access → "**Stop**" at the top of the public block (or "**Stop tunnel**" inside the SSH block) → the QR/link dies immediately and the tunnel process exits. LAN access has its own switch; turning it off blocks LAN too (localhost is unaffected).
- LAN mode exposes nothing publicly; only devices on the same network can reach it.
- Built for personal use; the public PIN lives in `$DSH_HOME/dsh-pocket/token` (re-rolled per tunnel start unless customized), the LAN PIN in `$DSH_HOME/dsh-pocket/token-lan` (refreshed manually in Settings), and switches/custom flags in `$DSH_HOME/dsh-pocket/settings.json`.

## 💻 DSH Desktop

- In the desktop app, **QR screen-mirroring works**; **update/restart are managed by the desktop app** (auto-disabled here).
- ⚠️ The desktop **advanced mode** doesn't support phone access yet (it disables the web layout; the phone gets no layout service → blank screen). Switch back to **compatibility** mode and restart; phones opening an advanced-mode page will see a clear notice overlay.

## 🩹 Troubleshooting (traps users step on)

| Symptom                                                                         | Cause & fix                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh: command not found` / "DSH is not defined"                                 | dsh CLI missing: `npm install -g @deepseek-ai/dsh`, or prefix commands with `npx @deepseek-ai/dsh`                                                                                                                                                                                                                                                                                                                               |
| `ERR_PNPM_ADDING_TO_ROOT`                                                       | pnpm 9 workspace-root restriction: append `-w` (`--workspace-root`) to install/update commands                                                                                                                                                                                                                                                                                                                                   |
| Nothing changed after install/update                                            | **You must restart `dsh web`**; the running process still loads the old code                                                                                                                                                                                                                                                                                                                                                     |
| `listen EADDRINUSE ... :3081`                                                   | A stale dsh-pocket process holds the port: macOS/Linux `lsof -ti :3081 \| xargs kill -9`; Windows `netstat -ano \| findstr :3081` (find the LISTENING PID) → `taskkill /PID <PID> /F`, then retry                                                                                                                                                                                                                                |
| Want a different port (issue #70)                                               | Plugin mode: write `"proxyPort": 3082` into `$DSH_HOME/dsh-pocket/settings.json` and restart `dsh web`. CLI mode: `dsh-pocket --port 3082`. If the port is taken you'll get `EADDRINUSE` — kill the old process or pick another one                                                                                                                                                                                              |
| Issue a temporary PIN to a guest                                                | Not available: the temporary access PIN feature (issue #69) was removed in 2.6.x (it crashed on revoke). To share access, send the main PIN or a `?token=<main PIN>` link, then hit "Refresh" in Settings once the guest is done                                                                                                                                                                                                 |
| cloudflared install fails on a remote Linux server (issue #45)                  | If all CDN sources (GitHub / ghproxy / gh.ddlc / gh-proxy) are unreachable on a remote Linux host, install `cloudflared` yourself (e.g. `apt install cloudflared`, `dnf install cloudflared`, or download the tgz and unpack it), then add `"cloudflaredPath": "/path/to/cloudflared"` into `$DSH_HOME/dsh-pocket/settings.json` and restart `dsh web`. The plugin will then use that binary directly and skip the auto-download |
| Version stuck below 1.x                                                         | `^0.x` ranges never jump to 1.x: update with `--latest` (`dsh plugin --profile web update dsh-pocket --latest -w`)                                                                                                                                                                                                                                                                                                               |
| Public `error 1033`                                                             | See "Public tunnel troubleshooting" below — usually a local proxy/VPN (Clash etc. TUN mode) killing the tunnel                                                                                                                                                                                                                                                                                                                   |
| After "Restart dsh web", the page says the process is running in the background | The new process from in-page self-restart is a detached background process (not attached to your terminal) — that's the standard way to apply updates in-page; stop it: macOS/Linux `lsof -ti :3080 \| xargs kill -9`; Windows `netstat -ano \| findstr :3080` → `taskkill /PID <PID> /F` (logs under `$DSH_HOME` as `dsh-pocket-restart-*.log`)                                                                                 |
| SSH tunnel won't connect (auth failure / port busy / 502)                       | The SSH block shows the raw "Last error" (e.g. `Permission denied (publickey)`, `remote port forwarding failed for listen port 7788`); walk the troubleshooting table in the [SSH penetration guide](docs/SSH-PENETRATION.md) (Chinese)                                                                                            |
| No "SSH" mode in the mode row                                                   | You're on an older plugin build (the third channel came later). Update and restart: `dsh plugin --profile web update dsh-pocket --latest -w` then restart `dsh web`                                                                                                                                                               |
| Cannot install to home screen / no install button                               | PWA install needs an **HTTPS hostname** (LAN `http://192.168.x.x` and bare IPs never work); on iOS use Safari → Share → Add to Home Screen; the button area prints the reason when it can't install                                                                                                                              |
| Push notifications never arrive                                                 | ① Click "Send a test notification" and read "Last push"; ② Android Web Push goes through Google services and may not arrive in mainland China → use a Webhook; ③ iOS needs 16.4+ **and** a home-screen install; ④ OS notification permission and battery savers can block it                                                            |
| Passkey registration fails / no passkey button                                  | Only **HTTPS + fixed hostname** (Named or SSH) is supported — Quick random URLs and LAN IPs are not; the "🔐 Passkey devices" switch must be on. On non-HTTPS the browser doesn't expose WebAuthn at all and the page says so                                                                                                     |
| Want to revoke a phone's password-free sign-in / clear push subscriptions       | Settings → Phone access → "🔐 Passkey devices" → "Revoke" that device (immediate; it must register again); "🔔 Notifications & PWA" → "Clear all subscriptions" clears push subscriptions                                                                                                                                         |

## ⚠️ Public tunnel troubleshooting (read first)

**Symptom**: after clicking "Enable anywhere", the public URL shows `error 1033` (Tunnel error) on the phone.

**Most common cause: a local proxy/VPN (Clash, Surge, v2ray, sing-box, etc., especially in TUN mode).**
Such tools take over all traffic and often cut cloudflared's tunnel-edge connections
(`*.argotunnel.com`, Cloudflare edge IPs), so the tunnel registers but the data plane never connects.

**Fix (try in order, lightest first)**:

1. First **just turn off the proxy's TUN mode** — no need to quit the proxy; this is enough in most cases:
   - Clash: turn off the "**TUN mode**" toggle in Settings (or right-click the menu-bar icon → uncheck TUN mode)
   - Surge: turn off "**Enhanced mode**"; v2ray/sing-box: turn off "**virtual NIC / route takeover**"
   - Then go back to the settings page and click "Enable anywhere" again
2. If that's not enough, temporarily **fully quit the proxy** (not just close the window: quit Clash from the menu-bar icon; if a
   background service is installed, stop it in the service manager and confirm with `ps aux | grep clash`), then retry.
3. Add **DIRECT rules** to the proxy for the tunnel domains and Cloudflare edge (Clash example):
   ```yaml
   - DOMAIN-SUFFIX,argotunnel.com,DIRECT
   - DOMAIN-SUFFIX,trycloudflare.com,DIRECT
   - IP-CIDR,198.41.192.0/24,DIRECT,no-resolve
   ```
4. If the network really can't reach the tunnel, use **LAN mode**: turn on the phone hotspot → connect the computer to it → scan the LAN QR. Same experience, from anywhere.

**Other causes**: corporate firewalls / campus networks blocking outbound — ask IT to allow it, or use a hotspot.

**First run: "Downloading cloudflared" fails or hangs**:

- **macOS/Linux**: the plugin first downloads from the **Tsinghua mirror** (measured ~3MB/s, done in seconds); falls back to official GitHub + acceleration mirrors if it fails.
- **Windows**: no Tsinghua mirror (Homebrew doesn't support Windows) — downloads the ~50MB exe from GitHub directly; **single-threaded, so it's slower — that's expected**, wait a few minutes, or use a proxy.
- If all sources fail, the settings page shows a hint. Alternatives (any one):

1. Install the `cloudflared` command and retry (the plugin then uses the PATH binary, no download):
   - macOS: `brew install cloudflared`; Linux: `sudo apt install cloudflared` or from the official site
   - Windows: `winget install cloudflared` or from the official site
   - Any platform: `npm i -g cloudflared`
2. Enable a proxy (system proxy / Clash etc.) and click "Enable anywhere" again
3. Manually download the binary into `$DSH_HOME/dsh-pocket/bin/` (`$DSH_HOME` is usually `~/.dsh`, on Windows `%USERPROFILE%\.dsh`; name it `cloudflared` (add `.exe` on Windows) **or** the release asset name — both are recognized)

## 🗂 Architecture (single package)

| File                 | Purpose                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/index.js`       | Plugin entry: auto-start proxy + register RPC + access-PIN management (public: 8 digits rotated per tunnel start; LAN: separate 8 digits, manually refreshable / switchable) + LAN access switch + DSH Desktop detection + notify hooks |
| `lib/settings.mjs`   | Settings persistence: LAN switches, public mode (quick / named / ssh), SSH parameters, notifications + Webhook, passkey switch — stored in `$DSH_HOME/dsh-pocket/settings.json` (0o600)                                       |
| `lib/service.mjs`    | Service: proxy lifecycle (port auto-fallback), public channel orchestration (cloudflared and SSH are mutually exclusive), auto-restore, status snapshot (with QR data URLs)                                                  |
| `lib/ssh.mjs`        | SSH reverse-tunnel core: argv construction (injection-guarded) + stderr classification (ready / fatal / retryable) + backoff reconnect + state machine                                                                      |
| `lib/ssh-channel.mjs`| SSH channel orchestration: config normalisation, `-R` forward, access-URL assembly (`accessProtocol` + `accessHost` + `accessPort`), one-shot "Test connection"                                                               |
| `lib/proxy.mjs`      | Header-rewriting reverse proxy: Host/Origin → loopback, HTTP + WebSocket passthrough + polyfill injection + gzip/brotli compression + per-host token auth + unauthenticated PWA assets + passkey/push HTTP endpoints          |
| `lib/pwa-assets.mjs` | PWA: web app manifest, service worker (install/activate/fetch/push/notificationclick), icons (base64 inlined, nothing written to disk)                                                                                       |
| `lib/push.mjs`       | Web Push: VAPID keys, RFC 8291 encryption and delivery (404/410 subscriptions are pruned automatically)                                                                                                                      |
| `lib/push-store.mjs` | Push subscriptions and VAPID key storage (`$DSH_HOME/dsh-pocket/push.json`, local-only)                                                                                                                                      |
| `lib/webhook.mjs`    | Webhook request construction and delivery for the six presets (DingTalk signing included)                                                                                                                                    |
| `lib/webauthn.mjs`   | Passkey verification: dependency-free CBOR decoding + ES256 verification + challenge/origin/rpId checks (single-use 5-minute challenges)                                                                                     |
| `lib/passkey-store.mjs`| Device credentials and tokens (`$DSH_HOME/dsh-pocket/passkeys.json`, hashes only, atomic 0o600 writes)                                                                                                                     |
| `lib/notify-hook.mjs`| Task-completion notifications: `turn/end` + agent-idle detection, sub-agent filtering, debounce, delivery and last results                                                                                                   |
| `lib/tunnel.mjs`     | cloudflared: multi-mirror download (Tsinghua first) / adaptive parallel / start / parse public URL (HTTP/2)                                                                                                                  |
| `lib/web-rpc.js`     | Loopback RPC: `status` / `tunnel.*` / `lan.*` / `ssh.*` / `notify.*` / `passkey.*` / `version` / `update` / `restart`                                                                                                        |
| `client/`            | "Phone access" settings tab (three channels + PWA/notifications + passkey devices) + mobile adaptation (dsh-web-mobile port)                                                                                                 |
| `bin/dsh-pocket.mjs` | CLI: LAN/public modes, prints URL + QR                                                                                                                                                                                       |

## 🛠 Development

```sh
npm install
node client/build.mjs   # rebuild after editing client/
npm test                # proxy / auth / tunnel / SSH / push / passkeys / settings — full suite
```

**Want to try your changes locally without publishing?** Point the installed plugin at your local checkout with a symlink and restart dsh web. Full steps (including switching back to the npm release) are in [LOCAL-DEV.md](./LOCAL-DEV.md).

## 🤝 Credits

- Mobile adaptation ported from [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) (MIT)
- Public tunnel powered by [cloudflared](https://github.com/cloudflare/cloudflared)

## 📄 License

[GPL-2.0](LICENSE) — copyleft: free to use, modify, and redistribute, but **derivatives must stay GPL** and keep the copyright notice; commercial use included.

> Note: the mobile-adaptation portion is ported from [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) (MIT, GPL-compatible); its copyright notice stays in `client/mobile/LICENSE.dsh-web-mobile`.

---

**Questions? Feedback welcome**: bugs, ideas, or feature requests — open an issue at [GitHub Issues](https://github.com/shaobeichen/dsh-pocket/issues) 🙏
