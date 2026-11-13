/**
 * 把整个工程打成**一个 exe**（Windows 单文件）。
 *
 * ## 产物形态
 *
 * `dist/codearts2api-<版本>-win-x64.exe` —— 双击即用的绿色单文件：内部自带
 * Node 运行时与全部依赖，首次运行自解包到 `%LOCALAPPDATA%\codearts2api\runtime\<构建号>`，
 * 之后直接复用（按内容哈希分目录，升级不会读到上一版的半旧依赖）。
 *
 * 运行期**不依赖**用户机器上装没装 Node、装没装 pnpm —— 这正是「封装成一个 exe」的要点。
 *
 * ## 为什么不是 Node SEA
 *
 * 运行期有两个**原生模块**必须真实存在于磁盘：
 * `@img/sharp-win32-x64`（附件服务的图片校验/缩放）与
 * `@wreq-js/binding-win32-x64-msvc`（OpenCode 通道的 TLS 指纹）。
 * Node 的单可执行文件（SEA）只内联 JS 与静态资产，`.node` 仍要从磁盘 `require`，
 * 所以只能走「自解压 + 拉起 node」。细节见 `packaging/launcher/main.go`。
 *
 * ## 三步
 *
 * ① 备料 `packaging/stage/` —— 源码 + `public/` + **生产依赖**（`pnpm install --prod`，
 *    hoisted 布局，避免符号链接） + `node.exe`；
 * ② 压缩成 `packaging/launcher/payload.zip`（Node 没有内置 zip 写入，用 .NET 的
 *    `ZipFile`，并把条目顺序固定，保证**同样输入得到同样产物**）；
 * ③ `go build` 编译启动器，载荷用 `go:embed` 内联进去，构建号经 `-ldflags -X` 注入。
 *
 * ## 环境变量（都可省，省了走默认）
 *
 * | 变量 | 用途 | 默认 |
 * | --- | --- | --- |
 * | `BUILD_NODE_EXE` | 打进包里的 node.exe | 当前进程的 `execPath` |
 * | `BUILD_PNPM` | 装生产依赖用的 pnpm 入口 | PATH 上的 `pnpm` |
 * | `BUILD_GO` | Go 编译器 | PATH 上的 `go` |
 * | `BUILD_OFFLINE` | 置 1 则跳过依赖安装，只用现有 `packaging/stage/node_modules` | 关 |
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { deflateRawSync } from "node:zlib"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const packagingDir = join(root, "packaging")
const launcherDir = join(packagingDir, "launcher")
const stageDir = join(packagingDir, "stage")
const appDir = join(stageDir, "app")
const payloadPath = join(launcherDir, "payload.zip")
const distDir = join(root, "dist")

/**
 * 打包进 exe 的源码/资源。
 *
 * 除源码与前端产物外，**必须**带上两个 pnpm 文件：
 *   - `pnpm-lock.yaml`：生产安装要 `--frozen-lockfile`，否则每次打出来的依赖版本可能不同；
 *   - `pnpm-workspace.yaml`：`allowBuilds`（放行上游 git 依赖的 prepare）与
 *     `nodeLinker: hoisted` 都在这里，缺了它依赖根本装不上。
 */
const APP_ENTRIES = ["src", "public", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]

/** 运行期用不到、但会被装进 stage 的东西 —— 剔掉能省体积。 */
const PRUNE_FROM_NODE_MODULES = [
  // pnpm 自己的记账文件；运行期不读。
  ".modules.yaml",
  ".pnpm-workspace-state-v1.json",
]

const log = (message) => console.log(`[build-exe] ${message}`)

/** 执行外部命令，失败即抛出（保持 stderr 可见，便于定位）。 */
function run(file, args, options = {}) {
  return execFileSync(file, args, { stdio: "inherit", cwd: root, ...options })
}

/** 递归列出目录下所有文件（返回相对 app 的 POSIX 风格路径）。 */
function listFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"))
  }
  return out
}

// ─────────────────────────── ① 备料 ───────────────────────────

/** 校验 `public/` 的前端产物在不在（缺了界面会白屏，且是静默的）。 */
function assertFrontendBuilt() {
  for (const file of ["admin.js", "upstream-jet-hub.js", "admin.html"]) {
    const full = join(root, "public", file)
    if (!existsSync(full)) {
      throw new Error(`缺少前端产物 public/${file} —— 先跑 pnpm run build（它会生成 admin.js / upstream-jet-hub.js）。`)
    }
  }
}

/** 把工程源码与前端产物拷进 stage。 */
function copyApp() {
  rmSync(appDir, { recursive: true, force: true })
  mkdirSync(appDir, { recursive: true })
  for (const entry of APP_ENTRIES) {
    cpSync(join(root, entry), join(appDir, entry), { recursive: true })
  }
}

/**
 * 装生产依赖（hoisted：产物里不留符号链接，解包后到处都能跑）。
 *
 * ⚠️ Windows 上 `pnpm` 是 `.cmd` shim，`execFileSync` **不会**自己补 `.cmd` 后缀、
 * 也不能直接执行 `.cmd`（报 ENOENT / EINVAL）。所以这里统一走 `shell: true`，
 * 让 cmd.exe 去解析 —— `pnpm` 在 PATH 上就行，也是用户最自然的用法。
 */
function installProductionDeps() {
  const pnpm = process.env.BUILD_PNPM ?? "pnpm"
  log(`安装生产依赖（${pnpm} install --prod）…`)

  // nodeLinker 交给 pnpm-workspace.yaml 里的配置行，这里不再重复传参 ——
  // 上游 git 依赖的 prepare 会自己跑一次 pnpm install，配置行对那次同样生效。
  const workspaceFile = join(appDir, "pnpm-workspace.yaml")
  const workspace = readFileSync(workspaceFile, "utf8")
  if (!workspace.includes("nodeLinker:")) {
    writeFileSync(
      workspaceFile,
      `${workspace.trimEnd()}\n\n# 打包用：hoisted 不留符号链接，解包后可直接运行。\nnodeLinker: hoisted\n`,
    )
  }

  run(`"${pnpm}" install --prod --frozen-lockfile`, [], {
    cwd: appDir,
    shell: true,
    env: { ...process.env, PNPM_CONFIG_MINIMUM_RELEASE_AGE: "0" },
  })
}

/** 放入 node.exe —— 用户机器上不需要装 Node。 */
function copyNodeRuntime() {
  const source = process.env.BUILD_NODE_EXE ?? process.execPath
  if (!existsSync(source)) throw new Error(`找不到 node.exe：${source}`)
  cpSync(source, join(appDir, "node.exe"))
  log(`已打入 Node 运行时：${source}（${(statSync(source).size / 1024 / 1024).toFixed(1)} MB）`)
}

/** 删掉运行期用不到的小文件（体积无关紧要，但能少一批噪声条目）。 */
function pruneNodeModules() {
  for (const name of PRUNE_FROM_NODE_MODULES) {
    rmSync(join(appDir, "node_modules", name), { force: true })
  }
}

// ─────────────────────────── ② 压缩 ───────────────────────────

/**
 * 打载荷 zip。
 *
 * ## 为什么自己写 ZIP，而不是调 `Compress-Archive` / .NET
 *
 * 本机只有 Windows PowerShell 5.1（没有 `pwsh`），而 `.NET` 的 `ZipFile` 在那上面
 * 要先 `Add-Type` 加载程序集、行为还随版本变；`Compress-Archive` 更慢且对空目录
 * 的处理不一致。ZIP 的存储格式很简单，自己写反而**少一个外部依赖、且完全可控**：
 * 条目顺序固定、时间戳固定 ⇒ 同样输入得到同样产物，exe 的哈希可复现。
 *
 * 只用 deflate（ZIP 的 method 8，即 zlib 的 raw deflate），压缩后反而变大时退回
 * 存储（method 0）—— 对已经压过的二进制（`.node` / `.wasm`）这点很常见。
 */
function createPayloadZip() {
  const files = listFiles(appDir).sort()
  const chunks = []
  const central = []
  let offset = 0

  for (const name of files) {
    const data = readFileSync(join(appDir, name))
    const nameBytes = Buffer.from(name, "utf8")
    const deflated = deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    // 固化时间戳（1980-01-01，DOS 格式的最小合法值）—— 让产物可复现。
    const dosTime = 0
    const dosDate = 33

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6) // bit 11：文件名是 UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBytes, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4) // 制作版本
    entry.writeUInt16LE(20, 6) // 解压所需版本
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10)
    entry.writeUInt16LE(dosTime, 12)
    entry.writeUInt16LE(dosDate, 14)
    entry.writeUInt32LE(crc32(data), 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const centralBuffer = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)

  writeFileSync(payloadPath, Buffer.concat([...chunks, centralBuffer, eocd]))
  const size = statSync(payloadPath).size
  log(
    `载荷：${(size / 1024 / 1024).toFixed(1)} MB（未压缩 ${(du(appDir) / 1024 / 1024).toFixed(1)} MB，${files.length} 个文件）`,
  )
}

/** 目录总大小（字节）。 */
function du(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += du(full)
    else if (entry.isFile()) total += statSync(full).size
  }
  return total
}

/** CRC-32 查表（ZIP 每个条目都要，Node 没内置）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value
  }
  return table
})()

/** 计算一段字节的 CRC-32。 */
function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/**
 * 计算载荷指纹 —— 用作解包目录名与 exe 里的构建号。
 *
 * 取**压缩后内容**的哈希：它同时覆盖了源码、依赖与 node.exe，升级任何一个都会换目录。
 */
function payloadFingerprint() {
  return createHash("sha256").update(readFileSync(payloadPath)).digest("hex").slice(0, 12)
}

// ─────────────────────────── ③ 编译启动器 ───────────────────────────

/** 编译 Go 启动器，产出最终的 exe。 */
function buildLauncher(buildID) {
  const go = process.env.BUILD_GO ?? "go"
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0"
  const outfile = join(distDir, `codearts2api-${version}-win-x64.exe`)
  mkdirSync(distDir, { recursive: true })
  rmSync(outfile, { force: true })

  const env = {
    ...process.env,
    GOOS: "windows",
    GOARCH: "amd64",
    // 构建缓存都放在本工程内，不污染用户全局 GOPATH/GOCACHE。
    GOPATH: process.env.GOPATH ?? join(packagingDir, ".gopath"),
    GOCACHE: process.env.GOCACHE ?? join(packagingDir, ".gocache"),
    CGO_ENABLED: "0",
  }

  log("编译启动器（go build）…")
  try {
    // ⚠️ `-H windowsgui` 是「不要黑框」的关键：默认（console 子系统）双击后会先弹一个
    //    cmd 窗口，既难看又会在程序退出时闪一下。改成 GUI 子系统后就没有控制台窗口了。
    //    代价是 stdout/stderr 无处可写 —— 由 `logging_windows.go` 把输出接到日志文件、
    //    并用原生消息框报告致命错误来补上。
    run(go, ["build", "-trimpath", "-ldflags", `-s -w -H windowsgui -X main.buildID=${buildID}`, "-o", outfile, "."], {
      cwd: launcherDir,
      env,
    })
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `找不到 Go 编译器（${go}）。打包 exe 需要 Go 1.22+：装上后确保 go 在 PATH 上，` +
          `或用 BUILD_GO=<go.exe 的完整路径> 指定。`,
        { cause: error },
      )
    }
    throw error
  }
  return outfile
}

// ─────────────────────────── 主流程 ───────────────────────────

log(`工程根目录：${root}`)
assertFrontendBuilt()

/**
 * 刷新 stage 里的源码与 node.exe，但**保留**已装好的 `node_modules`。
 *
 * ⚠️ 这是 `BUILD_OFFLINE=1` 的关键语义：只跳过「联网装依赖」这一步。
 * 早先它连源码拷贝一起跳过了 —— 结果改完 `src/` 重新打包，载荷里还是**旧代码**
 * （构建号不变就是征兆）。源码永远要重拷，那是这个脚本唯一不能省的事。
 */
function refreshAppSources() {
  mkdirSync(appDir, { recursive: true })
  for (const entry of APP_ENTRIES) {
    rmSync(join(appDir, entry), { recursive: true, force: true })
    cpSync(join(root, entry), join(appDir, entry), { recursive: true })
  }
}

if (process.env.BUILD_OFFLINE === "1") {
  log("BUILD_OFFLINE=1：跳过依赖安装，只刷新源码与运行时（复用现有 stage/node_modules）")
  if (!existsSync(join(appDir, "node_modules")))
    throw new Error("BUILD_OFFLINE=1 但 packaging/stage/app/node_modules 不存在")
  refreshAppSources()
  copyNodeRuntime()
} else {
  copyApp()
  installProductionDeps()
  copyNodeRuntime()
}
pruneNodeModules()

// 载荷里塞的是源码与依赖，静态检查一下别把 node_modules 落下。
if (!existsSync(join(appDir, "node_modules", "dsh-providers-hub", "lib", "index.js"))) {
  throw new Error("stage 里没有 dsh-providers-hub 的运行期产物 —— 生产依赖装失败了？")
}

createPayloadZip()
const buildID = payloadFingerprint()
const exe = buildLauncher(buildID)

log(`完成：${exe}`)
log(`      大小 ${(statSync(exe).size / 1024 / 1024).toFixed(1)} MB，构建号 ${buildID}`)
log(`      文件数 ${listFiles(appDir).length}`)
