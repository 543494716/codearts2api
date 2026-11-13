// codearts2api 单文件启动器。
//
// ## 为什么是「自解压 + 拉起 node」而不是 Node SEA
//
// 本项目运行期依赖两个**原生模块**，它们都必须以真实文件的形式存在于磁盘上：
//
//   - `sharp`（官方附件包用来校验/缩放图片）→ `@img/sharp-win32-x64/lib/*.node`
//   - `wreq-js`（OpenCode 通道的 TLS 指纹）→ `@wreq-js/binding-win32-x64-msvc/*.node`
//
// Node 的单可执行文件（SEA）只能内联 **JS 与静态资产**：原生 `.node` 仍要从磁盘
// `require`，且 ESM 入口目前也不被 SEA 支持。所以「把整个工程塞进 node.exe」这条路
// 走不通 —— 只有把 node.exe 与依赖一起作为载荷，首次运行解包到本地缓存，再拉起它。
//
// ## 行为边界（刻意保持最小）
//
//   - 解包目录：`%LOCALAPPDATA%\codearts2api\runtime\<构建号>`，按内容哈希分目录，
//     所以升级后自动用新目录，不会读到上一版的半旧依赖；
//   - 运行参数与环境变量**原样透传**给 node 进程（`PORT` / `CODEARTS2API_HOME` 等照旧生效）；
//   - 不装服务、不改注册表。
//
// ## 双击体验：**绝不能闪退**
//
// 用户是双击运行的 —— 程序一退出 cmd 窗口就关，任何错误都来不及看。所以这里：
//
//  1. 解包阶段出错 → 打印原因 + 停住窗口等回车；
//  2. node 起来后**异常退出**（端口被占、目录没权限、凭据权限不对…）→ 同样停住窗口，
//     并把「常见原因 + 怎么改」一起打出来，而不是只丢一个退出码；
//  3. 正常运行时先探到端口通了，**自动打开浏览器**（双击的人最期待这个）。
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// payload 是构建期打进去的应用载荷（node.exe + src + public + node_modules）。
//
//go:embed payload.zip
var payload []byte

// buildID 由构建脚本用 -ldflags -X main.buildID=<内容哈希前 12 位> 注入。
// 留空时退化为对内存中的载荷现算一次（便于本地直接 `go run` 调试）。
var buildID = ""

// resolveBuildID 返回本次载荷的构建号。
func resolveBuildID() string {
	if buildID != "" {
		return buildID
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])[:12]
}

// runtimeRoot 返回解包根目录（各版本各占一个子目录）。
// runtimeRootCandidates 返回**按优先级排列**的解包根目录候选。
//
// 为什么要有多个候选而不是只用 `%LOCALAPPDATA%`：那是最标准的落点，但确实存在
// 写不进去的机器 —— 受限用户配置文件、漫游/重定向的 AppData、以及某些沙箱 / 安全
// 软件把 `AppData` 拦成只读。此时程序不该直接「Access is denied」退出，而应退到
// 临时目录，最坏再退到 exe 所在目录（绿色便携用法）。
func runtimeRootCandidates() []string {
	// ① 显式指定优先 —— 便携部署 / 多实例隔离都靠它。
	if custom := strings.TrimSpace(os.Getenv("CODEARTS2API_RUNTIME_DIR")); custom != "" {
		return []string{custom}
	}

	var roots []string
	if base := os.Getenv("LOCALAPPDATA"); base != "" {
		roots = append(roots, filepath.Join(base, "codearts2api", "runtime"))
	} else if cache, err := os.UserCacheDir(); err == nil {
		roots = append(roots, filepath.Join(cache, "codearts2api", "runtime"))
	}
	if tmp := os.Getenv("TEMP"); tmp != "" {
		roots = append(roots, filepath.Join(tmp, "codearts2api", "runtime"))
	} else if tmp := os.Getenv("TMP"); tmp != "" {
		roots = append(roots, filepath.Join(tmp, "codearts2api", "runtime"))
	}
	if exe, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Join(filepath.Dir(exe), "codearts2api-runtime"))
	}
	if len(roots) == 0 {
		roots = append(roots, "codearts2api-runtime")
	}
	return roots
}

// ensureExtracted 保证载荷已解包到 dest。
//
// 幂等：`dest/.ready` 存在即认为上一轮已完成。解包先写 `<dest>.tmp-<pid>` 再整体
// 改名，这样**两个实例同时启动**时只会有一个真正落盘，另一个复用它的结果
// （改名在同盘上是原子的，输的一方删掉自己的临时目录即可）。
func ensureExtracted(dest string) error {
	if _, err := os.Stat(filepath.Join(dest, ".ready")); err == nil {
		return nil
	}

	parent := filepath.Dir(dest)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}

	staging := fmt.Sprintf("%s.tmp-%d", dest, os.Getpid())
	_ = os.RemoveAll(staging)
	if err := unzipTo(staging); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := os.WriteFile(filepath.Join(staging, ".ready"), []byte(resolveBuildID()), 0o644); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}

	// 另一个实例可能刚好抢先落地：此时复用它的目录，丢弃自己这份。
	if _, err := os.Stat(filepath.Join(dest, ".ready")); err == nil {
		_ = os.RemoveAll(staging)
		return nil
	}
	if err := os.Rename(staging, dest); err != nil {
		if _, statErr := os.Stat(filepath.Join(dest, ".ready")); statErr == nil {
			_ = os.RemoveAll(staging)
			return nil
		}
		_ = os.RemoveAll(staging)
		return fmt.Errorf("落盘解包结果失败：%w", err)
	}
	return nil
}

// unzipTo 把内嵌载荷解到 dir。
func unzipTo(dir string) error {
	reader, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return fmt.Errorf("载荷损坏（无法作为 zip 读取）：%w", err)
	}
	for _, entry := range reader.File {
		target := filepath.Join(dir, filepath.FromSlash(entry.Name))
		// 防目录穿越：载荷是本仓库自己打的，但这条检查近乎零成本。
		if !strings.HasPrefix(target, filepath.Clean(dir)+string(os.PathSeparator)) {
			return fmt.Errorf("载荷条目越出目标目录：%s", entry.Name)
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := writeZipEntry(entry, target); err != nil {
			return err
		}
	}
	return nil
}

// writeZipEntry 落单个文件。
func writeZipEntry(entry *zip.File, target string) error {
	source, err := entry.Open()
	if err != nil {
		return err
	}
	defer source.Close()

	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, source); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// pruneOldRuntimes 清掉同一个根目录下**别的**版本目录（仅限带 `.ready` 的本程序产物）。
//
// 存在的意义：每次升级都会解包出新的一份（约 150 MB），不清就会无限堆积。
// 收紧到「同根 + 有 .ready + 不是当前版本」，避免误删用户自己的东西。
func pruneOldRuntimes(root, current string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == current {
			continue
		}
		full := filepath.Join(root, entry.Name())
		if _, err := os.Stat(filepath.Join(full, ".ready")); err != nil {
			continue
		}
		_ = os.RemoveAll(full)
	}
}

func main() {
	// GUI 子系统没有控制台，panic / 致命错误必须自己兜住 —— 否则进程静默消失，
	// 用户只会看到「双击了没反应」。
	defer func() {
		if recovered := recover(); recovered != nil {
			reportFatal(fmt.Sprintf("启动器内部错误：%v", recovered))
			os.Exit(1)
		}
	}()

	// GUI 子系统没有控制台：越早把输出接到日志文件越好，否则解包阶段的报错会丢失。
	// 解包目录还没确定，先不建日志；`prepareRuntime` 之后立刻接入（见下）。
	id := resolveBuildID()
	dest, root, err := prepareRuntime(id)
	if err != nil {
		fail(err, "")
	}
	pruneOldRuntimes(root, id)

	// 从这里开始把 stdout/stderr 与 node 的输出一起落进 `<runtime>/.logs/launcher.log`。
	closeLog := setupLogging(dest)
	defer closeLog()

	node := filepath.Join(dest, "node.exe")
	if _, err := os.Stat(node); err != nil {
		fail(fmt.Errorf("解包结果里没有 node.exe（%s）：%w", node, err), "")
	}

	// ⚠️ `hiddenSysProcAttr()` 是「没有黑框」的关键补充：node.exe 是**控制台子系统**
	//    程序，被 GUI 进程拉起时 Windows 会为它新开一个控制台窗口（标题就是 node.exe
	//    路径）—— 那个窗口不是启动器的，所以只给启动器加 `-H windowsgui` 消不掉它。
	//    `CREATE_NO_WINDOW` 才不会为子进程分配控制台；日志不受影响，因为 stdout/stderr
	//    已经指向日志文件。
	command := exec.Command(node, append([]string{filepath.Join(dest, "src", "index.js")}, os.Args[1:]...)...)
	command.Dir = dest
	command.SysProcAttr = hiddenSysProcAttr()
	// node 继承我们的 stdout/stderr —— 而它们已经被 `setupLogging` 接到日志文件，
	// 所以 node 打印的「端口占用」「目录无权限」等关键信息不会丢。
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Env = os.Environ()

	// 端口用于「起来之后开界面」和「退出时判断是不是端口冲突」。
	port := resolvePort()

	// ## 为什么用 Start + Wait 而不是 Run
	//
	// `command.Run()` 内部会调用 `Wait()`。而关窗时要先拿到 PID 去终止进程树、
	// 再等它退出 —— 如果两边都调 `Wait()`，第二次会立刻返回
	// 「wait: no child processes」，被当成**异常退出** ⇒ 关个窗口却弹出
	// 「服务异常退出（node 退出码 1）」。所以这里 Start 一次、Wait 一次，只走一条路。
	if err := command.Start(); err != nil {
		fail(fmt.Errorf("拉起 node 失败：%w", err), "")
	}
	nodePid := command.Process.Pid

	// ⚠️ **进程树兜底**：把 node 放进「句柄关闭即杀成员」的 Job Object。
	//
	// 上面那条「关窗 → taskkill /T」只覆盖**正常关窗**。用户从任务管理器结束启动器、
	// 或启动器自己崩溃时，没有任何清理机会 —— node 会成为孤儿继续占着 8080/8326，
	// 下次双击就报「端口已被占用」（node 退出码 1，也就是截图里那个错误框）。
	// Job 句柄随进程消亡被系统回收 ⇒ 子进程必被连带终止，这是唯一能覆盖
	// `TerminateProcess` 的手段。
	//
	// 失败**不阻断启动**：老系统 / 嵌套 job 限制下可能失败，那时退化为 taskkill 那条路。
	if job := createKillOnCloseJob(); job != 0 {
		if err := assignToJob(job, nodePid); err != nil {
			fmt.Fprintf(os.Stderr, "[codearts2api] 进程树兜底未启用（%v），关窗仍会正常停服。\n", err)
			procCloseHandle.Call(job)
		}
		// ⚠️ 句柄**故意不关**：它在进程退出时由系统关闭，那一刻才会触发
		//    KILL_ON_JOB_CLOSE。提前关掉等于立刻杀死 node。
	}

	// 窗口关掉就该停服：否则会留下看不见的后台进程占着端口，
	// 下次双击反而报「端口已被占用」。
	//
	// ⚠️ 必须置位 `shuttingDown` 再终止：`Wait` 返回的错误来自「我们自己把它杀了」，
	//    那是**正常退出**，不该弹「服务异常退出」。这个标志就是区分两者的唯一依据。
	windowClosed := make(chan struct{})
	go func() {
		// ⚠️ **必须锁定 OS 线程**：Win32 窗口与 WebView2 的 COM 对象都绑定在创建它的
		//    那个系统线程上。Go 的 goroutine 默认会在线程间迁移，迁移之后
		//    `CreateCoreWebView2Controller` 的回调仍在别的线程上跑，
		//    实测表现为「controller 指针为 nil 但 HRESULT 看起来成功」→ 随后 nil 解引用 panic。
		//    `LockOSThread` 是这条路上唯一正确的解法，去掉它偶发崩溃会变成常态。
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		announceWhenReady(port, dest, windowClosed)
	}()

	go func() {
		<-windowClosed
		markShuttingDown()
		stopProcessTree(nodePid)
		// ⚠️ 这里**必须主动退出进程**：窗口关闭后那条 `w.Run()` 的消息循环不会返回
		//    （库不处理 WM_QUIT），主 goroutine 卡在 `command.Wait()` 之后的收尾上，
		//    启动器进程会「留在后台」。node 已停，直接结束自己即可。
		//
		//    退出前把日志刷盘：GUI 下没有控制台，日志文件是唯一的排查入口。
		closeLogger()
		os.Exit(0)
	}()

	waitErr := command.Wait()

	// 用户主动关窗导致的退出：静默收尾，不弹任何错误框。
	if isShuttingDown() {
		return
	}
	if waitErr != nil {
		exitError, ok := waitErr.(*exec.ExitError)
		if !ok {
			fail(fmt.Errorf("服务进程异常结束：%w", waitErr), "")
		}
		// 走到这里才是**真的**崩溃（启动就失败）：必须让用户看得见原因。
		detail := diagnose(exitError.ExitCode(), port, dest)
		fail(fmt.Errorf("服务异常退出（node 退出码 %d）", exitError.ExitCode()), detail)
	}
}

// resolvePort 取与 src/index.js 一致的默认端口（8080）。
//
// 只用于「探活 + 拼地址」，**不**做校验 —— 真正的校验在 node 里（非法值那边会明确报错）。
func resolvePort() int {
	raw := strings.TrimSpace(os.Getenv("PORT"))
	if raw == "" {
		return 8080
	}
	if port, err := strconv.Atoi(raw); err == nil && port > 0 && port <= 65535 {
		return port
	}
	return 8080
}

// announceWhenReady 等端口真正接受连接后，打开**程序自己的窗口**（内嵌界面）。
//
// 为什么要等而不是启动 node 后立刻开：本服务要装完 cordis 插件、起网关才会监听，
// 抢在前面打开只会得到一个「无法访问」的白屏。
//
// ## 优先内嵌窗口，缺 WebView2 才回退浏览器
//
// 「把界面封进 exe」的期待是双击后直接看到一个应用窗口，而不是跳到外部浏览器。
// 但 WebView2 运行时不是每台机器都有（Win10 且没装新版 Edge 的可能没有），
// 那种情况下**不能失败** —— 退回去用默认浏览器打开，功能一点不少。
func announceWhenReady(port int, runtimeDir string, windowClosed chan<- struct{}) {
	deadline := time.Now().Add(90 * time.Second)
	address := fmt.Sprintf("127.0.0.1:%d", port)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", address, 500*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			url := fmt.Sprintf("http://%s/admin", address)
			fmt.Printf("\n[codearts2api] 已启动：%s\n", url)
			// 关窗回调：只在**内嵌窗口**模式下由 `openAppWindow` 触发。
			// 浏览器模式下界面与进程无关，不该因为浏览器关了就杀服务。
			presentInterface(url, port, runtimeDir, func() {
				close(windowClosed)
			})
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	// 90 秒都没起来：让 main 走收尾，同时把地址打出来，用户可手动查看。
	fmt.Fprintln(os.Stderr, "[codearts2api] 服务在 90 秒内未监听端口，请检查上面的错误日志。")
	close(windowClosed)
}

// presentInterface 决定「界面怎么呈现给用户」，并在**用户关掉内嵌窗口**时回调 onClosed。
//
// 为什么要回调而不是靠返回值：内嵌窗口的消息循环不会返回（见 `openAppWindow` 注释），
// 关窗检测由它的看门狗 goroutine 完成，只能通过回调往上通知。
func presentInterface(url string, port int, runtimeDir string, onClosed func()) {
	if webView2Available() {
		fmt.Println("[codearts2api] 正在打开应用窗口…")
		if err := openAppWindow(url, windowTitle(port), filepath.Join(runtimeDir, "webview2-data"), onClosed); err == nil {
			return
		} else {
			// 初始化失败不该让程序「看起来没反应」：打出原因并回退浏览器。
			fmt.Fprintf(os.Stderr, "[codearts2api] 内嵌窗口打开失败（%v），改用默认浏览器。\n", err)
		}
	}
	fmt.Println("[codearts2api] 已在浏览器中打开；关闭本窗口即停止服务。")
	openBrowser(url)
}

// openBrowser 用系统默认浏览器打开地址。失败**不报错** —— 用户照着手动打开即可。
func openBrowser(url string) {
	command := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url)
	// 同样不要控制台：否则浏览器起来的同时会有一个 cmd 黑框闪一下。
	command.SysProcAttr = hiddenSysProcAttr()
	_ = command.Start()
}

// diagnose 给出「退出码 + 常见成因」的说明。
//
// 只做**提示**不做判定：真正的错误细节在 node 自己的输出里（已经落进日志文件）。
// 这里的作用是让用户知道「接下来该查什么」，而不是只看到一个退出码。
func diagnose(code int, port int, runtimeDir string) string {
	hints := []string{"完整日志：" + logPath(runtimeDir)}
	switch code {
	case 1:
		hints = append(hints,
			"",
			"常见原因（按下面对应的关键字查日志）：",
			"  · EADDRINUSE —— 端口被占用，换一个：set PORT=8090",
			fmt.Sprintf("  · EPERM / EACCES —— 状态目录或凭据文件不可写（当前端口 %d）", port),
			"     可换一个可写目录：set CODEARTS2API_HOME=D:\\codearts2api",
			"     注意：程序已内置「默认目录不可写就自动换位置」的回退，",
			"           若仍失败，说明连兜底目录也写不进去，请按日志里的路径排查。",
		)
	}
	return strings.Join(hints, "\n")
}

// prepareRuntime 逐个尝试候选根目录，返回**第一个**解包成功的位置。
//
// 「先试再定」而不是「先定再试」：根目录能不能写只有真写一次才知道，靠预检
// （比如 `os.OpenFile` 探针）反而会漏掉 AppData 被重定向到只读漫游目录这类情况。
func prepareRuntime(id string) (dest, root string, err error) {
	var attempts []string
	for _, candidate := range runtimeRootCandidates() {
		target := filepath.Join(candidate, id)
		if extractErr := ensureExtracted(target); extractErr != nil {
			attempts = append(attempts, fmt.Sprintf("%s → %v", candidate, extractErr))
			continue
		}
		return target, candidate, nil
	}
	return "", "", fmt.Errorf(
		"解包运行环境失败（已试过全部候选目录）：\n  %s\n"+
			"可以设环境变量 CODEARTS2API_RUNTIME_DIR 指定一个可写目录后重试。",
		strings.Join(attempts, "\n  "),
	)
}

// fail 报告致命错误并以非零码退出。
//
// ## 为什么不是「打印到 stderr + 等回车」
//
// 打包出的 exe 是 **GUI 子系统**（见 `console_windows.go`）：双击运行时根本没有
// 控制台窗口，`fmt.Println` 写到哪里都看不见，`stdin` 也不存在 —— 于是「停住窗口
// 等回车」成了空操作，用户只看到「双击后什么都没发生」。
//
// 所以改成两道出口：
//  1. **原生消息框**（有桌面时）—— 用户一定看得见，且带可复制的详细原因；
//  2. **日志文件**（`<runtime>\.logs\launcher.log`）—— 无人值守 / 服务场景没有桌面，
//     消息框会阻塞，此时只落盘。
//
// 停住窗口的职责交给消息框：它本身就是模态的，用户不点「确定」就不会消失。
func fail(err error, detail string) {
	message := fmt.Sprintf("%v", err)
	if strings.TrimSpace(detail) != "" {
		message += "\n\n" + detail
	}
	reportFatal(message)
	os.Exit(1)
}
