// codearts2api 桌面窗口：用系统自带的 WebView2 承载 `/admin` 界面。
//
// ## 为什么单独一个文件
//
// 窗口与自解压是两件互不相关的事：解包、拉起 node、传退出码都不依赖窗口；
// 只有在 Windows 上、且系统装了 WebView2 时才谈得上「内嵌界面」。分开写能让
// `main.go` 保持简单，也让「没有 WebView2 就回退到外部浏览器」这条分支清晰。
//
// ## 为什么用 `go-webview2`，而不是自己调 COM
//
// 自己声明 COM vtable（按索引调 `put_Bounds` / `get_CoreWebView2` / `Navigate`）
// 看起来「少一个依赖」，但那些索引写错一位就是**静默失败**：窗口一片空白、没有
// 任何报错。`go-webview2` 是纯 Go 实现（没有 cgo）、把 WebView2Loader 的加载与
// 接口声明都封装好了，产物仍然**不带额外 .dll**（它内部按需从系统 Edge 目录取），
// 与「一个 exe」的目标不冲突。
//
// ## 硬前提
//
// 系统必须装有 **WebView2 Runtime**（Win11 与装了新版 Edge 的 Win10 默认都有）。
// 缺失时 {@link webView2Available} 返回 false，调用方回退到「用外部浏览器打开」——
// 那是降级，不是错误。
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	webview2 "github.com/jchv/go-webview2"
)

// procIsWindow / procIsWindowVisible 用于关窗检测。
var (
	windowUser32        = syscall.NewLazyDLL("user32.dll")
	procIsWindow        = windowUser32.NewProc("IsWindow")
	procIsWindowVisible = windowUser32.NewProc("IsWindowVisible")
)

// 窗口默认尺寸（与 `/admin` 的三栏布局相称：侧栏 + 内容 + 右侧面板）。
const (
	windowWidth  = 1280
	windowHeight = 860
)

// webView2Available 报告「本机能否内嵌界面」。
//
// 判据是**找得到系统 WebView2 运行时**（`EBWebView` 的安装目录或已注册的版本）。
// 只看「有没有 msedgewebview2.exe」比查注册表更直接，也不受安装方式影响。
func webView2Available() bool {
	for _, root := range []string{
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "EdgeWebView", "Application"),
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "EdgeWebView", "Application"),
	} {
		if root == "" {
			continue
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			if fileExists(filepath.Join(root, entry.Name(), "msedgewebview2.exe")) {
				return true
			}
		}
	}
	return false
}

// fileExists 判断普通文件是否存在。
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

/**
 * openAppWindow 打开内嵌窗口并加载 url，**阻塞到窗口关闭**。
 *
 * 返回的 error 只表示「窗口根本没起来」（例如 WebView2 初始化失败），调用方据此
 * 决定是否回退到外部浏览器。
 *
 * ## ⚠️ 关窗检测为什么不能靠 `Run()` 返回
 *
 * 实测 `go-webview2` 的 `Run()` 只处理自定义 `WMApp` 消息：既不看 `GetMessage`
 * 的返回值，也不处理 `WM_QUIT` ⇒ 用户关掉窗口后它**永不返回**。所以「关窗 → 停服」
 * 这条链路不能建立在「等 Run 返回」上。
 *
 * ## ⚠️⚠️ 但 `Run()` **必须留在当前线程**（这是上一版把窗口搞死机的原因）
 *
 * WebView2 的窗口与 COM 对象都绑定在**创建它们的那个 OS 线程**上，消息循环必须在
 * 同一个线程里跑。曾经为了「等 Run 返回」把它丢进独立 goroutine —— 结果消息循环
 * 跑到了别的线程，窗口收不到任何消息，表现为**界面点不动（假死）**。
 *
 * ## 现在的做法
 *
 * - `Run()` 保留在本线程（本函数已被 `LockOSThread` 保护），界面正常响应；
 * - 另起一个**看门狗** goroutine 轮询窗口可见性，用户点 X 后立即结束整个进程。
 *
 * 看门狗直接 `os.Exit` 而不是「让 Run 返回」：既然 Run 不会返回，就没有优雅退出的
 * 机会；而正常退出所需的事（停 node 与进程树）由调用方注册的清理逻辑完成 ——
 * 这里改为通知调用方，由它停服后再退出。
 */
func openAppWindow(url, title, dataPath string, onClosed func()) error {
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug: false,
		// ⚠️ 必须显式给 DataPath：默认值是 `%AppData%\<exe 文件名>`，而 WebView2 对
		//    该目录的写权限有要求；放在我们自己的解包目录下更可控，也避免与其它
		//    同名程序互相覆盖缓存。
		DataPath:  dataPath,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  title,
			Width:  windowWidth,
			Height: windowHeight,
			Center: true,
		},
	})
	if w == nil {
		return fmt.Errorf("WebView2 初始化失败（系统可能未安装 WebView2 运行时）")
	}
	defer w.Destroy()

	// 先 Navigate 再 Run（这个库的调用是懒执行的）。
	w.Navigate(url)

	handle := uintptr(w.Window())

	// 看门狗：只观察、不碰消息循环，因此不会干扰 UI 线程。
	go func() {
		// 先等窗口真的可见 —— 创建是异步的，一上来就判可见性会把「还没显示」
		// 误判成「已经关了」。
		deadline := time.Now().Add(60 * time.Second)
		for time.Now().Before(deadline) {
			if windowVisible(handle) || !windowAlive(handle) {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		// 已可见（或已消失）：等用户关窗。
		for windowAlive(handle) && windowVisible(handle) {
			time.Sleep(250 * time.Millisecond)
		}
		onClosed()
	}()

	// ⚠️ **必须在本线程调用 Run**：它会跑起来窗口消息循环。
	//    移到 goroutine 里 = 消息循环跑错线程 = 界面假死。
	w.Run()
	return nil
}

/**
 * windowAlive 判断窗口句柄是否仍然指向一个存在的窗口。
 *
 * `IsWindow` 对已销毁的句柄返回 FALSE。
 */
func windowAlive(handle uintptr) bool {
	if handle == 0 {
		return false
	}
	result, _, _ := procIsWindow.Call(handle)
	return result != 0
}

/**
 * windowVisible 判断窗口当前是否可见。
 *
 * 用户点 X 关闭窗口后，Windows 会先把窗口隐藏（`WS_VISIBLE` 清除），随后销毁。
 * 观察「不可见」比等「已销毁」更早、也更可靠 —— 因为库可能会拦截销毁流程。
 */
func windowVisible(handle uintptr) bool {
	if handle == 0 {
		return false
	}
	result, _, _ := procIsWindowVisible.Call(handle)
	return result != 0
}

/**
 * windowTitle 生成窗口标题，带上端口，便于同时开多个实例时区分。
 */
func windowTitle(port int) string {
	title := "codearts2api · 管理后台"
	if port > 0 {
		title = strings.Join([]string{title, fmt.Sprintf("(127.0.0.1:%d)", port)}, " ")
	}
	return title
}
