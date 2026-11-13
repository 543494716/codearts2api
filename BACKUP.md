# 源码备份说明

本仓库是 `codearts2api` 的**源码备份**（镜像），主开发仓库在本地。

## 加密包：`codearts2api-source.zip`

仓库根目录下的这个压缩包是**完整源码快照**（AES-256 加密）。

**密码：`123456`**

解开方式（任选其一）：

```bash
# 7-Zip
7z x codearts2api-source.zip -p123456

# Windows 资源管理器：双击 → 输入密码
# WinRAR / Bandizip：同样输入密码
```

### 为什么不直接提交源码而是加密包

包内含 `public/admin.js` 与 `public/upstream-jet-hub.js` —— 这两个文件是从上游
[`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub) 构建/拷贝出来的
浏览器产物，**上游 README 明确要求不要转发到 GitHub**。

因此本仓库采取折中：

- **明文部分**：只包含本仓库自己写的「薄胶水」源码（`src/`、`web/`、`packaging/`、
  `scripts/`、`tests/` 等），可直接阅读；
- **加密包**：包含完整可运行快照（含上游产物），供需要完整副本的人用密码解开。

> ⚠️ 这个密码只是「防止误转发」的轻量闸门，**不是机密保护**。请勿把它当作安全措施，
> 也不要在包内放置任何真实凭据 —— 事实上本包已排除全部凭据与密钥（见下）。

## 包里有什么 / 没有什么

**包含**：全部源码、测试、构建脚本、Go 启动器（`packaging/launcher/`）、
前端产物（`public/*.js`）、文档。

**不含**（刻意排除）：

| 排除项                                                          | 原因                           |
| --------------------------------------------------------------- | ------------------------------ |
| `node_modules/`                                                 | 体积大，`pnpm install` 可重建  |
| `dist/`、`packaging/stage/`、`payload.zip`                      | 构建产物，可与运行无关的重生成 |
| `.git/`                                                         | 避免历史重复                   |
| `.credentials.yaml`、`admin-key`、`caller-keys.json`、`api-key` | **凭据与密钥，绝不能进备份**   |
| `data/`、`attachments/`、`jet-hub/`                             | 运行时状态                     |

## 重新生成加密包

```bash
pip install pyzipper
python scripts/make-source-archive.py
```

产物默认写到 `dist/codearts2api-source.zip`，把它复制到仓库根目录即可提交。

## 相关文档

明文源码里的 `README.md`（使用说明）与 `AGENTS.md`（开发 / 部署 / 打包指南）
说明了这个项目做什么、怎么跑、以及单文件 exe 的打包方式。
