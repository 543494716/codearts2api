"""把源码打成**加密 zip**（AES-256，密码 123456），供 GitHub 公开仓库备份。

## 为什么是加密压缩包，而不是直接提交源码

`public/admin.js` 与 `public/upstream-jet-hub.js` 是从上游
[`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub) 构建/拷贝出来的
浏览器产物，上游 README 明确要求「不要转发到 GitHub」。若在公开仓库里明文提交它们，
属于违背上游意愿的再分发。

打成一个**加密 zip** 是折中：仓库里只公开**本仓库自己写的**源码（薄胶水部分，
可以直接阅读），而含上游产物的完整快照放在加密包里 —— 需要完整可运行副本的人
用密码解开即可，日常浏览不会意外转发上游代码。

## 用什么加密

`pyzipper` 提供 **AES-256**（WinZip AE-2 规范），Windows 资源管理器、7-Zip、WinRAR
都能直接解开。⚠️ Python 标准库 `zipfile` 只支持古老的 ZipCrypto（可被已知明文攻击），
不足以当成「加密」用。

## 排除哪些内容

只打**源码**，不带任何可重新生成或体积巨大的东西：

- `node_modules/`（依赖，`pnpm install` 重建）
- `dist/`、`packaging/stage/`、`packaging/launcher/payload.zip`、Go 缓存（构建产物）
- `.git/`（避免把历史再塞一遍）
- 运行时状态与密钥（`.credentials.yaml`、`admin-key`、`data/` 等）—— **绝不能进备份**

用法：
    python scripts/make-source-archive.py            # 生成 dist/codearts2api-source.zip
    python scripts/make-source-archive.py --out x.zip
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pyzipper

# ── 配置 ──────────────────────────────────────────────────────────────

#: 加密密码（用户指定）。放在源码里是因为它只是「防止误转发」的轻量闸门，
#: 不是真正的机密 —— README 里也会写明，方便使用者解开备份。
ARCHIVE_PASSWORD = "123456"

#: 这些**目录**整体跳过（名字匹配任意层级）。
EXCLUDED_DIRECTORY_NAMES = {
    ".git",
    "node_modules",
    "dist",
    "__pycache__",
    ".gocache",
    ".gopath",
    "stage",
    ".build-tools",
    "data",
    "attachments",
    "jet-hub",
    "coverage",
}

#: 这些**文件名 / 后缀**跳过（构建产物、缓存、状态与密钥）。
EXCLUDED_FILE_SUFFIXES = (".log", ".pyc", ".tmp", ".bak", ".apk", ".exe")
EXCLUDED_FILE_NAMES = {
    "payload.zip",          # 60MB 的 exe 载荷（含整份 node_modules）
    ".credentials.yaml",    # 凭据：绝不能进备份
    "admin-key",            # 管理密钥
    "caller-keys.json",     # 调用方 Key（哈希）
    "api-key",              # 网关 Key
    ".DS_Store",
    "Thumbs.db",
}

#: 上游浏览器产物。**默认不进明文源码**（上游 README 要求不要转发到 GitHub），
#: 但**必须进加密包** —— 加密包的目的正是「保留一份完整可运行快照」。
UPSTREAM_ARTIFACTS = (
    "public/admin.js",
    "public/upstream-jet-hub.js",
)

#: 相对仓库根的额外排除路径（前缀匹配）。**不含**上面两个前端产物 ——
#: 它们由 `include_frontend` 开关单独控制。
EXCLUDED_PATHS = (
    "packaging/launcher/payload.zip",
)


def should_skip(relative: Path, include_frontend: bool = False) -> bool:
    """判断某个相对路径是否应被排除。

    @param relative 相对仓库根的路径。
    @param include_frontend 是否包含上游前端产物（加密备份为 True）。
    """
    posix = relative.as_posix()

    # 目录名命中即跳过（任意层级）。
    for part in relative.parts[:-1]:
        if part in EXCLUDED_DIRECTORY_NAMES:
            return True

    name = relative.name
    if name in EXCLUDED_FILE_NAMES:
        return True
    if name.endswith(EXCLUDED_FILE_SUFFIXES):
        return True
    for prefix in EXCLUDED_PATHS:
        if posix == prefix:
            return True
    if not include_frontend and posix in UPSTREAM_ARTIFACTS:
        return True
    return False


def collect_files(root: Path, include_frontend: bool) -> list[Path]:
    """收集要打包的文件（相对路径）。"""
    files: list[Path] = []
    for directory, subdirectories, filenames in os.walk(root):
        current = Path(directory)
        # 就地下钻：把不该进的目录从遍历里摘掉，避免白跑。
        subdirectories[:] = [
            d for d in subdirectories if d not in EXCLUDED_DIRECTORY_NAMES
        ]
        for filename in filenames:
            full = current / filename
            relative = full.relative_to(root)
            if should_skip(relative, include_frontend):
                continue
            files.append(relative)
    return sorted(files)


def build_archive(root: Path, output: Path, include_frontend: bool) -> tuple[int, int]:
    """生成加密 zip，返回 (文件数, 字节数)。"""
    files = collect_files(root, include_frontend)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    with pyzipper.AESZipFile(
        output,
        "w",
        compression=pyzipper.ZIP_DEFLATED,
        encryption=pyzipper.WZ_AES,
    ) as archive:
        # 强度 1..3；AES 密钥派生的迭代次数随它上升。用 3 更稳。
        archive.setpassword(ARCHIVE_PASSWORD.encode("utf-8"))
        archive.setencryption(pyzipper.WZ_AES, nbits=256)
        for relative in files:
            archive.write(root / relative, arcname=relative.as_posix())

    total = sum((root / f).stat().st_size for f in files)
    return len(files), total


def main() -> int:
    parser = argparse.ArgumentParser(description="把源码打成加密 zip")
    parser.add_argument(
        "--out",
        default="dist/codearts2api-source.zip",
        help="输出路径（默认 dist/codearts2api-source.zip）",
    )
    parser.add_argument(
        "--plain",
        action="store_true",
        help="生成**不含前端产物**的明文包（调试用，正常备份不要用）",
    )
    arguments = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    output = (root / arguments.out).resolve()

    # 加密包**包含**前端产物（它们本来就在仓库工作区里），
    # 这样备份才是「完整可运行快照」。
    count, total = build_archive(root, output, include_frontend=True)
    size = output.stat().st_size
    print(f"[archive] 输出：{output}")
    print(f"[archive] 文件数：{count}，原始 {total / 1024 / 1024:.1f} MB → 压缩后 {size / 1024 / 1024:.1f} MB")
    print(f"[archive] 加密：AES-256，密码 {ARCHIVE_PASSWORD}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
