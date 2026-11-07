# 首发验证记录

日期：2026-11-07。环境：macOS / Apple Silicon、Python 3.9.6、Node.js 25.9.0。

## 自动检查

- `python3 -m unittest discover -s tests -v`：22 项通过。
- `node --test tests/test_client.cjs`：12 项通过。
- `cargo check --manifest-path desktop/src-tauri/Cargo.toml --locked --offline`：通过。

覆盖文档与图片路径范围、搜索定位、原文行号与段号、缺译与合译、编号冲突、并发文档切换、导入完成后退出，以及桌面配置生成和本机覆盖配置。

## 干净导出与浏览器检查

从准备发布的 Git 文件导出到临时目录，在该目录启动服务，使用 Chrome 检查：

- 默认启动时文档库为空，仅扫描导入目录。
- 明确挂载示例后，显示一份普通文档和一份双语文档。
- 原文与中文译文配对展示。
- 使用 `DEMO-01§003` 定位第三段。
- 搜索中文关键词，展示文档名、原文行号和命中摘要。
- 浏览器未报告 JavaScript 错误。

README 截图来自这份干净导出中的原创示例。

## 本轮验证范围

本轮完成浏览器版使用检查、桌面后台协议测试和 Rust 编译检查。既有桌面窗口行为的历史验证记录保留在本机；本轮未重新生成或验收 DMG，也未在 Windows、Linux 上做图形界面测试。
