# codearts2api

把 [`dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub) 的
**Jet Hub 多渠道账号管理**与**本机 OpenAI 网关**搬到独立后端运行，**不依赖 DSH 宿主**，
面向自建服务与容器部署。

它不 fork 上游代码，而是直接把上游的插件装载起来 —— 所以**渠道、模型、协议、界面
都跟着上游走**，本项目自己只负责鉴权、状态隔离与对外接口。

<img width="1277" height="919" alt="总览界面" src="https://github.com/user-attachments/assets/b3fc1739-37b5-43b1-a927-78c4b706fec7" />

<img width="1920" height="1031" alt="Jet Hub 管理界面（上游设置页原样复用）" src="https://github.com/user-attachments/assets/0fc7e323-2830-49e0-898f-88e28c631a71" />

## 使用方法

### Windows 单文件 exe（免装 Node）

**推荐给不想装环境的人**：`dist/codearts2api-<版本>-win-x64.exe` 是**一个**文件，
内部自带 Node 运行时与全部依赖，**双击即用一个桌面窗口**（不跳浏览器、没有黑框）。

```
双击 codearts2api-0.1.0-win-x64.exe
→ 首次运行自解包（约 150 MB，几十秒）
→ 直接弹出应用窗口，标题形如「codearts2api · 管理后台 (127.0.0.1:8080)」
→ 默认密码 123456 登录
```

> ⚠️ **默认密码是公开的弱口令**，只为「双击就能进」的便利。后台能导出全部账号凭据、
> 明文取回网关 Key —— **公网可达的机器务必改掉**：设 `CODEARTS2API_ADMIN_KEY` 环境变量，
> 或改写 `<home>/admin-key` 后重启。启动日志每次都会提醒。

| 行为          | 说明                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| 窗口形态      | 原生窗口 + 系统 WebView2 承载 `/admin`；**没有黑框控制台**                                                  |
| 关闭窗口      | 服务随之停止（不会残留后台进程占端口）                                                                      |
| 无 WebView2   | 自动回退到默认浏览器打开，功能不受影响                                                                      |
| 日志          | `<解包目录>\.logs\launcher.log`（含 node 的报错，排查先看它）                                               |
| 启动失败      | 弹原生消息框说明原因（GUI 下不会静默消失）                                                                  |
| 解包位置      | `%LOCALAPPDATA%\codearts2api\runtime\<构建号>`；写不进去时自动退到临时目录，最坏退到 exe 同级目录           |
| 指定解包位置  | 设 `CODEARTS2API_RUNTIME_DIR=<目录>`（便携部署 / 多实例隔离用）                                             |
| 升级          | 直接换成新的 exe —— 构建号变了就用新目录，旧目录自动清理                                                    |
| 账号数据      | 仍在 `~/.codearts2api`（可用 `CODEARTS2API_HOME` 改），**与 exe 无关**，换 exe 不会丢账号                   |
| 端口 / 密钥等 | 与下面「本机直跑」完全一致：`PORT` / `HOST` / `PROXY_GATEWAY` / `CODEARTS2API_ADMIN_KEY` 等环境变量照旧生效 |

自身打这个 exe（**Windows**，需 Go 1.22+，打包时联网拉依赖）：

```bash
pnpm install
pnpm run build        # 先生成 public/admin.js 等前端产物
pnpm run build:exe    # 产出 dist/codearts2api-<版本>-win-x64.exe
```

> 打包器会把 `node.exe`、`src/`、`public/` 与**生产依赖**打进载荷（`packaging/stage/`，
> 已 gitignore），再用 Go 编译的自解压启动器内联成单文件。因为运行期有**原生模块**
> （`sharp`、`wreq-js`），这条路不是 Node SEA —— 细节见
> [`packaging/launcher/main.go`](packaging/launcher/main.go) 的文件头。

### Docker 部署

推荐用镜像跑。`CODEARTS2API_HOME=/data` 已由镜像设好并声明为 `VOLUME`，**不挂卷则容器
重建后账号会丢**。

```bash
docker pull ghcr.io/zhuweiyou/codearts2api:latest
docker run -d --name codearts2api \
  -p 8080:8080 \
  -v codearts2api-data:/data \
  ghcr.io/zhuweiyou/codearts2api:latest
```

也可以在仓库根目录自行构建：`docker build -t codearts2api .`，再把上面的镜像名换成
`codearts2api` 运行。

首次启动会把默认密码写入 `/data/admin-key`：

```bash
docker exec codearts2api cat /data/admin-key      # 默认是 123456
```

打开 `http://<主机>:8080/admin` 进入。管理接口自带鉴权，`-p 8080:8080` 不会把后台直接
暴露给公网；公网部署仍需自行终结 TLS（见 [`AGENTS.md`](AGENTS.md)）。

> ⚠️ **容器 / 公网部署必须先换掉默认密码**：加 `-e CODEARTS2API_ADMIN_KEY=<你自己的密钥>`，
> 否则任何知道默认值的人都能进后台。

### 本机直跑

**要求**：Node.js `^22.19.0 || >=24.0.0`（建议 24+），包管理器用 **pnpm 11**
（`corepack enable` 即可；项目已含 `pnpm-lock.yaml`）。

```bash
pnpm install
pnpm run build
pnpm start
```

启动后打开 <http://127.0.0.1:8080/admin>，**默认密码 `123456`**
（默认状态目录 `~/.codearts2api`，可用 `CODEARTS2API_HOME` 指定）。
首次启动会把默认密码写入 `<home>/admin-key`，改这个文件或设 `CODEARTS2API_ADMIN_KEY` 即可换掉。

### 管理界面

`/admin`（登录后）顶栏是三个一级页面：

- **总览**（默认首页）：网关状态、今日用量、近 14 日趋势、渠道账号与余额、积分收支、
  模型分布、自动签到；
- **渠道管理**：上游 Jet Hub 设置页原样复用 —— 左侧为各渠道，页头「网关」按钮可查看
  对外地址、复制 API Key 与模型清单；
- **调用方**：多把 Key 与分组授权（见下）。

顶栏右侧还有 **「回调修复」**（远程部署时第三方登录跳回 `127.0.0.1` 打不开，可让服务器
本机重放）与**主题切换**（跟随系统 / 浅色 / 深色）。

### 多把调用方 Key（分组授权）

默认只有一把网关 Key。要「按人发 Key、按人限模型、按人看用量」时，用顶栏「调用方」页：

- **一把 Key 一个人**，可单独停用 / 删除；
- **分组决定能调哪些模型**（白名单）；
- **用量按人按模型记账**，只记元数据，不落 prompt / 回复正文。

在「分组」页建分组、勾白名单，在「Key」页新建并发给对方（明文只显示一次）。
`<home>/caller-keys.json` 不存在时该功能不生效，删掉即回滚。

## API

### HTTP 接口

| 路径                                                                | 说明                                             |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /admin`                                                        | 管理界面（登录页 → 上游 Jet Hub 设置页）         |
| `POST /api/jet-hub`                                                 | Jet Hub 管理 RPC（上游实现原样透传，需管理密钥） |
| `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses` | OpenAI 兼容接口（上游网关，需网关 Key）          |
| `GET /healthz`                                                      | 健康检查（不含密钥，可给监控用）                 |

### 鉴权

两把钥匙，别混用：

| 密钥         | 位置                            | 给谁       | 权限                             |
| ------------ | ------------------------------- | ---------- | -------------------------------- |
| **管理密钥** | `<home>/admin-key`              | 只有你自己 | 进后台、改配置、导出全部账号凭据 |
| **网关 Key** | `<home>/openai-gateway/api-key` | 调用方     | 只能调 `/v1/*` 推理接口          |

**管理密钥默认是 `123456`**，首次启动写进 `<home>/admin-key`。要更换：改写该文件，或设
`CODEARTS2API_ADMIN_KEY` 环境变量（环境变量优先级更高）。

脚本 / curl 直接带 `Authorization: Bearer <admin-key>` 访问 `/api/jet-hub`。

### OpenAI 兼容接口

登录 `/admin` → 页头「网关」按钮 → 拿实际地址、API Key 与模型清单。客户端把 `base_url`
指向网关、`api_key` 填网关 Key。模型 ID 形如 `provider/模型名`（如
`codearts/deepseek-v4.1-flash`），**必须带渠道前缀**，可用模型以 `GET /v1/models` 为准。
支持 SSE 流式与 base64 内联图片输入。

### 聚合路由

| 路由                     | 行为                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `aggregate/<规范模型名>` | 把同一模型在各渠道的条目归一化，按额度临期顺序选号，失败时切换下一个候选 |
| `jet-hub-auto/auto`      | 在候选渠道中自动挑选可用者与模型                                         |

需先配置好对应渠道的账号，否则目录为空；可在 `/admin` 的「聚合 (跨渠道)」面板设置轮换。

---

🛠 完整的镜像标签、环境变量、状态目录、账号迁移、反向代理、安全边界、常见问题，以及
架构 / 测试 / 上游升级流程等开发内容，见 [`AGENTS.md`](AGENTS.md)。历次变更见
[`CHANGELOG.md`](CHANGELOG.md)。
