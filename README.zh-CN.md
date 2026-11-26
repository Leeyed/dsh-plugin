# dsh-direct-chat

[English](./README.md) | 简体中文

一个面向 DeepSeek Harness (`dsh`) 的插件，用于在 DSH Web 端与桌面端中直接连接 **Claude Code**、**Codex** 和 **Antigravity CLI (`agy`)**，提供统一的会话管理、多账号隔离、工作区工具链以及移动端适配界面。

## 核心特性

- **多引擎直连**：在同一个输入框和侧边栏中统一运行与管理 `claude`、`codex`、`agy` 会话，并自动记住上次使用的引擎。
- **多账号与配置隔离**：支持为每个 CLI 配置多个独立的 OAuth 或环境变量账号，支持会话级账号绑定、默认账号切换及会话内快捷账号管理。
- **Git Worktree 隔离开发**：新建会话时可开启 Worktree 模式并选择基础分支，自动在 `.agents/worktrees/` 下创建独立 Git 工作树。
- **原生历史互通与归档**：支持导入本机终端原生 CLI 历史会话、侧边栏合并多来源工作区，并支持将对话归档或恢复回原生 CLI 存储。
- **状态与用量监控**：实时展示上下文窗口占用、输出吞吐（`tok/s`）、账号配额窗口，并提供跨会话任务小助手（`SessionPet`）。
- **任务小助手（`SessionPet`）**：支持鹈鹕动态状态（休息 / 骑行 / 举旗 / 完成）、PC 端非当前会话悬浮审批气泡、展开即阅的未读完成角标、可选提示音（默认关闭）、PC 端 `小/中/大` 尺寸切换与视口边界裁剪，以及移动端全屏卡片视图。
- **完整工作区右侧栏**：支持可拖拽调宽的右侧分栏，内置文件树浏览、代码/Markdown/PDF/表格/音视频与共享目录别名产物预览、Git Diff 审查批注以及嵌入式终端。
- **增强型输入框**：支持 `/` 斜杠指令、`@` 工作区文件与目录引用（支持逐层进入与面包屑导航）、附件上传及排队/插话发送模式。
- **跨平台与响应式适配**：兼容 Linux、macOS 与 Windows（CLI 包装器解析、PATH 回退、目录 junction 与凭据管理器 OAuth 检测），并针对桌面端与手机浏览器优化交互布局。

## 前置条件

- 已安装 [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness)。
- 推荐 DSH 版本为 `0.2.2-rc.5`，与插件的前端构建依赖一致。插件已适配 `0.2.2-rc.1` 的任务列表图标，该版本的完整兼容性仍待验证。可用 `dsh --version` 查看本机版本。
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
