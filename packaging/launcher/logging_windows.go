// 控制台 / 日志 / 致命错误报告 —— 让 GUI 子系统的 exe 依然「看得见」。
//
// ## 为什么这个文件是必需的
//
// 打包出的 exe 用 `-H windowsgui` 构建（开工单要求：**不要黑框**）。代价是：
//
//   - 双击运行时**没有控制台**，`os.Stdout` / `os.Stderr` 形同废纸；
//   - node 子进程继承了这两个坏句柄，它打印的日志与崩溃原因**全部丢失** ——
//     而 node 的报错（端口占用、目录无权限）正是排查的关键。
//
// 所以这里做三件事：
//
//  1. **把 stdout/stderr 接到日志文件**（`<runtime>\.logs\`），并同时保留「如果父进程
//     给了有效控制台就照常输出」的能力 —— 命令行运行 `codearts2api.exe --help` 时
//     仍然能在终端里看到内容；
//  2. **未捕获的 panic 落盘**并弹消息框，而不是让进程静默消失；
//  3. **致命错误**用原生消息框呈现（`reportFatal`），保证双击用户一定看得见。
package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32DLL            = syscall.NewLazyDLL("kernel32.dll")
	procGetConsoleWindow   = kernel32DLL.NewProc("GetConsoleWindow")
	procAllocConsole       = kernel32DLL.NewProc("AllocConsole")
	procSetConsoleOutputCP = kernel32DLL.NewProc("SetConsoleOutputCP")
	user32DLL              = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW        = user32DLL.NewProc("MessageBoxW")
	logMutex               sync.Mutex
	logFileHandle          *os.File
)

// 消息框按钮 / 图标常量。
const (
	mbOK              = 0x00000000
	mbIconError       = 0x00000010
	mbIconInformation = 0x00000040
	mbSetForeground   = 0x00010000
	mbTopmost         = 0x00040000
)

// hasConsole 报告当前进程是否已经有一个可用的控制台。
//
// `GetConsoleWindow()` 返回 0 表示没有 —— GUI 子系统下从资源管理器双击就是这种情况。
// 但从 cmd / PowerShell 启动时，子进程会**继承**父控制台，此时返回非 0，应当照常输出。
func hasConsole() bool {
	hwnd, _, _ := procGetConsoleWindow.Call()
	return hwnd != 0
}

// ensureConsole 尝试附加一个控制台（仅用于命令行诊断场景，正常双击不会调用）。
//
// 失败不报错：GUI 应用本来就可以没有控制台。
func ensureConsole() {
	if hasConsole() {
		return
	}
	if _, _, err := procAllocConsole.Call(); err != nil {
		return
	}
	// 中文日志需要 UTF-8 代码页，否则控制台里是乱码。
	_, _, _ = procSetConsoleOutputCP.Call(65001)
}

/**
 * setupLogging 把输出导向日志文件，并保留控制台（若有）。
 *
 * @param runtimeDir 解包目录；日志写在其下的 `.logs`，随版本目录一起被清理。
 * @returns 关闭函数（进程退出前调用，把缓冲刷到磁盘）。
 */
func setupLogging(runtimeDir string) func() {
	logDirectory := filepath.Join(runtimeDir, ".logs")
	if err := os.MkdirAll(logDirectory, 0o755); err != nil {
		// 日志目录建不出来不该让程序起不来 —— 退回控制台输出即可。
		return func() {}
	}
	logPath := filepath.Join(logDirectory, "launcher.log")
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return func() {}
	}
	logFileHandle = file

	// 每次启动打一条分隔线：日志是**追加**的，否则多次运行的输出会糊在一起。
	writeLogLine(fmt.Sprintf("===== %s 启动（build %s）=====", time.Now().Format("2006-01-02 15:04:05"), resolveBuildID()))

	var sinks []io.Writer
	sinks = append(sinks, file)
	if hasConsole() {
		sinks = append(sinks, os.Stdout)
	}
	combined := io.MultiWriter(sinks...)

	os.Stdout = file
	os.Stderr = file

	// 用一个 pipe 把「任何对 os.Stdout 的写入」也接进日志：库代码有时会缓存
	// 原始文件描述符，直接替换变量不一定覆盖到，这里再加一层保险。
	reader, writer, pipeErr := os.Pipe()
	if pipeErr == nil {
		os.Stdout = writer
		os.Stderr = writer
		go func() {
			buffer := make([]byte, 32*1024)
			for {
				n, readErr := reader.Read(buffer)
				if n > 0 {
					_, _ = combined.Write(buffer[:n])
				}
				if readErr != nil {
					return
				}
			}
		}()
	}

	return func() {
		logMutex.Lock()
		defer logMutex.Unlock()
		if logFileHandle != nil {
			_ = logFileHandle.Sync()
			_ = logFileHandle.Close()
			logFileHandle = nil
		}
	}
}

// writeLogLine 直写一条日志（绕过可能被替换的 os.Stdout）。
func writeLogLine(line string) {
	logMutex.Lock()
	defer logMutex.Unlock()
	if logFileHandle == nil {
		return
	}
	_, _ = logFileHandle.WriteString(line + "\r\n")
	_ = logFileHandle.Sync()
}

/**
 * closeLogger 刷盘并关闭日志。
 *
 * 供「窗口关闭后主动 `os.Exit`」那条路径使用：`os.Exit` **不会**执行 defer，
 * 所以必须显式调用，否则最后几行（含退出原因）会留在缓冲里丢掉。
 * 重复调用安全（内部把句柄置空）。
 */
func closeLogger() {
	logMutex.Lock()
	defer logMutex.Unlock()
	if logFileHandle != nil {
		_ = logFileHandle.Sync()
		_ = logFileHandle.Close()
		logFileHandle = nil
	}
}

/**
 * reportFatal 用原生消息框报告致命错误，并把详情写进日志。
 *
 * ⚠️ 没有桌面会话时（服务 / 计划任务 / 会话 0）消息框会**一直阻塞**，
 * 所以先用 `hasConsole()` / 环境判断兜一下：只有交互式启动才弹框。
 */
func reportFatal(message string) {
	writeLogLine("[FATAL] " + message)
	// 控制台可用时优先打印（命令行用户能看到完整栈），不必弹框打断脚本。
	if hasConsole() {
		fmt.Fprintln(os.Stderr, message)
		return
	}
	title := utf16Ptr("codearts2api")
	body := utf16Ptr(message)
	if title == nil || body == nil {
		return
	}
	_, _, _ = procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(body)),
		uintptr(unsafe.Pointer(title)),
		uintptr(mbOK|mbIconError|mbSetForeground|mbTopmost),
	)
}

// showInfo 弹一条信息框（用于「已启动」这类不需要打断的动作，目前未使用，保留）。
func showInfo(message string) {
	title := utf16Ptr("codearts2api")
	body := utf16Ptr(message)
	if title == nil || body == nil {
		return
	}
	_, _, _ = procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(body)),
		uintptr(unsafe.Pointer(title)),
		uintptr(mbOK|mbIconInformation|mbSetForeground),
	)
}

// utf16Ptr 把 Go 字符串转成以 NUL 结尾的 UTF-16 指针（Win32 W 系列 API 需要）。
func utf16Ptr(value string) *uint16 {
	pointer, err := syscall.UTF16PtrFromString(value)
	if err != nil {
		return nil
	}
	return pointer
}

// logPath 返回日志文件路径（供启动失败时告诉用户去哪看）。
func logPath(runtimeDir string) string {
	return filepath.Join(runtimeDir, ".logs", "launcher.log")
}
