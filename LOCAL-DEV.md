# 本地联调（开发软链）

改完代码想在本机 dsh web 里直接验证，**不用发版**——把已安装的插件换成指向本地仓库的软链即可。

原理：dsh 的插件装在 profile 的 `node_modules` 里（pnpm 软链），我们把它重新指向本地仓库目录，dsh web 重启后就加载本地代码。

---

## 一、建立软链（只需做一次）

```sh
# 插件安装位置：$DSH_HOME/profiles/web/node_modules/dsh-pocket（默认 $DSH_HOME=~/.dsh）
# 若你改过 DSH_HOME，把下面的 ~/.dsh 换成实际路径
cd ~/.dsh/profiles/web/node_modules

rm dsh-pocket
ln -s /你的/仓库/绝对路径/dsh-pocket dsh-pocket

# 确认
ls -l dsh-pocket
# dsh-pocket -> /你的/仓库/绝对路径/dsh-pocket
```

桌面版 profile 同理，把路径里的 `web` 换成 `desktop` 即可。

## 二、日常改代码流程

| 改了哪里 | 要做什么 |
| --- | --- |
| `lib/**`（后端） | 直接重启 dsh web 生效 |
| `client/**`（前端源码） | 先 `node client/build.mjs` 打包，再重启 dsh web |

```sh
node client/build.mjs     # 只改后端可跳过
npm test                  # 建议顺手跑一遍（全量用例，数量看运行输出的 ℹ tests）
```

### 重启 dsh web

直接 `kill` 后用 `nohup` 拉起**会被终端会话回收**，必须用 detached 方式（和插件自带的自重启同一套做法）：

```sh
# 1) 停掉当前 dsh web
kill $(lsof -ti :3080 -sTCP:LISTEN)

# 2) detached 重新拉起（日志在 /tmp/dsh-web-dev.log）
node -e "
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const out = fs.openSync('/tmp/dsh-web-dev.log', 'a');
const err = fs.openSync('/tmp/dsh-web-dev.log', 'a');
spawn('$(command -v dsh)', ['web'], {
  detached: true, stdio: ['ignore', out, err], env: process.env, cwd: process.env.HOME,
}).unref();
"

# 3) 等服务起来
curl -s -o /dev/null -w "3080:%{http_code}\n" http://127.0.0.1:3080/   # dsh web
curl -s -o /dev/null -w "3081:%{http_code}\n" http://127.0.0.1:3081/   # dsh-pocket 代理
```

## 三、确认加载的确实是本地代码

> ⚠️ **不要再用 `shasum -a 1 client/client.js` 去比 `rev`**：那是旧版 DSH 的行为。DSH 0.1.7-rc.2 里
> `rev` 由 `@deepseek-ai/dsh-client-modules` 的 `artifactRevision()` 生成 —— 它对**文件元数据**
> （`mtimeMs` / `ctimeMs` / `size`，长度前缀拼接后再 sha1，取前 12 位）取哈希，**不是内容哈希**。
> 结论：内容没变、只是重新打包（mtime 变了）rev 也会变；内容变了但元数据恰好没变则不会变。拿它当「内容指纹」会误判。

正确做法是**逐字节比对**：把页面实际引用的那份 `client.js` 抓下来，看它是否包含本地文件的完整内容。
请在**仓库根目录**执行（脚本按相对路径读 `client/client.js`）：

```sh
node --input-type=module -e "
const base = 'http://127.0.0.1:3080';
const { readFileSync } = await import('node:fs');
const local = readFileSync('client/client.js', 'utf8');
let html;
try {
  html = await (await fetch(base + '/')).text();
} catch (err) {
  console.log('连不上 ' + base + '（' + (err?.cause?.code ?? err?.message ?? err) + '）—— dsh web 没起来？'); process.exit(1);
}
const tokens = html.split(/[\s<>()\u0022\u0027]+/).filter((s) => s.length > 0); // 按空白/引号/尖括号切词（\u0022 是双引号、\u0027 是单引号，免得和 shell 的引号打架）
const refs = [...new Set(tokens.filter((u) => u.includes('client.js') && u.includes('rev=') && u.includes('dsh-pocket')))];
if (refs.length === 0) { console.log('页面里没有 dsh-pocket/client.js 引用 —— 插件没加载成功？'); process.exit(1); }
for (const ref of refs) {
  const url = new URL(ref, base + '/');
  const served = await (await fetch(url)).text();
  const hit = served.includes(local);
  console.log((hit ? 'OK   ' : 'MISS ') + url.pathname + url.search + '  served=' + served.length + 'B');
}
console.log('本地 client/client.js = ' + local.length + 'B；出现 OK 且路径含 dsh-pocket = 本地代码已生效');
"
```

说明：

- 用 `includes` 而不是 `===`：DSH 会在 chunk 末尾追加一行 `//# sourceMappingURL=client.js.map?rev=…`，
  所以 `served` 会比本地文件大几十字节（实测：本地 190338B → served 190391B）；
- DSH 0.1.7-rc.2 的引用既可能是 `/plugins/dsh-pocket/client.js?rev=…`，也可能是 `/plugins/??dsh-pocket/client.js,…&rev=…`
  这种组合资源，所以脚本按「含 `client.js` + `rev=` + `dsh-pocket`」筛选，两种都能抓到；
- **MISS = 页面加载的不是这份产物**：最常见就是改完 `client/` 忘了 `node client/build.mjs`，或者 dsh web 没重启成功
  （看 `/tmp/dsh-web-dev.log`）。这条比旧的 rev 比对更直接：它比的是内容本身。

**这段脚本在哪些 shell 里能直接粘贴**（作者实测记录）：

- **PowerShell 7（Windows）**：上面这段**实测通过**。实测输出（尺寸随版本变化，只看 OK/MISS）：
  ```
  OK   /plugins/dsh-pocket/client.js?rev=111111111111  served=190391B
  本地 client/client.js = 190338B；出现 OK 且路径含 dsh-pocket = 本地代码已生效
  ```
  反例（服务器上还是旧产物时会打印，用于自检脚本本身）：`MISS /plugins/dsh-pocket/client.js?rev=…  served=…`；
  dsh web 没跑时：`连不上 http://127.0.0.1:3080（ECONNREFUSED）—— dsh web 没起来？`（退出码 1）。
- **bash / zsh**：同一行**按引号规则可直接用**——脚本体内没有 `$`、反引号或双引号，
  双引号外层不会被提前闭合（`\s`、`\u0022`、`\u0027` 在双引号里按字面传递）。但作者只在 Windows PowerShell 下实测过，
  这里如实标注；若你的 shell 在转义上较真，用下面的文件写法，任何 shell 都稳：

  把 `-e "` 与结尾 `"` 之间的内容存成文件（例如仓库根目录的 `dev-check-client.mjs`），然后：

  ```sh
  node dev-check-client.mjs     # 用完删掉即可，不要提交
  ```

## 四、换回 npm 官方版本

```sh
dsh plugin --profile web add dsh-pocket -w
```

重装会把软链换回 pnpm 的正式安装：

```sh
ls -l ~/.dsh/profiles/web/node_modules/dsh-pocket
# dsh-pocket -> .pnpm/dsh-pocket@<版本>/node_modules/dsh-pocket
```

之后重启 dsh web 即可。

---

## 注意事项

- **软链期间，你日常用的 dsh web 跑的都是本地仓库代码**（包括未提交的改动），而别人通过 npm 装到的仍是发布版——两边互不影响。
- 本地仓库需要装过依赖（`npm install`），否则 `lib/` 用到的 `cordis` / `cosmokit` 等解析不到，插件会静默加载失败。
- 改完 `client/` 忘了打包，界面不会变（dsh web 加载的是 `client/client.js` 产物，不是 `index.jsx` 源码）。
- 电脑重启后自己正常启动 dsh web 即可，软链是持久的，仍然加载本地代码。

## 常见问题

**手机页面没变化**：多半是忘了 `node client/build.mjs`，或 dsh web 没重启成功（看 `/tmp/dsh-web-dev.log`）。

**代理端口 3081 起不来**：插件没加载成功。检查软链路径是否正确、仓库依赖是否装好；也可以 `curl -s http://127.0.0.1:3080/` 看返回的 HTML 里有没有 `dsh-pocket/client.js`。

**端口被占**：`lsof -ti :3080` 或 `lsof -ti :3081` 查占用进程；dsh-pocket 的代理在 3081 被占时会自动顺延到下一个端口。
