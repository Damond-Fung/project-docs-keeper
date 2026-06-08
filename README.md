# Project Docs Keeper

让项目文档自动追着代码跑，开发过程不再"事后补作业"。

## 简介

`project-docs-keeper` 是一个面向 **项目文档自动化维护** 场景的完整 Skill。它不是简单的"文档模板生成器"，而是一个把 **意图识别、变更捕获、增量更新、多视角沉淀** 串起来的完整工作流型 Skill。

## 核心能力

- **自动捕获变更**：基于 Git Diff 或文件监听，实时感知代码变更
- **增量更新文档**：不重写整篇文档，只在对应位置追加本次变更
- **三视角同步沉淀**：同一次变更，自动映射到宣讲稿、开发记录、部署手册三份文档

## 快速开始

### 安装

将本仓库克隆到项目的 `.trae/skills/` 目录下：

```bash
git clone https://github.com/Damond-Fung/project-docs-keeper.git .trae/skills/project-docs-keeper
```

### 使用

```bash
# 手动单次更新
node ./.trae/skills/project-docs-keeper/scripts/project-docs-keeper.mjs

# Watch 实时模式
node ./.trae/skills/project-docs-keeper/scripts/project-docs-keeper.mjs --watch

# 安装 Git Hook 自动触发
node ./.trae/skills/project-docs-keeper/scripts/project-docs-keeper.mjs --install-git-hooks
```

## 文档结构

执行后会自动生成/更新以下三份文档：

| 文档 | 受众 | 内容定位 |
|------|------|----------|
| `项目宣讲稿.md` | 外部/新人 | 痛点、方案、成果、避坑 |
| `项目开发过程记录.md` | 内部开发者 | 问题、根因、解决、验证、预防 |
| `项目部署操作手册.md` | 运维/部署 | 配置、步骤、验证、回滚 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PDK_ENV` | `dev` | 当前环境标识 |
| `PDK_OUT_DIR` | `./project_docs` | 文档输出目录 |

## 更多

详见 [SKILL.md](./SKILL.md) 获取完整的工作流说明和触发条件。
