# FeClaw Desktop

> 🚧 **早期开发警告**：此项目正在早期开发阶段，以下内容大多为计划，而非已实现并验证可用的功能。
> 代码尚未在 Windows 上编译验证，可能存在重大变更。

---

FeClaw Desktop 为 FeClaw 智能体引擎提供一个 Windows 原生桌面界面。它本身不处理任何 AI 逻辑——所有智能能力由 FeClaw 引擎提供，Desktop 只负责让你用起来舒服。

## 设计

### 架构

```
┌──────────────────┐     HTTP API      ┌──────────────────┐
│  FeClaw Desktop  │ ────────────────→  │  FeClaw 引擎     │
│  (Rust / Tauri)  │ ←────────────────  │  (Python/FastAPI)│
│                  │     JSON / WS      │                  │
│  - 系统托盘       │                    │  - LLM 模型调用   │
│  - 原生弹窗确认   │                    │  - 工具执行       │
│  - 自动启动引擎   │                    │  - 知识库检索     │
│  - WS 双向通信    │                    │  - WeChat 通道    │
│  - 零 AI 能力     │                    │  - 文件存储       │
└──────────────────┘                    └──────────────────┘
```

### 双模式

| 模式 | 说明 |
|------|------|
| **本地模式** | Desktop 启动本地 FeClaw 引擎，所有数据存储在本机 |
| **云模式** (规划中) | Desktop 作为云端 Agent 的"手和脚"，通过 WS 隧道中继文件读写和命令执行 |

### 执行安全

Agent 需要执行命令时，Desktop 弹出原生 Windows 对话框，用户确认后才执行。

## 系统要求

- **操作系统**: Windows 10 / 11
- **Python**: 3.10+（启动本地引擎时需要）
- **Rust**: 1.77+（编译时需要）

## 开发

```bash
# 克隆
git clone https://github.com/lizidaren/FeClaw-Desktop.git
cd FeClaw-Desktop

# 构建
cd src-tauri
cargo tauri build
```

构建产物位于 `src-tauri/target/release/FeClaw-Desktop.exe`

详细设计文档：[docs/design.md](./docs/design.md)

## 许可证

MIT © lizidaren
