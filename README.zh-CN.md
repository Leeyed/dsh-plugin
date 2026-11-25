# dsh-direct-chat

[English](./README.md) | 简体中文

一个面向 DeepSeek Harness (`dsh`) 的插件，用于在 DSH Web 端与桌面端中直接连接 **Claude Code**、**Codex** 和 **Antigravity CLI (`agy`)**，提供统一的会话管理、多账号隔离、工作区工具链以及移动端适配界面。

## 核心特性

- **多引擎直连**：在同一个输入框和侧边栏中统一运行与管理 `claude`、`codex`、`agy` 会话。
- **多账号与配置隔离**：支持为每个 CLI 配置多个独立的 OAuth 或环境变量账号，支持会话级账号绑定与默认账号切换。
- **原生历史互通与归档**：支持导入本机终端原生 CLI 历史会话，并支持将对话归档或恢复回原生 CLI 存储。
- **状态与用量监控**：实时展示上下文窗口占用、输出吞吐（`tok/s`）、账号配额窗口，并提供跨会话状态小助手（`SessionPet`）。
- **完整工作区右侧栏**：内置文件树浏览、代码/Markdown/PDF/表格/音视频预览、Git Diff 审查批注以及嵌入式终端。
- **增强型输入框**：支持 `/` 斜杠指令、`@` 工作区文件与目录引用（支持逐层进入与面包屑导航）、附件上传及排队/插话发送模式。
- **桌面端与移动端自适应**：针对手机浏览器优化全屏抽屉、双行底栏、小助手全屏弹窗与设置页布局。

## 前置条件

- 已安装 [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness)。
- 本机至少已安装一个支持的 CLI（`claude`、`codex` 或 `agy`）。

## 安装使用（开箱即用）

仓库中已包含预编译的前端产物 `ui/client.js`，克隆后无需重新构建即可直接使用：

1. 将本仓库克隆到你的 DSH 插件目录（或任意本地目录）：
   ```bash
   git clone <your-repo-url> direct-chat
   ```
2. 在 DSH 插件配置中引入或链接 `direct-chat` 目录并重启 `dsh`。

## 本地开发

如果修改了 `ui/` 下的前端源码，可重新构建前端产物（需确保 `PATH` 中有 `dsh` 或已安装开发依赖）：

```bash
npm run build:ui
```

运行测试：

```bash
node --test test/*.test.mjs ui/*.test.mjs
```
