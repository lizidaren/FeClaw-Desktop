# FeClaw Desktop

> 一个运行在你电脑上的 AI 助手。无需配置、无需域名、开箱即用。

FeClaw Desktop 为 FeClaw 智能体引擎提供了一个友好的桌面界面。它本身不处理任何 AI 逻辑——所有智能能力由 FeClaw 引擎提供，Desktop 只负责让你用起来舒服。

## 特性

- **🖥️ 原生桌面体验** — 系统托盘、原生通知、开机自启
- **🔒 安全的代码执行** — 每次 Agent 想执行命令时都会弹窗确认
- **📱 WeChat 联动** — 电脑合盖了？用微信也能跟 Agent 聊天
- **📚 内置知识库** — 高考错题整理、概念可视化、AI 问答
- **🌐 纯本地运行** — 数据存你的电脑上，不传云

## 快速开始

```bash
# 1. 安装 FeClaw 引擎
pip install feclaw

# 2. 启动 Desktop（会自动启动引擎）
# 下载 FeClaw-Desktop.exe 双击运行，或：
pip install feclaw-desktop
feclaw-desktop
```

浏览器自动打开，你就有一个完整的 AI 助手了。

## 架构

```
┌──────────────────┐     HTTP API      ┌──────────────────┐
│  FeClaw Desktop  │ ────────────────→  │  FeClaw 引擎     │
│  (桌面 GUI)      │ ←────────────────  │  (智能体平台)    │
│                  │     JSON           │                  │
│  - 系统托盘图标   │                    │  - LLM 模型调用   │
│  - 原生确认弹窗   │                    │  - 工具执行       │
│  - 自动启动引擎   │                    │  - 知识库检索     │
│  - 更新管理       │                    │  - WeChat 通道    │
│  - 零 AI 能力     │                    │  - 文件存储       │
└──────────────────┘                    └──────────────────┘
```

## 系统要求

- **操作系统**: Windows 10 / 11（macOS 支持规划中）
- **Python**: 3.10+
- **网络**: 需要互联网连接（调用 LLM API）

## 开发

```bash
# 克隆
git clone https://github.com/lizidaren/FeClaw-Desktop.git
cd FeClaw-Desktop

# 本仓库目前处于早期开发阶段
# 技术选型确定后会更新构建说明

## 许可证

MIT © lizidaren
