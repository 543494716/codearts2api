import js from "@eslint/js"
import prettier from "eslint-config-prettier"
import globals from "globals"

/**
 * ESLint 配置（flat config）。
 *
 * 与 `../oc2api` 的写法保持一致（`js.configs.recommended` + `eslint-config-prettier`
 * 收尾），差异只有三处，都是本项目特有的：
 *
 * 1. **编译产物必须排除** —— `public/admin.js` 与 `public/upstream-jet-hub.js`
 *    是构建时从上游拷贝/打包出来的（合计约 1.6MB 压缩前代码）。它们既不是
 *    本仓库的代码，也会让 lint 耗时从 1 秒级涨到分钟级。
 * 2. **有 JSX 与浏览器端代码** —— `web/admin.jsx` 跑在浏览器里（用到 `document`
 *    / `fetch` 等），需要 `globals.browser`；其余文件是 Node 端，用
 *    `globals.node`。若混用，`web/` 里会报一堆 `no-undef`，而 `src/` 里
 *    报不出真问题。
 * 3. **`.jsx` 要显式列进 `files`** —— flat config 默认只匹配 `*.js`，
 *    不写的话 `web/admin.jsx` 会被静默跳过（不报错、也不检查）。
 */
export default [
  {
    // ⚠️ 编译产物与依赖目录：见文件头第 1 点。
    //    `public/admin.html` 是**手写源码**，不在此列（它不是产物）。
    ignores: [
      "node_modules/",
      "public/admin.js",
      "public/upstream-jet-hub.js",
      // 单文件 exe 打包的中间产物：`packaging/stage/` 里是**源码副本 + 整份生产依赖**
      // （含上游与第三方包的源码），`packaging/launcher/payload.zip` 是压好的载荷。
      // 让 lint 去读它们既不是本仓库代码，也会把耗时从秒级拖到分钟级。
      "packaging/stage/",
      "packaging/launcher/payload.zip",
      "packaging/.gopath/",
      "packaging/.gocache/",
      "dist/",
      // 运行时状态目录（若把 CODEARTS2API_HOME 指到仓库内）：
      // `attachments/` 存的是二进制图片，让 lint 去读它们纯属浪费。
      "data/",
      "attachments/",
      "coverage/",
      ".git/",
      ".build-tools/",
    ],
  },
  js.configs.recommended,
  {
    // Node 端：src/、tests/、build.mjs（ESM）
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    // 浏览器端入口（含 JSX）。`.jsx` 必须显式列出，否则不会被检查。
    files: ["**/*.jsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // JSX 语法需要 parserOptions；esbuild 负责真正的转换，这里只是让 lint 认。
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
  },
  {
    // 手写的**浏览器端**普通脚本（不是构建产物，所以要检查；但它跑在浏览器里）。
    //
    // ⚠️ `public/admin-boot.js` 必须在 Node 端规则**之后**声明：上面那条
    //    `files: ["**/*.js"]` 会先匹配到它并塞进 `globals.node`，而这条后置的
    //    配置才能把 `window` 补上（flat config 是「后者覆盖前者」的合并顺序）。
    //    `public/admin.js` 与 `upstream-jet-hub.js` 是构建产物，已在 ignores 里。
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },
  {
    // 测试与被引用的入口里，有些变量只能靠约定（如 `_unused` 前缀）。
    // 与 oc2api 不同的是本项目有测试目录，故单独放宽几条。
    files: ["tests/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  prettier,
]
