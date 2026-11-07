# Vibe Reader Desktop

Tauri 2 的 macOS 桌面入口。阅读器在独立窗口中打开，退出应用时关闭本次启动的 Python 后台。

## 从源码构建

需要 macOS 13+、Python 3.9+、Node.js 18+、Rust 与 Xcode Command Line Tools。

在仓库根目录执行：

```bash
./desktop/build.sh
```

构建脚本先生成本机配置，再安装锁定的 npm 依赖并调用 Tauri 构建。应用和 DMG 位于 `desktop/src-tauri/target/release/bundle/`。

生成的应用依赖构建时使用的 Python 和当前源码目录。移动源码目录后需要重新构建。这份 DMG 适合保留同一环境的本机使用，发布给其他电脑还需要处理 Python、源码打包与签名公证。

## 自定义材料库

默认读取仓库的 `library/`。复制 `localapp.spec.json` 为 `localapp.spec.local.json`，再修改其中的 `backend.args`：

```json
[
  "{project_root}/desktop/backend.py",
  "--library", "/path/to/notes",
  "--parallel-library", "/path/to/translations"
]
```

然后重新构建。带 `.local` 的配置文件被 Git 忽略；构建时优先使用它。公开模板中的 `python3` 会被替换为运行准备脚本的 Python 解释器路径。

生成的 `src-tauri/localapp.json` 和 `src-tauri/resources/project-root.txt` 包含本机配置，也被 Git 忽略。

## 启动与退出

- 后台仅监听 `127.0.0.1` 的动态端口，完成健康检查后显示阅读界面。
- 重复打开应用会激活已有窗口。
- 关闭窗口或 Command-Q 会等待正在导入的文件完成写入，再退出后台；超时后会结束本次应用所属进程。
- 后台检测到桌面父进程退出时会自行结束。
- 浏览器版另行启动的服务需要在对应终端停止。

字号、上次文档与阅读位置保存在 `~/Library/Application Support/Vibe-Reader-Desktop/preferences.json`。日志位于 `~/Library/Logs/Vibe-Reader-Desktop/`。

桌面版端口随会话变化，复制的地址适用于当前运行会话。需要跨次使用固定地址时，可以使用浏览器版的固定端口。
