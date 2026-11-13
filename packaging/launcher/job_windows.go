// Job Object —— 让 node 的生命周期**强制**绑定在启动器上。
//
// ## 为什么光靠「关窗时 taskkill」还不够
//
// 那条路能处理「用户正常关窗口」，但处理不了这几件事：
//
// - 用户从**任务管理器结束**启动器进程（`TerminateProcess`，没有任何清理机会）；
// - 启动器自己崩溃 / 被别的安全软件杀掉；
// - 用户注销时系统强杀进程树。
//
// 上述任何一种都会让 node 变成**孤儿**：它继续占着 8080 与 8326，下次双击就报
// 「端口已被占用」→ node 退出码 1 → 弹出「服务异常退出」。这正是用户报的
// 「关闭 exe 软件，未把软件相关后台关闭」的完整链条。
//
// ## 解法：把 node 放进一个 Job Object，并开启 KILL_ON_JOB_CLOSE
//
// Windows 的 Job Object 有一条语义：**最后一个句柄被关闭时，杀掉 job 内的所有进程**。
// 启动器持有那个句柄；进程无论怎么死，句柄都会被系统回收 ⇒ 子进程必死。
// 这是唯一能在 `TerminateProcess` 场景下也生效的办法。
package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	jobKernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW      = jobKernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObj  = jobKernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObj = jobKernel32.NewProc("AssignProcessToJobObject")
	procCloseHandle           = jobKernel32.NewProc("CloseHandle")
)

/** `JOBOBJECTINFOCLASS` 里 ExtendedLimitInformation 的编号。 */
const jobObjectExtendedLimitInformationClass = 9

/**
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` —— job 句柄全关时杀掉成员进程。
 *
 * 这个值（0x2000）是整套兜底的核心；没有它，job 只是个空容器。
 */
const jobObjectLimitKillOnJobClose = 0x2000

/** `OpenProcess` 需要的权限：设置配额（加入 job）+ 终止。 */
const (
	processTerminate = 0x0001
	processSetQuota  = 0x0100
)

/*
 * 下面三个 struct 必须与 Win32 的布局**逐字节一致**（x64）：
 * DWORD 后面要留 4 字节对齐到 SIZE_T/ULONG_PTR，Go 的自动对齐刚好吻合，
 * 但字段顺序与类型不能改。
 */

type jobBasicLimitInformation struct {
	perProcessUserTimeLimit int64
	perJobUserTimeLimit     int64
	limitFlags              uint32
	minimumWorkingSetSize   uintptr
	maximumWorkingSetSize   uintptr
	activeProcessLimit      uint32
	affinity                uintptr
	priorityClass           uint32
	schedulingClass         uint32
}

type jobIOCounters struct {
	readOperationCount  uint64
	writeOperationCount uint64
	otherOperationCount uint64
	readTransferCount   uint64
	writeTransferCount  uint64
	otherTransferCount  uint64
}

type jobExtendedLimitInformation struct {
	basicLimitInformation jobBasicLimitInformation
	ioInfo                jobIOCounters
	processMemoryLimit    uintptr
	jobMemoryLimit        uintptr
	peakProcessMemoryUsed uintptr
	peakJobMemoryUsed     uintptr
}

/**
 * createKillOnCloseJob 创建一个「句柄关闭即杀成员」的 job。
 *
 * 返回 `0` 表示创建失败 —— 调用方应当**继续运行**（退化为「关窗时 taskkill」那条路），
 * 不要因为拿不到这层保险就不让程序启动。
 */
func createKillOnCloseJob() uintptr {
	job, _, _ := procCreateJobObjectW.Call(0, 0)
	if job == 0 {
		return 0
	}

	var info jobExtendedLimitInformation
	info.basicLimitInformation.limitFlags = jobObjectLimitKillOnJobClose

	result, _, _ := procSetInformationJobObj.Call(
		job,
		uintptr(jobObjectExtendedLimitInformationClass),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if int32(result) == 0 {
		procCloseHandle.Call(job)
		return 0
	}
	return job
}

/**
 * assignToJob 把某个 PID 放进 job。
 *
 * 失败只记日志：Windows 8 以前不支持嵌套 job，若本进程已在别的 job 里，
 * 这里会失败 —— 那种环境下仍有「关窗时 taskkill /T」兜着。
 */
func assignToJob(job uintptr, pid int) error {
	if job == 0 || pid <= 0 {
		return fmt.Errorf("job 或 pid 无效")
	}
	handle, err := syscall.OpenProcess(processTerminate|processSetQuota, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("打开进程失败：%w", err)
	}
	defer syscall.CloseHandle(handle)

	result, _, callErr := procAssignProcessToJobObj.Call(job, uintptr(handle))
	if int32(result) == 0 {
		return fmt.Errorf("加入 job 失败：%v", callErr)
	}
	return nil
}
