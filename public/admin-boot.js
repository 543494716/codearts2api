/**
 * 页面启动前的 **模块加载器垫片**（`admin.html` 第一个执行的脚本）。
 *
 * ## 为什么它必须独立成文件，而不是内联在 `admin.html` 里
 *
 * 上游 bundle 的第一句就是 `window.__ModuleLoader__.load({ id, factory })`。
 * 若此时 `__ModuleLoader__` 还不存在，它直接抛 `Cannot read properties of
 * undefined (reading 'load')`，结果是**整页白屏**。所以这个垫片必须最先执行，
 * `admin.html` 里靠 `<script src>` 的**书写顺序**保证（不是 `defer` / `async`）。
 *
 * 初版是 `admin.html` 里的一段内联 `<script>`。改成独立文件是为了让
 * `script-src 'self'` 这条 CSP 成立 —— 内联脚本要么放行 `'unsafe-inline'`
 * （等于放弃 CSP 的主要价值），要么给 `admin.html` 做动态渲染插 nonce
 * （把一个静态文件变成需要模板的页面）。拆一个三行文件最省事。
 *
 * ⚠️ 它只**截留**那一行 `{ id, factory }`，不执行 factory —— 执行发生在
 * `admin.js` 里（它负责喂 `require('react')` 并按顺序渲染）。
 */
window.__ModuleLoader__ = {
  load: function (row) {
    window.__JET_HUB_ROW__ = row
  },
}
