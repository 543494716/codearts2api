// 子进程管理 —— 创建标志、进程树终止、存活探测。
//
// ## 为什么需要这个文件
//
// 两件事都必须在这里做对，否则用户看到的就是「关掉窗口，后台还在」：
//
// ### 1. 不让 node 弹自己的控制台
//
// 启动器本身是 GUI 子系统（`-H windowsgui`），双击没有黑框。**但 node.exe 是控制台
// 子系统程序**：被「没有控制台」的进程启动时，Windows 会**为它新建一个控制台窗口**
// （标题就是 node.exe 的完整路径）。所以必须带 `CREATE_NO_WINDOW`。
//
// ### 2. 关窗口要真的把**整棵进程树**停掉
//
// 只 `Kill()` node 本体是不够的：node 会派生子进程（zcode 的 chromium、网关等），
// 杀掉父亲后它们会被重新挂到别处，继续占着端口 —— 这就是「软件关了、后台还在」。
// 因此用 `taskkill /T` 按**进程树**终止。
package main

import (
	"os/exec"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"
)

// createNoWindow 是 Win32 的 `CREATE_NO_WINDOW` 进程创建标志。
const createNoWindow = 0x08000000

/** `OpenProcess` 的最小权限：只要能查退出码即可（查活不需要更多权限）。 */
const processQueryLimitedInformation = 0x1000

/** `GetExitCodeProcess` 的「仍在运行」哨兵值。 */
const stillActive = 259

/**
 * shuttingDown 标记「这次退出是我们主动停服」。
 *
 * ## 为什么必须有它（真实缺陷）
 *
 * 用户关窗 → 我们终止 node → `Wait()` 返回一个 error（因为它被杀了）。若不区分，
 * 这个**正常关闭**会被当成崩溃，弹出「服务异常退出（node 退出码 1）」。
 * 截图里的那个错误框就是这么来的。
 *
 * 用原子布尔而不是普通变量：写方是关窗那条 goroutine，读方是主 goroutine。
 */
var shuttingDown atomic.Bool

/** markShuttingDown 标记正在主动停服。 */
func markShuttingDown() {
	shuttingDown.Store(true)
}

/** isShuttingDown 报告是否正在主动停服。 */
func isShuttingDown() bool {
	return shuttingDown.Load()
}

/**
 * hiddenSysProcAttr 返回「不分配控制台窗口」的子进程属性。
 *
 * 用于拉起 node / taskkill：它们继承我们的 stdout/stderr（已接到日志文件），
 * 因此**不需要**控制台也能正常输出，日志不会因此丢失。
 */
func hiddenSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

/**
 * processAlive 报告某个 PID 是否仍然存活。
 *
 * 用 `OpenProcess` + `GetExitCodeProcess`，而不是 `os.FindProcess`：
 * 后者在 Windows 上**总能成功**（它不检查进程是否存在），据此判断会永远为真。
 */
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle)

	var code uint32
	if err := syscall.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == stillActive
}

/**
 * stopProcessTree 终止 node 及其**全部子孙进程**。
 *
 * 顺序是「先礼后兵」：
 *
 * 1. `taskkill /PID <pid> /T`（不带 `/F`）—— 请进程自己退出。node 无窗口，
 *    通常不响应，但成本极低；响应了就能走完自己的清理（关网关端口等）；
 * 2. 等最多 4 秒；
 * 3. `taskkill /PID <pid> /T /F` —— 强制终止**整棵树**。
 *
 * ⚠️ 为什么最后一定要 `taskkill /T` 而不是 `Process.Kill()`：后者只杀一个进程，
 * node 的子进程（chromium 等）会活下来继续占资源与端口。
 */
func stopProcessTree(pid int) {
	if pid <= 0 {
		return
	}
	runTaskkill(pid, false)

	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}

	runTaskkill(pid, true)
}

/**
 * runTaskkill 执行一次 taskkill。
 *
 * 失败**不报错**：进程可能已经自己退出了（那正是我们想要的结果）。
 */
func runTaskkill(pid int, force bool) {
	args := []string{"/PID", strconv.Itoa(pid), "/T"}
	if force {
		args = append(args, "/F")
	}
	command := exec.Command("taskkill", args...)
	command.SysProcAttr = hiddenSysProcAttr()
	_ = command.Run()
}
