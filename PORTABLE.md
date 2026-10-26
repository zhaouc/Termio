# Termio Windows 便携版

GitHub Actions 的 **Build Windows** 任务同时产出普通 NSIS 安装版 EXE 和 **Portable ZIP**。

## 数据存储

**无论安装版或便携版，数据库都固定保存在程序 EXE 所在目录的 `data/termio.sqlite`。** 程序首次运行会自动建立 `data` 目录。数据库、WAL 与 SHM 文件都会留在这个 `data` 目录，不会写入 Windows 用户应用数据目录。启动方式、快捷方式的工作目录不同也不会改变数据库位置。

例如解压到 `D:\Tools\Termio\`，数据库路径就是 `D:\Tools\Termio\data\termio.sqlite`。

**程序目录必须可写。** 建议解压或安装到用户拥有写权限的位置，例如 `D:\Tools\Termio\`；如果放在需要管理员权限的 `Program Files` 目录，可能因无法创建 `data` 而导致启动失败。移动程序时，把 EXE 和 `data` 文件夹一起移动。历史记录统一保留最近 **2 天**。

已在之前版本存入 `%APPDATA%` 或其他旧用户数据目录的数据库不会自动迁入新的 `data` 文件夹，需要先备份，再手动迁移到 EXE 旁的 `data/termio.sqlite`。

## 使用说明

1. 在 GitHub Actions 下载 `termio-1.0.0-windows-x86_64-portable` 构建产物并解压 ZIP。
2. 将 `Termio-Portable` 文件夹放到有写权限的位置。
3. 双击 `Termio.exe` 即可运行，无须安装；`data` 目录在运行后自动创建。
4. Windows 需要安装 **Microsoft Edge WebView2 Runtime**。大部分 Windows 10/11 已预装。

已保存的 SSH 密码由 Windows Credential Manager 管理，不会随数据库一起被复制。迁移设备时建议使用 SSH Config / SSH 密钥。

在“设置 → 窗口行为”中，可分别设置**最小化按钮**（默认最小化到 Windows 任务栏，也可隐藏到系统托盘）和**关闭按钮**（默认隐藏到系统托盘，也可直接退出程序）。托盘图标左键恢复窗口，右键菜单仅显示“退出Termio”，该退出操作始终会结束程序。Windows 只允许打开一个 Termio 实例：重复双击 EXE 或快捷方式时，会直接恢复已打开（包括任务栏最小化或隐藏到托盘）的窗口，不新建页面、不重置终端会话。

## 编译

在 GitHub 仓库的 Actions → Build Termio → Run workflow 运行构建，可分别获取 Windows 安装版 EXE 和便携版 ZIP。

## 文件数限制

只限制**源代码项目中被 Git 跟踪的文件总数**不超过 **99**（使用 `git ls-files` 检查，也包含配置与说明文档）；不限制 Windows 安装版、便携版 ZIP、解压后的目录，以及运行中生成的 SQLite 等数据文件数量。
