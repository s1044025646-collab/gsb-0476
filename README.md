# 平面应力旋转与莫尔圆主方向核验后端（教学用）

TypeScript + Node.js + SQLite 实现的二维平面应力教学计算服务，仅提供 HTTP API 与 CLI，无前端。
Windows 本地直接运行，不依赖 Docker / WSL / 付费服务 / 外部在线 API。

## 范围与限制

- 只处理对称 2×2 应力张量 `S = [[σx, τxy], [τxy, σy]]` 的平面应力教学计算。
- **不做**：梁挠度、有限元、材料屈服、真实结构安全判定、三维强度分析。
- 最大剪应力仅为**面内**最大剪应力 `r = hypot((σx-σy)/2, τxy)`，不把面内 `r` 冒充为含零面外应力后的三维最大剪应力，也不做材料是否破坏的结论。

## 符号与约定

- 单位固定 **MPa**，**拉应力为正**。
- 法向角 `θ`（度）自全局 x 轴逆时针；`n = (cosθ, sinθ)`，切向 `t = (-sinθ, cosθ)`。
- 面牵引向量 `trac = S·n`；`σn = n·trac`；`τn = t·trac`。
- 二倍角公式（m=(σx+σy)/2，d=(σx-σy)/2）：
  - `σn = m + d·cos2θ + τxy·sin2θ`
  - `τn = -d·sin2θ + τxy·cos2θ`
  - 正交法向面上的正应力：`m - d·cos2θ - τxy·sin2θ`
- 面法向以 **180°** 为周期，输出角度规范化到 `[0, 180)`；主方向规范化到 `[-90, 90)`。
- 主方向：`θp1 = atan2(2τxy, σx-σy)/2`（较大主应力的法向角），另一方向与之正交。
- 莫尔圆：横轴 `σn`、纵轴 `τn`（本题切应力约定）；物理法向转 `θ` 对应圆上圆心角 `2θ`。
- 所有角度以**度**输入输出，内部显式转弧度；不会把显示角度当弧度代入。
- 每次面应力计算返回牵引向量、局部分量 `(σn, τn)` 及回代核验 `n·σn + t·τn` 与 `S·n` 的残差。
- 主方向返回代回后的**真实剪应力残差**（不强制写零）。
- **各向同性**（r ≤ tol·scale）时返回 `isotropic: true` 与空唯一角度（`null`），不给假称唯一的 0°。

## 容差与数值上限

- 默认容差 `tolerance = 1e-9`（可在创建工况时指定，范围 `(0, 1e-3]`），随工况冻结保存。
- 应力上限 `±1e9 MPa`，角度上限 `±1e9 度`，单次批量查询角度数上限 `1000`，请求体上限 1MB。
- 所有输入必须是有限数值；`NaN`/`Infinity` 返回 `INVALID_INPUT`，数值失败（`NUMERIC_FAILURE`）独立于各向同性判定，不用 NaN 表示未定义方向。

## 错误码

| 代码 | HTTP | 含义 |
|---|---|---|
| `INVALID_INPUT` | 400 | 输入非法（非有限数、类型错误等） |
| `LIMIT_EXCEEDED` | 400/413 | 超出数值或数量上限 |
| `NOT_FOUND` | 404 | 工况或路由不存在 |
| `NUMERIC_FAILURE` | 500 | 计算出现非有限结果 |
| `INTERNAL` | 500 | 其他内部错误 |

错误只作为响应返回，不会写入或覆盖已保存的有效工况报告。

## 持久化与幂等

- SQLite 数据库位于项目内 `data/stress.db`（Node 内置 `node:sqlite`，无原生依赖）。
- 每个工况冻结保存：原始应力、单位、正负约定、角度约定、数值容差、创建时间与输入哈希。
- 相同输入（含约定与容差）重复创建返回同一工况（幂等，`existed: true`）；修改任一输入产生新工况，旧报告不可变、重启后仍可查询。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 API（默认自动选择空闲端口，监听 127.0.0.1）
npm run demo       # 运行三组教学演示
```

要求 Node.js ≥ 22（使用内置 `node:sqlite` 与 `fetch`；开发环境为 Node 25）。

## CLI 用法

```
node dist/cli.js serve [--port N]                 # 启动 HTTP API（默认空闲端口）
node dist/cli.js demo                             # 教学演示
node dist/cli.js create --sigmaX 100 --sigmaY 0 --tauXY 50 [--name S] [--tolerance 1e-9]
node dist/cli.js list                             # 列出工况
node dist/cli.js show <id>                        # 查看工况
node dist/cli.js report <id> [--angles 0,45,90]   # 完整报告
node dist/cli.js query <id> --angles 0,45,90      # 批量查询面应力
node dist/cli.js principals <id>                  # 主应力/主方向/最大面内剪应力
node dist/cli.js mohr <id> [--angles 0,15,...]    # 莫尔圆点表
node dist/cli.js compare <idA> <idB>              # 比较两个工况
node dist/cli.js export <id> --format csv         # 导出 JSON/CSV
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/cases` | 创建工况（幂等），body: `{sigmaX, sigmaY, tauXY, name?, tolerance?}` |
| GET | `/api/cases` | 列出全部工况 |
| GET | `/api/cases/:id` | 查看工况 |
| GET | `/api/cases/:id/report?angles=0,45,90` | 完整报告（不变量/主方向/莫尔圆） |
| POST | `/api/cases/:id/query` | 批量查询，body: `{angles: [...]}` |
| GET | `/api/cases/:id/principals` | 主应力、主方向、最大面内剪应力 |
| GET | `/api/cases/:id/mohr?angles=0,15,...` | 莫尔圆圆心、半径与点表 |
| GET | `/api/cases/:id/export?format=json\|csv` | 导出报告 |
| POST | `/api/compare` | 比较两工况，body: `{ids: [idA, idB]}` |

## 教学演示（`npm run demo` 实际输出）

1. `σx=100, σy=0, τxy=50`：主应力 `50±√5000 ≈ 120.710678 / -20.710678 MPa`，较大主方向 `22.5°`；`θ=45°` 时 `σn=100, τn=-50 MPa`。
2. 等双向拉应力 `σx=σy=80, τxy=0`：`isotropic=true`，主方向不唯一（`null`），任意面剪应力为 0。
3. 纯剪应力 `σx=σy=0, τxy=40`：主应力 `±40 MPa`，主方向 `±45°`。

## 测试覆盖

- 二倍角公式与独立矩阵乘法 `QᵀSQ` 逐点核对（含零应力、压应力、负剪应力、纯剪、角度跨周期 ±180°/360°/多周）。
- 牵引回代残差、迹与行列式旋转不变、主方向正交、主方向剪应力残差、莫尔圆圆方程残差、2θ 关系。
- 各向同性与近各向同性（容差内判各向同性、容差外方向有效）。
- API：幂等创建、错误码、批量上限、CSV 导出、工况比较、重启后持久化。

## 项目结构

```
src/core/stress.ts   # 核心应力计算（无依赖）
src/db.ts            # SQLite 持久化（data/stress.db）
src/report.ts        # 报告组装、比较、CSV 导出
src/server.ts        # HTTP API（node:http）
src/cli.ts           # 命令行入口
src/test/            # node:test 测试
data/                # 运行时生成的数据目录
```
