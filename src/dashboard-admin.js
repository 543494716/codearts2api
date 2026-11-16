/**
 * 总览看板 —— 后端聚合 + UI 脚本挂载。
 *
 * 用户约束（2026-11-02）：
 *   1. 不要独立 URL：不在 /admin 之外另开页面。看板以模态框形式活在 /admin 里，
 *      由注入的「总览」按钮唤起。因此本文件不提供页面端点。
 *   2. 主题与原生一致：UI 层全部复用上游 .dim-jh-modal / .dim-jh-btn 类名与
 *      var(--dsw-alias-*, 原生回退值)，不自己发明配色。
 *
 * 数据全部读本机文件，不向上游发请求（余额除外，有 5 分钟缓存 + 单飞）。
 */

import { readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const API_PATH = "/admin/dashboard/api"
export const UI_PATH = "/admin/dashboard-ui.js"

/** 余额缓存时长：5 分钟，避免多个浏览器窗口同时打上游。 */
const BALANCE_TTL_MS = 5 * 60 * 1000

/**
 * 读一个 JSON 文件；不存在或坏掉都返回 `undefined`（看板不该因为少一个文件 500）。
 *
 * ⚠️ 异步读：看板一次快照要读 5~6 个文件（含当日 300KB+ 的用量 JSONL），
 *    同步读会让整个进程在这段时间里停止响应 `/v1` 流式请求。
 */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

async function readJsonl(file) {
  let text
  try {
    text = await readFile(file, "utf8")
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
}

/** 按 UTC+8 取日期字符串。 */
function utc8Date(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function errorText(error) {
  const msg = error && error.message ? error.message : String(error)
  if (/unsupported provider/i.test(msg)) return "该渠道不支持余额查询"
  return msg
}

function normalizeExpiry(v) {
  if (v === undefined || v === null || v === "" || v === 0) return undefined
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}

/**
 * 创建聚合器。
 *
 * 参数是 dataDir，它本身就是 .../data（即 host.home）。
 * 不要在它下面再 join("data")，否则读到不存在的 data/data/*，
 * 症状是接口 200 但所有区块空白 —— 极难排查。
 *
 * @param {{dataDir: string, rpc: (method: string, payload?: object) => Promise<any>, gateway?: () => object, logger?: object}} deps
 */
export function createDashboard(deps) {
  const dataDir = deps.dataDir
  const jetHub = join(dataDir, "jet-hub")
  const usageDir = join(dataDir, "caller-usage")

  let balanceCache = { at: 0, value: undefined }
  let balanceInflight = null

  /** 余额：逐渠道串行调用 credits.balances（传数组会报 unsupported provider: undefined）。 */
  async function balances(providers, fresh) {
    if (!fresh && balanceCache.value !== undefined && Date.now() - balanceCache.at < BALANCE_TTL_MS) {
      return { value: balanceCache.value, cachedAt: balanceCache.at }
    }
    if (balanceInflight) {
      const value = await balanceInflight
      return { value, cachedAt: balanceCache.at }
    }
    balanceInflight = (async () => {
      const out = {}
      for (const provider of providers) {
        try {
          out[provider] = await deps.rpc("credits.balances", { provider })
        } catch (error) {
          out[provider] = { error: errorText(error) }
        }
      }
      balanceCache = { at: Date.now(), value: out }
      return out
    })()
    try {
      const value = await balanceInflight
      return { value, cachedAt: balanceCache.at }
    } finally {
      balanceInflight = null
    }
  }

  function accountsOf(state) {
    const raw = state && state.accounts
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : []
    return list.map((a) => {
      const expiresAt = normalizeExpiry(a.expiresAt)
      const nowMs = Date.now()
      const msLeft = expiresAt === undefined ? undefined : expiresAt - nowMs
      /* 天数是「向下取整」的粗粒度，不到 24 小时一律显示 0 天，红点 + 「0 天」
         看不出是「1 小时后过期」还是「已经过期」。2026-11-02 实测 codearts 只剩
         1.13 小时、minimax 只剩 16.7 分钟，面板都显示「0 天」。小于 2 天时改成
         显示小时/分钟，让人能判断「要不要现在处理续期」。 */
      const daysLeft = msLeft === undefined ? undefined : Math.floor(msLeft / 86400000)
      let expiryText
      if (msLeft === undefined) expiryText = undefined
      else if (msLeft <= 0) expiryText = "已过期"
      else if (msLeft < 2 * 86400000) {
        const hours = Math.floor(msLeft / 3600000)
        if (hours >= 1) expiryText = hours + " 小时"
        else expiryText = Math.max(1, Math.floor(msLeft / 60000)) + " 分钟"
      } else expiryText = daysLeft + " 天"
      /* modelRateLimits 是 { modelId: 重置时间戳(ms) }，而**上游从不清理过期键**
         （实测 trae-9cc67abb 只剩 kimi-k3.1-pro=1793311127621 已过期、qodercn 残留
         7 条里只有 1 条还在有效期内）。按 Object.keys().length 直接计数会把过期
         残留算成「N 模型限流」，面板就会长期挂着一条假的告警 —— 用户 2026-11-02
         报「显示 1 模型限流」，实际当下是正常的。所以必须先按 now 过滤。 */
      const rl = a.modelRateLimits
      const now = Date.now()
      const rlItems =
        rl && typeof rl === "object"
          ? Object.keys(rl)
              .map((model) => ({ model, until: Number(rl[model]) }))
              .filter((x) => Number.isFinite(x.until) && x.until > now)
          : []
      const rateLimited = rlItems.length
      const rateLimitedModels = rlItems
        .sort((x, y) => x.until - y.until)
        .map(
          (x) =>
            x.model +
            " · 到 " +
            new Date(x.until).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
        )
        .join("、")
      return {
        id: a.id,
        provider: a.provider,
        nickname: a.nickname,
        enabled: a.enabled !== false,
        refreshable: a.refreshable === true,
        createdAt: a.createdAt,
        expiresAt,
        daysLeft,
        expiryText,
        credential: a.credentialRef ? "已配置" : "未配置",
        rateLimited,
        rateLimitedModels,
      }
    })
  }

  async function collectUsage(today) {
    let files
    try {
      files = (await readdir(usageDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    } catch {
      files = []
    }

    const byDate = new Map()
    for (const f of files) {
      const date = f.slice(0, 10)
      const agg = { date, requests: 0, ok: 0, errors: 0, inTokens: 0, outTokens: 0, models: {}, callers: {} }
      for (const r of await readJsonl(join(usageDir, f))) {
        agg.requests += 1
        if ((r.status === undefined ? 200 : r.status) < 400) agg.ok += 1
        else agg.errors += 1
        // in_tokens 可能为 null，必须 or 0
        agg.inTokens += r.in_tokens || 0
        agg.outTokens += r.out_tokens || 0
        const model = String(r.model || "?")
        agg.models[model] = (agg.models[model] || 0) + 1
        const caller = String(r.caller || "?")
        agg.callers[caller] = (agg.callers[caller] || 0) + 1
      }
      byDate.set(date, agg)
    }

    // 连续 14 天窗口：缺日志的天补 empty。否则前端会把仅有的几根柱子等分铺满整宽，
    // 视觉上等于「这几天天天爆量」，缺失的天完全看不见。
    const days = []
    const anchor = new Date(today + "T00:00:00+08:00").getTime()
    for (let i = 13; i >= 0; i -= 1) {
      // 必须走 utc8Date，不能 toISOString()：UTC+8 的 00:00-08:00 会退到前一天，
      // 导致「今天」这一格整个消失（症状：今日用量卡有数、趋势图最后一格空白）。
      const key = utc8Date(new Date(anchor - i * 86400000))
      const hit = byDate.get(key)
      days.push(
        hit || {
          date: key,
          requests: 0,
          ok: 0,
          errors: 0,
          inTokens: 0,
          outTokens: 0,
          models: {},
          callers: {},
          empty: true,
        },
      )
    }

    const t = byDate.get(today) || {
      date: today,
      requests: 0,
      ok: 0,
      errors: 0,
      inTokens: 0,
      outTokens: 0,
      models: {},
      callers: {},
    }
    return { days, today: t }
  }

  async function collectLedger() {
    const doc = await readJson(join(jetHub, "token-ledger.json"))
    if (!doc || !doc.days) return []
    const out = []
    for (const [date, entries] of Object.entries(doc.days)) {
      if (!entries || typeof entries !== "object") continue
      let cacheRead = 0
      let ttftSum = 0
      let ttftCount = 0
      let requests = 0
      for (const v of Object.values(entries)) {
        if (!v || typeof v !== "object") continue
        cacheRead += v.cacheReadTokens || 0
        requests += v.requests || 0
        if (v.ttftCount && v.ttftSumMs) {
          ttftSum += v.ttftSumMs
          ttftCount += v.ttftCount
        }
      }
      out.push({
        date,
        requests,
        cacheRead,
        ttftAvgMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0,
      })
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1))
  }

  /**
   * 余额读数 → 积分收支账本。
   *
   * ⚠️ 上游没有「积分流水」接口（`credits.balances` 只回当前包的 total / used / remaining），
   *    所以这里的「收入 = 包的总量」「支出 = 包的已用量」「结余 = 剩余」是**账本级**口径，
   *    不是逐笔流水。不要伪造逐笔记录。
   *
   * ⚠️ 单位必须分开汇总：实测同一时刻存在 credits（qodercn/trae/minimax）、credit（codearts）、
   *    token（zcode）、通道（opencode）四种 unit，跨单位相加是错的。
   */
  function collectCredits(balanceMap) {
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
    const packages = []
    const byUnit = new Map()
    const byProvider = new Map()
    const buckets = { d7: [], d30: [], later: [], never: [], expired: [] }
    const now = Date.now()

    for (const [provider, pack] of Object.entries(balanceMap || {})) {
      if (!pack || pack.error) continue
      const accs = Array.isArray(pack.accounts) ? pack.accounts : []
      for (const acc of accs) {
        const bal = acc && acc.balance
        if (!bal) continue
        for (const p of Array.isArray(bal.packages) ? bal.packages : []) {
          const total = num(p.total)
          const remaining = num(p.remaining)
          // used 缺省时按 total - remaining 反推（qodercn 的「套餐额度」就是这种形态）
          const used = p.used === undefined || p.used === null ? Math.max(0, total - remaining) : num(p.used)
          const unit = String(p.unit || "credit")
          const row = {
            provider,
            accountId: acc.accountId,
            nickname: acc.nickname,
            name: String(p.name || "（未命名包）"),
            unit,
            total,
            used,
            remaining,
            active: p.active !== false,
            pct: total > 0 ? (used / total) * 100 : 0,
            // 到期时刻：优先 deductionEndTime（各渠道统一的「何时作废」语义），
            // 其次解析 expiredTime（codearts 系只给 ISO 串）。
            // ⚠️ 无到期时间必须是 null 而不是 NaN：NaN 经 JSON 序列化成 null，
            //    前端再 Number.isNaN(null) 为 false，会渲染成 1970-01-01（实测踩过）。
            //    这里统一成 null，前端用 endAt === null 判「永久/无期限」。
            endAt:
              typeof p.deductionEndTime === "number" && p.deductionEndTime > 0
                ? p.deductionEndTime
                : p.expiredTime
                  ? Number.isNaN(Date.parse(p.expiredTime))
                    ? null
                    : Date.parse(p.expiredTime)
                  : null,
            expiredTime: p.expiredTime || "",
          }
          packages.push(row)

          const u = byUnit.get(unit) || { unit, total: 0, used: 0, remaining: 0, packs: 0 }
          u.total += total
          u.used += used
          u.remaining += remaining
          u.packs += 1
          byUnit.set(unit, u)

          const pk = provider + "|" + unit
          const pv = byProvider.get(pk) || {
            provider,
            unit,
            total: 0,
            used: 0,
            remaining: 0,
            packs: 0,
            accounts: new Set(),
          }
          pv.total += total
          pv.used += used
          pv.remaining += remaining
          pv.packs += 1
          if (acc.accountId) pv.accounts.add(acc.accountId)
          byProvider.set(pk, pv)

          // 到期分档只看还有余额的包（空包过期与否都不影响可用性）
          if (remaining <= 0) continue
          if (row.endAt === null) buckets.never.push(row)
          else {
            const left = row.endAt - now
            if (left <= 0) buckets.expired.push(row)
            else if (left <= 7 * 86400_000) buckets.d7.push(row)
            else if (left <= 30 * 86400_000) buckets.d30.push(row)
            else buckets.later.push(row)
          }
        }
      }
    }

    const sumRemaining = (list) => list.reduce((s, r) => s + r.remaining, 0)
    const sortByRemaining = (list) => list.slice().sort((a, b) => b.remaining - a.remaining)

    return {
      packages: packages.sort((a, b) => b.remaining - a.remaining || (a.provider < b.provider ? -1 : 1)),
      units: [...byUnit.values()].sort((a, b) => b.remaining - a.remaining),
      providers: [...byProvider.values()]
        .map((v) => ({ ...v, accounts: [...v.accounts] }))
        .sort((a, b) => (a.provider < b.provider ? -1 : 1)),
      expiry: {
        d7: sortByRemaining(buckets.d7),
        d30: sortByRemaining(buckets.d30),
        later: sortByRemaining(buckets.later),
        never: sortByRemaining(buckets.never),
        expired: sortByRemaining(buckets.expired),
        d7Remaining: sumRemaining(buckets.d7),
        // ⚠️ 必须用 concat：数组之间用 + 会变成字符串拼接，sumRemaining 里 list.reduce 直接抛
        //    TypeError: list.reduce is not a function
        d30Remaining: sumRemaining(buckets.d30.concat(buckets.d7)),
        expiredRemaining: sumRemaining(buckets.expired),
      },
    }
  }

  /**
   * 自动签到状态（看板口径）。
   *
   * ⚠️ `data/jet-hub/auto-checkin.json` 里只有 enabled / lastDate / lastResult / channels，
   *    **没有 ranToday** —— ranToday 是 RPC `usage.autoCheckin` 现算的（doc.lastDate === today()）。
   *    直接透传文件会让前端 `c.ranToday === true` 恒为 false，看板永远显示「今日签到 未完成」，
   *    2026-11-02 用户实测报「为什么显示今日签到未完成，最近 2026-11-02」。这里自己判一次。
   */
  async function checkinOf() {
    const doc = await readJson(join(jetHub, "auto-checkin.json"))
    if (!doc) return null
    const today = utc8Date()
    const lastDate = typeof doc.lastDate === "string" ? doc.lastDate : ""
    let lagDays = null
    if (/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) {
      // 用 UTC+8 零点换算，避免本地时区把天数算错一天
      lagDays = Math.round(
        (Date.parse(today + "T00:00:00+08:00") - Date.parse(lastDate + "T00:00:00+08:00")) / 86400000,
      )
    }
    return { ...doc, today, ranToday: lastDate === today, lagDays }
  }

  // ── 签到日志（本仓库自己的历史档案，2026-11-16 加）────────────────────
  //
  // ## 为什么必须自己存
  //
  // 上游的 `jet-hub/auto-checkin.json` **只保留「最后一次」** 的
  // `lastResult` / `lastAt` / `channels` —— 没有历史数组。也就是说，
  // 「看到自动与手动的签到记录」这件事上游根本没提供数据，光加个按钮只会
  // 弹出一个永远只有一行的空壳。
  //
  // 所以这里做「就地归档」：**每次读签到状态时**，如果发现 `lastAt` 变了
  // （说明刚跑过一轮），就把这一轮的结果追加进 `jet-hub/checkin-history.json`。
  // 不依赖上游主动通知，也不用轮询 —— 看板本来就会周期性刷新。

  /** 历史文件（与 auto-checkin.json 同目录，便于一起备份/迁移）。 */
  const checkinHistoryFile = join(jetHub, "checkin-history.json")

  /** 最多保留的条数：够看几十天，又不会无限长。 */
  const CHECKIN_HISTORY_LIMIT = 300

  /**
   * 把「本轮签到结果」并入历史。
   *
   * 去重键 = `lastAt`（毫秒时间戳，每轮唯一）。同一轮被反复读到不会重复追加。
   *
   * ⚠️ 写盘是**尽力而为**：历史记录属于锦上添花，磁盘满 / 只读目录都只记日志，
   *    绝不能让看板整体 500。
   *
   * @param doc - `auto-checkin.json` 的内容。
   */
  async function archiveCheckinRun(doc) {
    const at = typeof doc?.lastAt === "number" ? doc.lastAt : 0
    if (at <= 0) return
    // 没有 lastResult 说明这一轮还没真正跑完（上游可能只在结束时写结果）。
    const result = typeof doc.lastResult === "string" ? doc.lastResult : ""
    if (!result) return

    const history = (await readJson(checkinHistoryFile)) || { schema: "codearts2api/checkin-history/v1", entries: [] }
    const entries = Array.isArray(history.entries) ? history.entries : []
    if (entries.some((entry) => entry.at === at)) return

    entries.push({
      at,
      // 按 UTC+8 记日期，和看板其它时间口径一致。
      date: utc8Date(new Date(at)),
      time: new Date(at + 8 * 3600_000).toISOString().slice(11, 19),
      result,
      // 触发方式：上游在 `lastSlot` 里记了是哪个时段跑的（`09:00` / `21:00`），
      // 手动触发不会带这个字段 —— 据此区分「自动 / 手动」。
      trigger: typeof doc.lastSlot === "string" && doc.lastSlot ? "auto" : "manual",
      slot: typeof doc.lastSlot === "string" ? doc.lastSlot : "",
      // 每渠道明细也存一份：日志弹窗里展开就能看「哪个渠道领到了」。
      channels: Array.isArray(doc.channels)
        ? doc.channels.map((channel) => ({
            provider: String(channel?.provider ?? ""),
            text: String(channel?.text ?? ""),
          }))
        : [],
    })

    // 超限时丢掉最旧的（保留最近的 N 条）。
    const trimmed = entries.slice(-CHECKIN_HISTORY_LIMIT)
    try {
      // 原子写：先写临时文件再 rename，避免「写到一半崩溃」留下半个 JSON，
      // 那会让下次读到的历史直接坏掉。
      const temporary = `${checkinHistoryFile}.${process.pid}.tmp`
      await writeFile(
        temporary,
        JSON.stringify({ ...history, schema: "codearts2api/checkin-history/v1", entries: trimmed }, null, 2),
        "utf8",
      )
      await rename(temporary, checkinHistoryFile)
    } catch (error) {
      deps.logger?.warn?.(`[dashboard] 签到历史写入失败（不影响看板）：${String(error)}`)
    }
  }

  /** 读历史（新的在前）。 */
  async function checkinHistoryOf() {
    const doc = await readJson(checkinHistoryFile)
    const entries = Array.isArray(doc?.entries) ? doc.entries : []
    return [...entries].reverse()
  }
  async function snapshot({ fresh = false } = {}) {
    const today = utc8Date()
    const state = (await readJson(join(jetHub, "state.json"))) || {}
    // 签到状态读一次，供「归档 + 展示」两用（避免读两遍文件）。
    const checkin = await checkinOf()
    // 顺便归档：`lastAt` 变了就说明刚跑过一轮（自动或手动都算）。
    if (checkin) await archiveCheckinRun(checkin)
    const history = await checkinHistoryOf()
    const accounts = accountsOf(state)
    const providers = [...new Set(accounts.map((a) => a.provider).filter(Boolean))]
    // ⚠️ 解构出的变量不能叫 balances —— 与上面的 balances() 函数同名会在本作用域
    //    形成 TDZ，调用时抛 ReferenceError: Cannot access 'balances' before initialization。
    const { value: balanceMap, cachedAt } = await balances(providers, fresh)

    const callers = await readJson(join(dataDir, "caller-keys.json"))

    // 模型清单：优先读 model-catalog.json（若有），否则回落 gateway.getEnabled 的 models。
    // ⚠️ 该网关的 data/jet-hub 下**没有** model-catalog.json，所以不能只靠文件。
    let models = []
    const catalog = await readJson(join(jetHub, "model-catalog.json"))
    if (Array.isArray(catalog)) models = catalog
    else if (Array.isArray(catalog?.models)) models = catalog.models
    if (models.length === 0 && typeof deps.rpc === "function") {
      try {
        const gw = await deps.rpc("gateway.getEnabled", {})
        if (Array.isArray(gw?.models)) models = gw.models
      } catch {
        /* 拿不到就留空，前端显示「清单为空」 */
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      // 同步/异步都支持：上游 readGatewayState 是 async，统一 await 最省事。
      gateway: deps.gateway ? await deps.gateway() : {},
      accounts,
      balances: balanceMap,
      balancesCachedAt: cachedAt,
      models,
      // ⚠️ auto-checkin.json 里**没有** ranToday 字段（那是 RPC usage.autoCheckin 现算的），
      //    直接透传会让前端 `c.ranToday === true` 恒为 false，显示「今日签到 未完成」——
      //    2026-11-02 用户实测报「为什么显示今日签到未完成，最近 2026-11-02」。
      //    这里按 UTC+8 日键自己判一次。
      checkin: checkin,
      // 签到日志（本仓库自己归档的历史，见 archiveCheckinRun）。
      checkinHistory: history,
      callers: {
        keys: Array.isArray(callers?.keys) ? callers.keys.length : 0,
        groups: Array.isArray(callers?.groups) ? callers.groups.length : 0,
      },
      usage: await collectUsage(today),
      ledger: await collectLedger(),
      // 积分收支（账本级，不是逐笔流水 —— 上游没有流水接口）
      credits: collectCredits(balanceMap),
    }
  }

  return { snapshot }
}

/**
 * HTTP 挂载：handle(request, response, url) -> boolean，与 callerAdmin 同签名。
 * 只暴露两个端点，没有页面端点（看板不是独立 URL）。
 */
export function createDashboardAdmin(options) {
  const dashboard = createDashboard(options)
  return {
    async handle(request, response, url) {
      if (url.pathname === API_PATH) {
        if (request.method !== "GET") {
          response.writeHead(405, { "content-type": "application/json; charset=utf-8" })
          response.end(JSON.stringify({ error: "Method Not Allowed" }))
          return true
        }
        try {
          const fresh = url.searchParams.get("fresh") === "1"
          const data = await dashboard.snapshot({ fresh })
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          })
          response.end(JSON.stringify(data))
        } catch (error) {
          options.logger?.error?.("[dashboard] snapshot failed: " + String(error))
          response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
          response.end(JSON.stringify({ error: String(error) }))
        }
        return true
      }

      if (url.pathname === UI_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" })
          response.end("Method Not Allowed")
          return true
        }
        const body = Buffer.from(UI_SRC, "utf8")
        response.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-length": String(body.length),
          "cache-control": "no-store",
        })
        response.end(request.method === "HEAD" ? undefined : body)
        return true
      }

      return false
    },
  }
}

/** UI 脚本源码，通过 UI_PATH 提供给浏览器。 */
export const UI_SRC = String.raw`
(function () {
  "use strict";
  if (window.__c2dDashboardUI) return;
  window.__c2dDashboardUI = true;

  const API = "/admin/dashboard/api";
  const REFRESH_MS = 30000;
  let timer = null;
  let overlay = null;
  // 上一次成功的快照：再次打开弹窗时先画它（不必等一次网络往返）。
  let lastSnapshot = null;

  /**
   * 最近一次快照里的签到历史（新的在前）。
   *
   * 单独提一份：renderCheckin 只需要条数来显示「签到日志 (N)」，
   * 走参数传递会把签名改得到处都是；而弹窗要的是完整列表。
   */
  let historyEntries = [];
  const openChans = new Set();
  let visible = false;

  /* ── 工具 ─────────────────────────────────────────────────────────── */

  const esc = (s) =>
    String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmt = (n) => {
    if (n === undefined || n === null || Number.isNaN(n)) return "—";
    return Math.round(n).toLocaleString("zh-CN");
  };

  const fmtTokens = (n) => {
    if (!n) return "0";
    if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (n >= 1e4) return (n / 1e4).toFixed(1) + " 万";
    return fmt(n);
  };

  const ago = (iso) => {
    if (!iso) return "—";
    // ⚠️ 客户端时钟可能比服务器慢一两秒，直接算会渲染成「-1 秒前」（实测截图里出现过）。
    //    负数一律钳成「刚刚」。
    const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 5) return "刚刚";
    if (sec < 60) return sec + " 秒前";
    if (sec < 3600) return Math.round(sec / 60) + " 分钟前";
    if (sec < 86400) return Math.round(sec / 3600) + " 小时前";
    return Math.round(sec / 86400) + " 天前";
  };

  /* ── 样式：只补原生没有的那几个（指标卡、趋势条、进度条） ────────────
     颜色全部引用上游自己的 CSS 变量并给出与原生一致的缺省值，
     这样原生若哪天换成深色主题，看板会自动跟着变。 */
  function ensureStyle() {
    if (document.getElementById("c2d-style")) return;
    const st = document.createElement("style");
    st.id = "c2d-style";
    st.textContent = [
      ".c2d-body{display:flex;flex-direction:column;gap:16px}",
      ".c2d-section{margin:0;min-width:0;padding:14px 16px 16px;border:1px solid var(--c2-border,#e5e6eb);border-radius:var(--c2-radius,10px);background:var(--c2-surface,#fff);box-shadow:var(--c2-shadow,none)}",
      ".c2d-sectionTitle{font-size:14px;font-weight:650;line-height:20px;margin:0 0 10px;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2d-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}",
      ".c2d-cards--6{grid-template-columns:repeat(6,minmax(0,1fr))}",
      "@media (max-width:1100px){.c2d-cards--6{grid-template-columns:repeat(3,minmax(0,1fr))}}",
      "@media (max-width:560px){.c2d-cards--6{grid-template-columns:repeat(2,minmax(0,1fr))}}",
      ".c2d-tblWrap{overflow-x:auto;-webkit-overflow-scrolling:touch}",
      ".c2d-tblWrap>.c2d-tbl{min-width:640px}",
      "details.c2d-chan>summary{list-style:none;cursor:pointer}",
      "details.c2d-chan>summary::-webkit-details-marker{display:none}",
      "details.c2d-chan>summary .c2d-chanHead::before{content:'';flex:none;width:6px;height:6px;margin:0 3px 0 1px;border-right:1.5px solid var(--c2-text-3,#8f959e);border-bottom:1.5px solid var(--c2-text-3,#8f959e);transform:rotate(-45deg);transition:transform .15s ease}",
      "details.c2d-chan[open]>summary .c2d-chanHead::before{transform:rotate(45deg)}",
      "details.c2d-chan>summary:focus-visible{outline:2px solid color-mix(in srgb,var(--c2-brand,#1677ff) 45%,transparent);outline-offset:2px;border-radius:6px}",
      ".c2d-chanBody{margin-top:9px}",
      ".c2d-card{border:1px solid var(--dsw-alias-border-default,#e5e5e5);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3,#fff)}",
      ".c2d-card .k{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-card .v{font-size:20px;font-weight:600;line-height:1.25;margin-top:2px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2d-card .v .u{font-size:11.5px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8f959e);margin-left:3px}",
      ".c2d-card .f{font-size:11px;line-height:16px;margin-top:3px;color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-card.ok .v{color:var(--dsw-alias-state-success-primary,#15803d)}",
      ".c2d-card.warn .v{color:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2d-card.bad .v{color:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2d-card.brand .v{color:var(--dsw-alias-brand-primary,#1677ff)}",
      ".c2d-tbl{width:100%;border-collapse:collapse;font-size:11.5px}",
      ".c2d-tbl th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary,#8f959e);padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-default,#e5e5e5);white-space:nowrap}",
      ".c2d-tbl td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,#eef0f3);color:var(--dsw-alias-text-secondary,#4e5969);vertical-align:middle}",
      ".c2d-tbl tr:last-child td{border-bottom:0}",
      ".c2d-tbl .num{text-align:right;font-variant-numeric:tabular-nums}",
      ".c2d-ch{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2d-muted{color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-err{color:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2d-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:1px}",
      ".c2d-dot.ok{background:var(--dsw-alias-state-success-primary,#15803d)}",
      ".c2d-dot.warn{background:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2d-dot.bad{background:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2d-dot.off{background:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-bar{height:4px;border-radius:2px;overflow:hidden;margin-top:3px;background:var(--dsw-alias-bg-layer-2,#f4f5f7)}",
      ".c2d-bar>i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-success-primary,#15803d)}",
      ".c2d-bar>i.warn{background:var(--dsw-alias-state-warn-primary,#b45309)}",
      ".c2d-bar>i.bad{background:var(--dsw-alias-state-error-primary,#d93025)}",
      ".c2d-bar>i.brand{background:var(--dsw-alias-brand-primary,#1677ff)}",
      ".c2d-two{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
      ".c2d-trend{display:flex;align-items:flex-end;gap:3px;height:104px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-default,#e5e5e5);border-radius:8px;padding:8px 10px 6px;background:var(--dsw-alias-bg-layer-3,#fff)}",
      ".c2d-trend .col{flex:1;position:relative;height:100%;min-width:0}",
      ".c2d-trend .col i{position:absolute;left:0;right:0;bottom:0;display:block;min-height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-brand-primary,#1677ff);opacity:.82}",
      ".c2d-trend .col i.nodata{background:var(--dsw-alias-border-default,#e5e5e5);opacity:1;border-radius:1px}",
      ".c2d-trend .col:hover i{opacity:1}",
      ".c2d-axis{display:flex;gap:3px;margin-top:4px}",
      ".c2d-axis span{flex:1;text-align:center;font-size:10px;color:var(--dsw-alias-label-tertiary,#8f959e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".c2d-axis span.nodata{opacity:.4}",
      ".c2d-empty{padding:14px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8f959e);border:1px dashed var(--dsw-alias-border-default,#e5e5e5);border-radius:8px}",
      ".c2d-pkg{min-width:132px}",
      ".c2d-pkgName{font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}",
      ".c2d-sub2{font-size:11.5px;font-weight:600;margin:10px 0 5px;color:var(--dsw-alias-label-secondary,#5f6672)}",
      // 签到日志（2026-11-16 加）：按钮行 + 弹窗内的表格细节。
      ".c2d-checkinLogBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}",
      ".c2d-checkinLog .c2d-empty{text-align:left;line-height:1.7}",
      ".c2d-checkinLogTime{white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672);font-variant-numeric:tabular-nums}",
      ".c2d-checkinLogResult{line-height:1.6}",
      ".c2d-checkinLogChannels{margin-top:4px;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600;white-space:nowrap;background:var(--dsw-alias-bg-layer-3,#f2f3f5);color:var(--dsw-alias-label-secondary,#5f6672)}",
      ".c2d-badge--ok{background:rgba(0,180,120,.12);color:#0a8f5f}",
      ".c2d-scroll{max-height:212px;overflow:auto}",
      ".c2d-unit{font-size:11px;color:var(--dsw-alias-label-tertiary,#8f959e)}",
      ".c2d-chan{border:1px solid var(--dsw-alias-border-default,#e5e5e5);border-radius:8px;padding:9px 11px;margin:0 0 9px;background:var(--dsw-alias-bg-layer-3,#fff)}",
      ".c2d-chanHead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:5px}",
      ".c2d-ico{display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;flex:0 0 auto}",
      ".c2d-ico img{width:18px;height:18px;border-radius:4px;object-fit:contain}",
      ".c2d-chanName{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".c2d-chanCell{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap}",
      ".c2d-chanSum{font-size:11.5px;color:var(--dsw-alias-text-secondary,#4e5969);margin-left:auto;font-variant-numeric:tabular-nums}",
      ".c2d-accs{display:flex;flex-wrap:wrap;gap:6px;margin:3px 0 7px}",
      ".c2d-accItem{font-size:11px;padding:1px 7px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f4f5f7);color:var(--dsw-alias-label-secondary,#5f6672)}",
      "@media (max-width:900px){.c2d-two{grid-template-columns:1fr}}",
      "@media (max-width:720px){.c2d-section{padding:12px}.c2d-card .v{font-size:18px}.c2d-chanSum{margin-left:0;flex-basis:100%}}",
    ].join("");
    document.head.appendChild(st);
  }

  /* ── 渲染片段 ─────────────────────────────────────────────────────── */

  const card = (k, v, u, f, tone) =>
    '<div class="c2d-card ' + (tone || "") + '">' +
    '<div class="k">' + esc(k) + "</div>" +
    '<div class="v">' + esc(v) + (u ? '<span class="u">' + esc(u) + "</span>" : "") + "</div>" +
    (f ? '<div class="f">' + f + "</div>" : "") +
    "</div>";

  const section = (title, body) =>
    '<div class="c2d-section"><div class="c2d-sectionTitle">' + esc(title) + "</div>" + body + "</div>";

  function cards(list) {
    const cls = list.filter(Boolean).length === 6 ? "c2d-cards c2d-cards--6" : "c2d-cards";
    return '<div class="' + cls + '">' + list.join("") + "</div>";
  }

  function renderGateway(d) {
    const g = d.gateway || {};
    const gw = g.gateway || {};
    const ok = g.ok === true;
    const modelCount = gw.modelCount !== undefined ? gw.modelCount : (d.models || []).length;
    const acc = d.accounts || [];
    const enabled = acc.filter((a) => a.enabled).length;
    const port = gw.address && gw.address.port !== undefined ? gw.address.port : "?";
    return cards([
      card("服务状态", ok ? "运行中" : "异常", "", "监听 127.0.0.1:" + port, ok ? "ok" : "bad"),
      card("上游渠道", (g.providers || []).length, "个", "已接通的 provider"),
      card("可用模型", fmt(modelCount), "个", "网关下发的模型总数", "brand"),
      card("账号池", enabled + " / " + acc.length, "", "启用 / 总数"),
      card("调用方 key", fmt(d.callers && d.callers.keys), "把",
        "分组 " + (d.callers && d.callers.groups !== undefined ? d.callers.groups : 0) + " 个"),
      card("数据快照", ago(d.generatedAt), "", "每 30 秒自动刷新"),
    ]);
  }

  function renderUsage(d) {
    const t = d.usage && d.usage.today;
    if (!t) return '<div class="c2d-empty">今天还没有请求记录</div>';
    const ledger = (d.ledger || []).find((x) => x.date === t.date) || {};
    const rate = t.requests > 0 ? (t.ok / t.requests) * 100 : null;
    const tone = rate === null ? "" : rate >= 99 ? "ok" : rate >= 95 ? "warn" : "bad";
    const cacheRead = ledger.cacheRead || 0;
    const cacheBase = (t.inTokens || 0) + cacheRead;
    const cacheRate = cacheBase > 0 ? ((cacheRead / cacheBase) * 100).toFixed(1) : "0.0";
    return cards([
      card("今日请求", fmt(t.requests), "次", "成功 " + fmt(t.ok) + " · 失败 " + fmt(t.errors)),
      card("成功率", rate === null ? "—" : rate.toFixed(1), "%", "按今日请求统计", tone),
      card("输入 tokens", fmtTokens(t.inTokens), "", "上下文占大头", "brand"),
      card("输出 tokens", fmtTokens(t.outTokens), "", "生成部分"),
      card("缓存命中", cacheRate, "%", "缓存读 " + fmtTokens(cacheRead)),
      card("首字延迟", ledger.ttftAvgMs ? fmt(ledger.ttftAvgMs) + " ms" : "—", "", "平均 TTFT"),
    ]);
  }

  function renderTrend(hostId, axisId, days, pick, fn) {
    const host = document.getElementById(hostId);
    const axis = document.getElementById(axisId);
    if (!host || !axis) return;
    if (!days || !days.length) {
      host.innerHTML = '<div class="c2d-muted" style="margin:auto;font-size:11.5px">暂无数据</div>';
      axis.innerHTML = "";
      return;
    }
    const vals = days.map(pick);
    const max = Math.max(1, Math.max.apply(null, vals));
    host.innerHTML = days.map(function (day, i) {
      if (day.empty) {
        return '<div class="col" title="' + esc(day.date) + '：无数据"><i class="nodata" style="height:2px"></i></div>';
      }
      const h = Math.max(2, Math.round((vals[i] / max) * 100));
      return '<div class="col" title="' + esc(day.date) + "：" + esc(fn(vals[i])) + '"><i style="height:' + h + '%"></i></div>';
    }).join("");
    axis.innerHTML = days.map(function (day) {
      return "<span" + (day.empty ? ' class="nodata"' : "") + ">" + esc(day.date.slice(5)) + "</span>";
    }).join("");
  }

  function renderAccounts(d) {
    const accounts = d.accounts || [];
    if (!accounts.length) return '<div class="c2d-empty">账号池为空</div>';
    const byAcc = {};
    Object.keys(d.balances || {}).forEach(function (p) {
      const pack = d.balances[p];
      (pack && pack.accounts || []).forEach(function (row) { byAcc[row.accountId] = Object.assign({}, row, { provider: p }); });
    });
    const rows = accounts.map(function (a) {
      const bal = byAcc[a.id];
      const pkgs = (bal && bal.balance && bal.balance.packages) || [];
      const total = bal && bal.balance ? bal.balance.total : undefined;

      let balCell;
      if (bal && bal.error !== undefined) {
        balCell = '<span class="c2d-err">' + esc(bal.error) + "</span>";
      } else if (!bal) {
        balCell = '<span class="c2d-muted">—</span>';
      } else if (!pkgs.length) {
        balCell = '<span class="c2d-muted">无积分包</span>';
      } else {
        balCell = pkgs.slice(0, 4).map(function (p) {
          const pct = p.total > 0 ? (p.remaining / p.total) * 100 : 0;
          const tone = pct > 30 ? "" : pct > 10 ? "warn" : "bad";
          return '<div class="c2d-pkg">' +
            '<div class="c2d-pkgName">' + esc(p.name) + ' <span class="c2d-muted">' + fmt(p.remaining) + "/" + fmt(p.total) + "</span></div>" +
            '<div class="c2d-bar"><i class="' + tone + '" style="width:' + Math.min(100, pct).toFixed(1) + '%"></i></div>' +
            "</div>";
        }).join("");
      }

      let expCell;
      if (a.expiresAt === undefined) {
        expCell = '<span class="c2d-muted">长期 / 静态</span>';
      } else {
        /* tone 用毫秒差判断，不用取整后的天数：否则「还剩 2 小时」会被算成
           0 天而落进最紧急的红档，与还剩 23 小时显示同色，看不出轻重。 */
        const msLeft = a.expiresAt - Date.now();
        const tone = msLeft > 7 * 86400000 ? "ok" : msLeft > 2 * 86400000 ? "warn" : "bad";
        expCell = '<span class="c2d-dot ' + tone + '"></span>' + esc(a.expiryText || "已过期");
      }

      const state = a.enabled
        ? '<span class="c2d-dot ok"></span>启用'
        : '<span class="c2d-dot off"></span>停用';
      const rl = a.rateLimited > 0
        ? '<span title="' + esc(a.rateLimitedModels || "") + '" style="color:var(--dsw-alias-state-warn-primary,#b45309)">' + a.rateLimited + " 模型限流</span>"
        : '<span class="c2d-muted">正常</span>';

      return "<tr>" +
        "<td><span class=\"c2d-chanCell\">" + providerHeadTag(a.provider) + "</span></td>" +
        "<td>" + esc(a.nickname || a.id) + "</td>" +
        "<td>" + state + "</td>" +
        "<td>" + expCell + "</td>" +
        "<td>" + rl + "</td>" +
        '<td class="num">' + (total !== undefined ? "<strong>" + fmt(total) + "</strong>" : "—") + "</td>" +
        "<td>" + balCell + "</td>" +
        "</tr>";
    }).join("");

    const cached = d.balancesCachedAt ? " · " + ago(new Date(d.balancesCachedAt).toISOString()) : "";
    return '<div class="c2d-tblWrap"><table class="c2d-tbl"><thead><tr>' +
      "<th>渠道</th><th>账号</th><th>状态</th><th>凭据有效期</th><th>限流</th>" +
      '<th class="num">余额合计</th><th>积分包（缓存 5 分钟' + esc(cached) + "）</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";
  }

  function renderModels(d) {
    const models = d.models || [];
    const byP = {};
    models.forEach(function (m) {
      const p = String(m.id || "").split("/")[0] || "?";
      byP[p] = (byP[p] || 0) + 1;
    });
    const sorted = Object.keys(byP).map(function (k) { return [k, byP[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    const max = sorted.length ? sorted[0][1] : 1;

    const left = sorted.length
      ? '<table class="c2d-tbl"><thead><tr><th>渠道</th><th class="num">模型数</th><th>占比</th></tr></thead><tbody>' +
        sorted.map(function (x) {
          const pct = (x[1] / max) * 100;
          return "<tr>" +
            "<td><span class=\"c2d-chanCell\">" + providerHeadTag(x[0]) + "</span></td>" +
            '<td class="num">' + fmt(x[1]) + "</td>" +
            '<td style="width:52%"><div class="c2d-bar" style="margin:0"><i class="brand" style="width:' + pct.toFixed(1) + '%"></i></div></td>' +
            "</tr>";
        }).join("") + "</tbody></table>"
      : '<div class="c2d-empty">模型清单为空</div>';

    const used = (d.usage && d.usage.today && d.usage.today.models) || {};
    const usedSorted = Object.keys(used).map(function (k) { return [k, used[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
    const right = usedSorted.length
      ? '<table class="c2d-tbl"><thead><tr><th>今日使用的模型</th><th class="num">请求数</th></tr></thead><tbody>' +
        usedSorted.map(function (x) {
          return '<tr><td><span class="c2d-ch">' + esc(x[0]) + '</span></td><td class="num">' + fmt(x[1]) + "</td></tr>";
        }).join("") + "</tbody></table>"
      : '<div class="c2d-empty">今天还没有调用</div>';

    return '<div class="c2d-two"><div>' + left + "</div><div>" + right + "</div></div>";
  }

  /**
   * 金额/额度显示：积分常带小数（codearts 4599.89），四舍五入成整数会丢精度。
   */
  function fmtAmt(n) {
    const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
    if (Math.abs(v - Math.round(v)) < 0.005) return fmt(v);
    return v.toFixed(2);
  }

  /** 毫秒时间戳 → 「YYYY-MM-DD HH:mm」（本地时区，与面板其它时间一致）。 */
  function when(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /** 距现在还有多少天（可为负）；无到期时间返回 null。 */
  function leftDays(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
    return Math.floor((ms - Date.now()) / 86400_000);
  }

  /**
   * 积分收支。
   *
   * ⚠️ 口径是账本级：上游 credits.balances 只回每个包的 total / used / remaining，
   *    没有逐笔流水接口。所以「收入」= 包的总额度、「支出」= 已消耗、「结余」= 剩余。
   *    不要在这里造逐笔记录。
   */
  /*
   * 渠道中文名 + 官方 logo。
   *
   * ⚠️ 不要自己画 SVG 或引外链：上游 public/upstream-jet-hub.js 的 PROVIDER_ICONS 是 base64
   *    内联在构建产物里的，本模块拿不到。正确做法是直接读左侧原生供应商行里的 img 标签（同源、
   *    已在 DOM、CSP 的 img-src 'self' 放行、零网络请求）。左侧行不存在时退回纯文字。
   */
  var PROVIDER_LABELS = {
    codearts: "CodeArts (华为云)", buddy: "CodeBuddy (腾讯)", workbuddy: "WorkBuddy (国际版)",
    lobsterai: "LobsterAI (有道)", qoder: "Qoder", qodercn: "Qoder (中国版)",
    trae: "TRAE (字节)", cline: "Cline", loomy: "Loomy (讯飞)", raccoon: "Raccoon (商汤)",
    minimax: "MiniMax Code (中国版)", minimaxintl: "MiniMax Code (国际版)",
    zcode: "ZCode (智谱)", opencode: "OpenCode", gemini: "Gemini Code Assist",
    officeace: "OfficeAce", accio: "Accio (阿里)", astudio: "AStudio (讯飞)",
    autoclaw: "AutoClaw (智谱)", autoclawintl: "AutoClaw (国际版)",
    qiniu: "Qiniu (七牛云)", codely: "Codely (Unity)", magicrew: "超级麦吉",
    aggregate: "聚合 (跨渠道)", "jet-hub-auto": "Jet Hub Auto", modelscope: "ModelScope (魔搭)",
  };

  /** 渠道中文名：优先读左侧原生供应商行的标签，其次查表，最后退回 id 本身。 */
  function providerLabel(prov) {
    var row = document.querySelector('.dim-jh-providerRow[data-provider="' + prov + '"]');
    var txt = row && row.querySelector('.dim-jh-providerLabel strong');
    if (txt && txt.textContent && txt.textContent.trim()) return txt.textContent.trim();
    if (PROVIDER_LABELS[prov]) return PROVIDER_LABELS[prov];
    return prov;
  }

  /** 渠道 logo：借左侧原生供应商行里的官方图标（同源内联图，不发请求）。 */
  function providerIconUrl(prov) {
    var img = document.querySelector('.dim-jh-providerRow[data-provider="' + prov + '"] img');
    return img && img.src ? img.src : "";
  }

  /** 渠道头部：logo + 中文名（无图标时只出名字）。 */
  function providerHeadTag(prov) {
    var url = providerIconUrl(prov);
    var ico = url ? '<span class="c2d-ico"><img src="' + esc(url) + '" alt=""></span>' : "";
    return ico + '<span class="c2d-chanName">' + esc(providerLabel(prov)) + "</span>" +
      '<span class="c2d-ch">' + esc(prov) + "</span>";
  }
  function renderCredits(d) {
    const cr = d.credits;
    if (!cr || !cr.packages || cr.packages.length === 0) {
      return '<div class="c2d-empty">当前没有任何渠道上报积分包（或余额接口暂不可用）</div>';
    }

    /* ① 按单位汇总卡：不能把 credits / credit / token / 通道 相加 */
    const unitCards = cr.units.map(function (u) {
      const pctUsed = u.total > 0 ? (u.used / u.total) * 100 : 0;
      return card("剩余 · " + u.unit, fmtAmt(u.remaining), "", 
        "已用 " + fmtAmt(u.used) + " / 总量 " + fmtAmt(u.total) +
        " · 使用率 " + pctUsed.toFixed(1) + "% · " + u.packs + " 个包",
        pctUsed >= 90 ? "bad" : pctUsed >= 60 ? "warn" : "ok");
    });

    const warn7 = cr.expiry.d7.length;
    const warn30 = cr.expiry.d30.length;
    const stale = cr.expiry.expired.length;
    const warnCard = card("7 天内到期", String(warn7), "个包",
      warn7 ? "其中剩余量见下方预警" : "暂无临近到期", warn7 ? "bad" : "ok");
    const laterCard = card("8–30 天内到期", String(warn30), "个包",
      "合计 " + String(warn7 + warn30) + " 个包在 30 天内到期", warn30 ? "warn" : "");
    const staleCard = stale
      ? card("已过期未清零", String(stale), "个包", "剩余额度已不可用", "bad") : "";

    const head = cards(unitCards.concat([warnCard, laterCard]).concat(staleCard ? [staleCard] : []));

    /* ② 按渠道明细：一个渠道一块，头部是中文名 + logo + 该渠道收支合计，下面挂它自己的每个积分包 */
    const chanMap = new Map();
    cr.packages.forEach(function (p) {
      if (!chanMap.has(p.provider)) chanMap.set(p.provider, []);
      chanMap.get(p.provider).push(p);
    });
    const chanBlocks = Array.from(chanMap.keys()).sort().map(function (prov) {
      const list = chanMap.get(prov).slice().sort(function (a, b) {
        if (b.remaining !== a.remaining) return b.remaining - a.remaining;
        return a.name < b.name ? -1 : 1;
      });
      const agg = { total: 0, used: 0, remaining: 0 };
      const units = [];
      const accMap = new Map();
      list.forEach(function (p) {
        agg.total += p.total; agg.used += p.used; agg.remaining += p.remaining;
        if (units.indexOf(p.unit) < 0) units.push(p.unit);
        const ak = p.accountId || "?";
        const a = accMap.get(ak) ||
          { accountId: ak, nickname: p.nickname, total: 0, used: 0, remaining: 0, packs: 0 };
        a.total += p.total; a.used += p.used; a.remaining += p.remaining; a.packs += 1;
        accMap.set(ak, a);
      });
      const pct = agg.total > 0 ? (agg.used / agg.total) * 100 : 0;
      const tone = pct >= 90 ? "bad" : pct >= 60 ? "warn" : "brand";
      let html = '<details class="c2d-chan" data-prov="' + esc(prov) + '"' + (openChans.has(prov) ? " open" : "") + ">" +
        "<summary>" +
        '<div class="c2d-chanHead">' + providerHeadTag(prov) +
        '<span class="c2d-unit">' + esc(units.join(" · ")) + "</span>" +
        '<span class="c2d-chanSum">收入 ' + fmtAmt(agg.total) +
          " · 支出 " + fmtAmt(agg.used) +
          " · 结余 " + fmtAmt(agg.remaining) +
          " · 使用率 " + pct.toFixed(1) + "%" +
          " · " + String(list.length) + " 个包 / " + String(accMap.size) + " 个账号</span>" +
        "</div>" +
        '<div class="c2d-bar" style="margin:0"><i class="' + tone + '" style="width:' +
          Math.min(100, pct).toFixed(1) + '%"></i></div>' +
        '</summary><div class="c2d-chanBody">';
      if (accMap.size > 1) {
        html += '<div class="c2d-accs">' + Array.from(accMap.values()).map(function (a) {
          return '<span class="c2d-accItem">' + esc(a.nickname || a.accountId) +
            " · 结余 " + fmtAmt(a.remaining) + " / " + fmtAmt(a.total) + " · " + String(a.packs) +
            " 个包</span>";
        }).join("") + "</div>";
      }
      html += '<div class="c2d-tblWrap"><table class="c2d-tbl"><thead><tr>' +
        "<th>包名</th><th>账号</th>" +
        '<th class="num">总量</th><th class="num">已用</th><th class="num">剩余</th>' +
        "<th>使用率</th><th>到期</th>" +
        "</tr></thead><tbody>" +
        list.map(function (p) {
          const up = p.total > 0 ? (p.used / p.total) * 100 : 0;
          const t = up >= 90 ? "bad" : up >= 60 ? "warn" : "";
          const dl = leftDays(p.endAt);
          const endText = p.endAt === null ? "无期限"
            : when(p.endAt) + (dl !== null && dl >= 0 ? "（" + dl + " 天）" : "（已过期）");
          return "<tr>" +
            "<td>" + esc(p.name) + "</td>" +
            '<td class="c2d-muted">' + esc(p.nickname || p.accountId || "") + "</td>" +
            '<td class="num">' + fmtAmt(p.total) + "</td>" +
            '<td class="num">' + fmtAmt(p.used) + "</td>" +
            '<td class="num">' + fmtAmt(p.remaining) + "</td>" +
            '<td style="width:13%"><div class="c2d-bar" style="margin:0"><i class="' + t +
              '" style="width:' + Math.min(100, up).toFixed(1) + '%"></i></div></td>' +
            '<td class="c2d-muted">' + endText + "</td>" +
            "</tr>";
        }).join("") +
        "</tbody></table></div></div></details>";
      return html;
    }).join("");

    /* ③ 到期预警：只列还有余额且即将到期的包 */
    const urgent = cr.expiry.d7.concat(cr.expiry.d30).slice(0, 12);
    const urgentTable = urgent.length
      ? '<div class="c2d-sub2">即将到期（30 天内，且仍有余额）</div>' +
        '<div class="c2d-tblWrap"><table class="c2d-tbl"><thead><tr>' +
        "<th>剩余</th><th>包名</th><th>渠道 / 账号</th><th>到期</th><th>还剩</th>" +
        "</tr></thead><tbody>" +
        urgent.map(function (p) {
          const dl = leftDays(p.endAt);
          const tone = dl !== null && dl <= 7 ? "bad" : "warn";
          return "<tr>" +
            '<td class="num">' + fmtAmt(p.remaining) + ' <span class="c2d-unit">' + esc(p.unit) + "</span></td>" +
            "<td>" + esc(p.name) + "</td>" +
            "<td><span class=\"c2d-chanCell\">" + providerHeadTag(p.provider) +
              ' <span class="c2d-muted">' + esc(p.nickname || p.accountId || "") + "</span></span></td>" +
            "<td>" + when(p.endAt) + "</td>" +
            '<td><span class="c2d-dot ' + tone + '"></span>' + (dl !== null ? dl + " 天" : "—") + "</td>" +
            "</tr>";
        }).join("") + "</tbody></table></div>"
      : '<div class="c2d-muted" style="font-size:11.5px">30 天内没有到期且仍有余额的积分包。</div>';

    return head +
      '<div class="c2d-sub2">按渠道明细（点开看每个积分包；收入 = 包的总额度，支出 = 已消耗，结余 = 剩余；共 ' +
        String(chanMap.size) + " 个渠道 / " + String(cr.packages.length) + " 个积分包）</div>" +
      chanBlocks + urgentTable;
  }

  function renderCheckin(d) {
    const c = d.checkin;
    if (!c) return '<div class="c2d-empty">没有签到状态文件</div>';
    const ok = c.ranToday === true;
    // lagDays 由后端按 UTC+8 日键算好：0 = 今天已签，1 = 昨天签的、今天没签，以此类推。
    const lag = typeof c.lagDays === "number" ? c.lagDays : null;
    const lastText = !c.lastDate ? "还没有记录"
      : lag === 0 ? "今天 " + esc(c.lastDate)
      : lag !== null && lag > 0 ? "上次 " + esc(c.lastDate) + "（已隔 " + lag + " 天）"
      : "上次 " + esc(c.lastDate);
    const atText = typeof c.lastAt === "number" && c.lastAt > 0 ? when(c.lastAt) : "—";
    const head = cards([
      card("今日签到", ok ? "已完成" : "未完成", "", lastText, ok ? "ok" : "warn"),
      card("自动签到", c.enabled ? "已开启" : "已关闭", "",
        "systemd 启动 30 秒 + cron 每日 00:05", c.enabled ? "ok" : "warn"),
      card("最近执行", atText, "", esc(c.lastResult || "—"), ok ? "" : "warn"),
    ]);
    const rows = (c.channels || []).map(function (ch) {
      const t = String(ch.text || "");
      const tone = t.indexOf("已领") >= 0 || t.indexOf("已完成") >= 0 ? "ok"
        : t.indexOf("不支持") >= 0 || t.indexOf("手动") >= 0 ? "warn" : "bad";
      return "<tr><td><span class=\"c2d-ch\">" + esc(ch.provider) + "</span></td>" +
        '<td><span class="c2d-dot ' + tone + '"></span>' + esc(t) + "</td></tr>";
    }).join("");
    // 「签到日志」按钮（2026-11-16 用户要求：要能看到自动与手动的签到记录）。
    //
    // ⚠️ 按钮放在**本仓库自己的看板**里，而不是上游那个「设置」弹窗里：
    //    设置弹窗是 public/upstream-jet-hub.js（上游构建产物）渲染的，
    //    按项目纪律不能手改（改了下次升级就丢），所以挂在看板这里最稳妥。
    const historyCount = Array.isArray(historyEntries) ? historyEntries.length : 0;
    const logButton =
      '<div class="c2d-checkinLogBar">' +
      '<button type="button" class="c2-btn" id="c2d-checkin-log" ' +
      'title="查看每一次自动 / 手动签到的结果（本程序自己归档）">' +
      "签到日志" + (historyCount > 0 ? " (" + String(historyCount) + ")" : "") +
      "</button>" +
      (historyCount === 0
        ? '<span class="c2d-sub2" style="margin-left:8px">还没有记录 —— 跑过一次签到（自动或手动）后这里就会出现。</span>'
        : "") +
      "</div>";
    return head + logButton +
      '<table class="c2d-tbl" style="margin-top:8px"><thead><tr><th>渠道</th><th>签到状态</th></tr></thead><tbody>' +
      rows + "</tbody></table>";
  }


  function build() {
    const page = document.createElement("div");
    page.className = "c2-page";
    page.setAttribute("data-c2d", "1");
    page.innerHTML =
      '<div class="c2-pageHead">' +
      "<div>" +
      '<h1 class="c2-pageTitle">总览</h1>' +
      '<p class="c2-pageSub" id="c2d-sub">加载中…</p>' +
      "</div>" +
      '<div class="c2-pageActions">' +
      '<button type="button" class="c2-btn" id="c2d-refresh" title="重新读取全部数据（余额会绕过 5 分钟缓存）。">刷新</button>' +
      "</div></div>" +
      '<div class="c2d-body" id="c2d-body"><div class="c2d-empty">加载中…</div></div>';

    page.querySelector("#c2d-refresh").addEventListener("click", function () {
      const b = page.querySelector("#c2d-refresh");
      b.disabled = true;
      load(true).finally(function () { b.disabled = false; });
    });
    page.addEventListener("toggle", function (e) {
      const el = e.target;
      if (!el || !el.matches || !el.matches("details.c2d-chan")) return;
      const prov = el.getAttribute("data-prov");
      if (el.open) openChans.add(prov);
      else openChans.delete(prov);
    }, true);
    // 「签到日志」：每次重新绑定（paint 会重建 body，旧按钮随之消失）。
    page.addEventListener("click", function (e) {
      const button = e.target && e.target.closest && e.target.closest("#c2d-checkin-log");
      if (button) openCheckinLog();
    });
    return page;
  }

  /**
   * 打开「签到日志」弹窗 —— 自动与手动的签到记录。
   *
   * ## 数据从哪来
   *
   * 上游 auto-checkin.json 只有「最后一次」，没有历史；这里展示的是本仓库
   * 自己的归档（jet-hub/checkin-history.json，见后端 archiveCheckinRun）。
   *
   * 复用外壳的 openModal：焦点管理、Esc 关闭、遮罩点击、焦点归还都已由它处理，
   * 自己再写一套只会重复这些细节。
   */
  function openCheckinLog() {
    const entries = Array.isArray(historyEntries) ? historyEntries : [];
    if (!window.__c2Shell?.openModal) {
      // 外壳不在（理论上不会）时退化成原生 alert，至少让用户看到内容。
      window.alert(formatCheckinLogText(entries));
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "c2d-checkinLog";

    if (entries.length === 0) {
      wrap.innerHTML =
        '<div class="c2d-empty">还没有签到记录。<br />' +
        "自动签到到点会跑一轮；也可以在「渠道管理」里手动点一次签到。<br />" +
        "跑过之后这里就会有记录（本程序自己归档，最多保留 300 条）。</div>";
    } else {
      const autoCount = entries.filter(function (entry) { return entry.trigger === "auto"; }).length;
      const manualCount = entries.length - autoCount;
      const summary =
        '<div class="c2d-sub2" style="margin-bottom:8px">' +
        "共 " + String(entries.length) + " 条 · 自动 " + String(autoCount) +
        " · 手动 " + String(manualCount) + "（新的在前，最多保留 300 条）</div>";
      const rows = entries.map(function (entry) {
        const isAuto = entry.trigger === "auto";
        const badge = isAuto
          ? '<span class="c2d-badge c2d-badge--ok">自动' + (entry.slot ? " " + esc(entry.slot) : "") + "</span>"
          : '<span class="c2d-badge">手动</span>';
        const channels = Array.isArray(entry.channels) ? entry.channels : [];
        const channelText = channels.length === 0
          ? ""
          : '<div class="c2d-checkinLogChannels">' +
            channels.map(function (channel) {
              return '<span class="c2d-ch">' + esc(channel.provider) + "</span> " + esc(channel.text);
            }).join("<br />") +
            "</div>";
        return "<tr>" +
          '<td class="c2d-checkinLogTime">' + esc(entry.date || "") + "<br />" + esc(entry.time || "") + "</td>" +
          "<td>" + badge + "</td>" +
          '<td class="c2d-checkinLogResult">' + esc(entry.result || "—") + channelText + "</td>" +
          "</tr>";
      }).join("");
      wrap.innerHTML = summary +
        '<table class="c2d-tbl"><thead><tr><th style="width:120px">时间</th>' +
        '<th style="width:90px">方式</th><th>结果</th></tr></thead><tbody>' +
        rows + "</tbody></table>";
    }

    window.__c2Shell.openModal({
      title: "签到日志",
      subtitle: "自动与手动的签到记录",
      wide: true,
      body: wrap,
    });
  }

  /** 退化成纯文本（外壳不可用时）。 */
  function formatCheckinLogText(entries) {
    if (!entries || entries.length === 0) return "还没有签到记录。";
    return entries.map(function (entry) {
      const kind = entry.trigger === "auto" ? "自动" + (entry.slot ? " " + entry.slot : "") : "手动";
      return (entry.date || "") + " " + (entry.time || "") + " [" + kind + "] " + (entry.result || "");
    }).join("\n");
  }

  function mount(container) {
    ensureStyle();
    overlay = build();
    container.appendChild(overlay);
    // 上次的快照先画出来（毫秒级），随后 load 再更新。
    // 用户报「总览点开很慢」：冷启动首个 dashboard/api 要 0.64s，
    // 首次打开逃不掉，但再次打开不该再等一次。
    if (lastSnapshot) paint(lastSnapshot);
  }

  function onShow() {
    visible = true;
    load(false);
    startTimer();
  }

  function onHide() {
    visible = false;
    stopTimer();
  }

  function startTimer() {
    stopTimer();
    timer = setInterval(function () {
      if (document.visibilityState === "visible" && overlay && visible) load(false);
    }, REFRESH_MS);
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  /* ── 数据加载 ─────────────────────────────────────────────────────── */

  async function load(fresh) {
    const body = overlay && overlay.querySelector("#c2d-body");
    const sub = overlay && overlay.querySelector("#c2d-sub");
    if (!body) return;
    try {
      const res = await fetch(API + (fresh ? "?fresh=1" : ""), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const d = await res.json();
      if (!overlay) return;
      lastSnapshot = d;
      paint(d);
    } catch (err) {
      if (sub) sub.textContent = "加载失败：" + err.message;
      body.innerHTML = '<div class="c2d-empty">加载失败：' + esc(err.message) + "</div>";
    }
  }

  /** 把一份快照画进弹窗。抽成独立函数是为了让「再次打开」能直接复用上次结果。 */
  function paint(d) {
    const body = overlay && overlay.querySelector("#c2d-body");
    const sub = overlay && overlay.querySelector("#c2d-sub");
    if (!body) return;
    // 历史随快照一起更新（后端已在 snapshot 里归档并返回）。
    historyEntries = Array.isArray(d.checkinHistory) ? d.checkinHistory : [];
    body.innerHTML =
      section("网关状态", renderGateway(d)) +
      section("今日用量", renderUsage(d)) +
      section("近 14 日趋势",
        '<div class="c2d-two">' +
        '<div><div class="c2d-trend" id="c2d-trend-req"></div>' +
        '<div class="c2d-axis" id="c2d-axis-req"></div>' +
        '<div class="c2d-muted" style="font-size:11px;margin-top:3px">每日请求数</div></div>' +
        '<div><div class="c2d-trend" id="c2d-trend-tok"></div>' +
        '<div class="c2d-axis" id="c2d-axis-tok"></div>' +
        '<div class="c2d-muted" style="font-size:11px;margin-top:3px">每日 Token 总量</div></div>' +
        "</div>") +
      section("渠道账号与余额", renderAccounts(d)) +
      section("积分收支", renderCredits(d)) +
      section("模型分布", renderModels(d)) +
      section("自动签到", renderCheckin(d));

    const days = (d.usage && d.usage.days) || [];
    renderTrend("c2d-trend-req", "c2d-axis-req", days, function (x) { return x.requests; }, fmt);
    renderTrend("c2d-trend-tok", "c2d-axis-tok", days,
      function (x) { return (x.inTokens || 0) + (x.outTokens || 0); }, fmtTokens);

    if (sub) {
      sub.textContent = "快照 " + ago(d.generatedAt) + " · 每 30 秒自动刷新 · 余额最多缓存 5 分钟，数据全部读本机文件";
    }
  }

  if (window.__c2Shell) {
    window.__c2Shell.registerView("overview", { mount: mount, onShow: onShow, onHide: onHide });
  } else {
    console.error("[dashboard-ui] 外壳 admin-shell.js 未加载，总览无处挂载");
  }
})();
`
