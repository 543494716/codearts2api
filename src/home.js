/**
 * state home 解析 —— **本项目自己的目录**，不跟随外层 DSH。
 *
 * ## 为什么必须与 DSH 隔离（真实故障）
 *
 * 本程序是**独立网关**，不是 DSH 的一部分。第一版错误地沿用了插件的判据
 * （`DSH_HOME` → `~/.dsh`），于是在一台装过 DSH 的机器上：
 *
 * - 外层 shell 早就设了 `DSH_HOME=/Users/<user>/.dsh`（DSH 自己导出给子进程的），
 *   本程序**继承**了它，把账号池、凭据、网关 Key 全写进了 DSH 的目录；
 * - 两套程序共用一个目录，却又各有各的文件格式（本程序当时写
 *   `jet-hub/credentials.json`，DSH 写 `.credentials.yaml`）——
 *   结果是**账号列表读得到（state.json 格式一致），但每条凭据都读不到**，
 *   界面上表现为「积分/余额一直提示凭据未配置」，且两端会互相覆盖状态。
 *
 * 因此这里**不再读取**外层 `DSH_HOME`，而是把它**覆盖**成我们自己的目录：
 * 插件内部所有落盘点（`resolveJetHubHome` / opencode 能力表缓存 / 网关密钥）
 * 都读 `DSH_HOME`，所以「设置它」是让插件乖乖待在自家目录的唯一办法。
 *
 * ## 优先级
 *
 * 1. `CODEARTS2API_HOME` —— 本程序自己的变量（容器里指向挂载卷）；
 * 2. `~/.codearts2api` —— 默认固定路径；
 * 3. 默认路径**写不进去时**，按顺序回退到可写位置（见 {@link resolveWritableHome}）。
 *
 * ⚠️ 默认值刻意**不用 cwd 相对路径**：那样换一个工作目录启动就会读到另一份
 * 账号数据，是极难排查的「账号怎么没了」。
 */

import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"

/** 本程序默认的状态目录名（放在用户主目录下）。 */
export const DEFAULT_HOME_DIR = ".codearts2api"

/**
 * 解析本程序的状态目录（**不含可写性判断**）。
 *
 * @param env - 进程环境变量（便于单测注入）。
 * @returns 绝对路径。
 */
export function resolveHome(env = process.env) {
  const configured = env.CODEARTS2API_HOME
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim()
  return join(homedir(), DEFAULT_HOME_DIR)
}

/**
 * 探测某个目录是否**真的能写**（建目录 + 落一个探针文件再删掉）。
 *
 * ## 为什么要真写一次，而不是只看 `accessSync(W_OK)`
 *
 * 真实故障：`~/.codearts2api` 的 ACL 看起来完全正常（属主完全控制），
 * 权限位检查也判定可写，但 Node 实际 `open()` 时仍返回 `EPERM` ——
 * 触发者可能是安全软件的「受控文件夹访问」、组策略对漫游配置目录的重定向，
 * 或某些沙箱对特定进程树的拦截。这类限制**只有真写一次才暴露得出来**，
 * 权限位检查会给出假阳性。
 *
 * @returns 可写则 `true`。
 */
export function isWritableDirectory(directory) {
  const probe = join(directory, `.write-probe-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(probe, "probe", { flag: "w" })
    rmSync(probe, { force: true })
    return true
  } catch {
    try {
      rmSync(probe, { force: true })
    } catch {
      // 清理失败无所谓：探针本身就是可丢弃的。
    }
    return false
  }
}

/**
 * 挑一个**确实可写**的状态目录。
 *
 * ## 为什么需要回退链（真实故障）
 *
 * 单文件 exe 双击运行时，`~/.codearts2api` 在少数机器上写不进去（`EPERM`），
 * 于是启动即崩、且当时的报错只说「端口可能被占用」—— 用户完全无从下手。
 * 与其让程序死在「默认位置不可写」上，不如换一个能写的地方继续工作，
 * 并把实际使用的位置**明确打印出来**，让用户知道数据落在哪。
 *
 * 顺序：显式指定 → 用户主目录 → exe 同级 `data/` → `%LOCALAPPDATA%` → 临时目录。
 *
 * @param env - 进程环境变量。
 * @param executableDirectory - exe 所在目录（便携兜底用）。
 * @returns `{ home, fellBack, explicit }`。
 */
export function resolveWritableHome(env = process.env, executableDirectory = process.cwd()) {
  const configured = env.CODEARTS2API_HOME
  if (typeof configured === "string" && configured.trim().length > 0) {
    // 用户显式指定：**不做回退**。他明确要求放这里，换地方会让人找不到数据；
    // 写不进去就该失败并报清楚，而不是悄悄换一个同样难找的位置。
    return { home: configured.trim(), fellBack: false, explicit: true }
  }

  const primary = join(homedir(), DEFAULT_HOME_DIR)
  if (isWritableDirectory(primary)) return { home: primary, fellBack: false, explicit: false }

  const fallbacks = [
    join(executableDirectory, "data"),
    join(env.LOCALAPPDATA ?? dirname(homedir()), "codearts2api"),
    join(tmpdir(), "codearts2api"),
  ]
  for (const candidate of fallbacks) {
    if (isWritableDirectory(candidate)) return { home: candidate, fellBack: true, explicit: false }
  }

  // 全都不行：仍然返回默认位置，让上层抛出**指向真实原因**的错误，
  // 而不是在这里静默换一个同样不可写的地方。
  return { home: primary, fellBack: false, explicit: false }
}

/**
 * 把状态目录**钉进环境变量**，让插件与网关都落在自家目录里。
 *
 * ## 为什么要写两个变量
 *
 * 插件里不同的落盘点读的是**不同的**变量，少写一个就会有文件漏到 DSH 目录：
 *
 * | 消费者 | 读的变量 |
 * | --- | --- |
 * | `resolveJetHubHome()`（账号池 / 锁定表 / 偏好 / 签到 / 网关密钥） | `DSH_JET_HUB_STATE_DIR` **优先**，其次 `DSH_HOME` |
 * | `opencode-capability.ts` 的能力表缓存 | `DSH_HOME` |
 *
 * `DSH_JET_HUB_STATE_DIR` 优先级更高，故两个都要设：只设 `DSH_HOME` 时，
 * 用户 shell 里若残留一个 `DSH_JET_HUB_STATE_DIR`（DSH 的测试/多实例开关），
 * 账号池就会写到那个目录，而缓存落到另一个目录 —— 又是「一半对一半错」。
 *
 * @returns 解析出的绝对路径。
 */
export function pinHome(env = process.env) {
  const home = resolveHome(env)
  env.DSH_HOME = home
  env.DSH_JET_HUB_STATE_DIR = home
  return home
}

/**
 * 钉住**可写**的状态目录（启动入口用这个）。
 *
 * 与 {@link pinHome} 的差别只有一点：默认位置写不进去时会回退到可写位置，
 * 并把结果写回 `env.CODEARTS2API_HOME`，保证后续所有落盘点看到同一个目录。
 *
 * @returns `{ home, fellBack, explicit }`。
 */
export function pinWritableHome(env = process.env, executableDirectory = process.cwd()) {
  const resolved = resolveWritableHome(env, executableDirectory)
  env.CODEARTS2API_HOME = resolved.home
  env.DSH_HOME = resolved.home
  env.DSH_JET_HUB_STATE_DIR = resolved.home
  return resolved
}
