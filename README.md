# 平面应力旋转与莫尔圆主方向核验后端

教学用二维（平面）应力状态计算服务。只处理对称 2×2 应力张量，提供 REST API 与命令行（CLI），**不做**梁挠度、有限元、材料屈服/破坏判定、真实结构安全判定或三维强度分析。

使用 TypeScript + Node.js（内置 `node:sqlite`，无需本机编译原生模块），SQLite 持久化。Windows 本地直接运行，不依赖 Docker、WSL 或任何在线服务。

## 符号与约定（每份报告冻结）

- 单位固定 **MPa**，**拉应力为正**，压应力为负。
- 应力张量 `S = [[σx, τxy], [τxy, σy]]`（对称）。
- 法向角 `θ` 从全局 **x 轴逆时针**为正，输入与输出均为**度**（显示角度不会被当弧度）。
- 法向 `n = (cosθ, sinθ)`，本题切向 `t = (-sinθ, cosθ)`（注意：不是旋转坐标轴公式里的另一套符号，二者不混用）。
- 面牵引向量 `traction = S·n`；面正应力 `σn = n·traction`；面切应力 `τn = t·traction`。
- 法向具有 180° 周期，输出面方向规范化到 `[-90, 90)`；输入角可为任意有限度数（自动跨周）。

### 自行实现的核心公式

令 `m = (σx+σy)/2`、`d = (σx-σy)/2`：

- `σn = m + d·cos(2θ) + τxy·sin(2θ)`
- `τn = -d·sin(2θ) + τxy·cos(2θ)`
- 正交法向（θ+90°）正应力：`σn' = m - d·cos(2θ) - τxy·sin(2θ)`

面内主应力：`r = hypot(d, τxy)`，`σ1 = m+r`、`σ2 = m-r`（按大/小排序）。
`r≠0` 时较大主应力法向角 `θ1 = atan2(2τxy, σx-σy)/2`，规范到 `[-90,90)`，另一方向与之正交。
服务返回主方向**代回后的真实剪应力残差**（浮点量级，通常 ~1e-15），不强制写成零。

**各向同性**（`r` 在容差内为零，例如 σx=σy 且 τxy=0）：两主应力相等，方向不唯一。
此时返回 `status: "isotropic"`、`theta1Deg: null` 与空的主方向数组，**不会**给出一个假称唯一的 0°。

最大**面内**剪应力绝对值为 `r`，作用面法向与主方向成 45°；返回两个面（法向相差 90°）的**有符号**剪应力（一正一负）与各自法向角。
这是**面内**结果，**不**冒充“含面外零主应力”的三维最大剪应力（后者为 `(σ1-σ3)/2`，本服务不计算、不下结论）。

### 莫尔圆约定

- 横轴 = 正应力 σn（拉为正），纵轴 = 本题切向约定下的 τn。
- 圆心 `(m, 0)`，半径 `r`。
- 物理法向转动 θ，在圆坐标上对应 **2θ**；纵轴符号跟随 `t=(-sinθ,cosθ)`。
- 每个查询点返回 `(σ- m)² + τ² - r²` 的圆方程残差，可直接核验。

## 容差与数量上限

- 各向同性判定：`r <= 1e-7 · max(1, |m|)`（相对+绝对混合，避免把数值噪声误判为唯一方向；同时避免用 NaN 表示“未定义”）。
- 应力绝对值上限 `1e9` MPa；角度绝对值上限 `1e9` 度；批量查询角度数量上限 `1000`；请求体上限 1 MB。
- 所有应力与角度必须为有限数值（NaN/Infinity 独立报错，错误码 `INVALID_NUMBER`，与各向同性状态互不混淆）。

## 环境要求

- Node.js ≥ 22.5（需要内置 `node:sqlite`，本机实测 v25）。运行时会打印一条 SQLite experimental 警告，不影响功能。

## 构建、测试、启动、演示

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # 编译并运行 node:test（15 个用例）
npm start          # 启动 HTTP 服务，默认自动选择空闲端口并打印地址
npm run demo       # 内置三组教学演示
```

- 配置端口：`$env:PORT=39123; npm start`（`PORT=0` 或不设表示自动选空闲端口）。
- 数据目录：项目内 `./data`（SQLite 文件 `stress.db`），可用环境变量 `STRESS_DATA_DIR` 覆盖。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/cases` | 创建/保存工况（幂等） |
| GET | `/cases` | 列出工况 |
| GET | `/cases/:id` | 读取完整报告（牵引、回代核验、主方向、莫尔点） |
| GET | `/cases/:id/export?format=json\|csv` | 导出 JSON/CSV |
| GET | `/compare/:idA/:idB` | 比较两工况的主应力/半径/均值差 |

创建请求体：

```json
{ "sigmaX": 100, "sigmaY": 0, "tauXY": 50, "angles": [0, 45, 90], "idemKey": "可选" }
```

响应中每个查询点包含：`normal`、`tangent`、`traction`（S·n）、`sigmaN`、`tauN`、
正交面正应力 `sigmaNOrtho`、`tractionFromLocal`（由 `n·σn + t·τn` 重建）与二者之差 `residual`。

### 幂等与持久化

- 不传 `idemKey` 时按输入+角度做内容寻址（SHA-256 截断），相同输入永远返回同一报告 ID；传入 `idemKey` 时该键也唯一。
- 重复请求返回 HTTP 200 且 `inserted:false`，不产生重复行；输入被冻结（含单位、正负约定、角度单位与容差），**修改输入会产生新报告**，旧报告不被覆盖。
- 重启后仍可读取旧工况的牵引向量与回代核验；写入错误不会覆盖既有有效报告。

### 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_NUMBER` | 应力/角度不是有限数值 |
| 400 | `OUT_OF_RANGE` | 超过数值上限 |
| 400 | `INVALID_ANGLES` / `TOO_MANY_ANGLES` | 角度数组非法/超量 |
| 400 | `INVALID_BODY` / `INVALID_JSON` / `BODY_TOO_LARGE` | 请求体问题 |
| 404 | `NOT_FOUND` | 工况或路由不存在 |
| 500 | `INTERNAL_ERROR` | 服务端内部错误 |

API 示例（PowerShell）：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:<port>/cases -Method Post `
  -Body '{"sigmaX":100,"sigmaY":0,"tauXY":50,"angles":[45]}' `
  -ContentType "application/json"
```

## CLI

```powershell
node dist/src/cli.js save --sx 100 --sy 0 --txy 50 --angles 0,45,90
node dist/src/cli.js list
node dist/src/cli.js get <id>
node dist/src/cli.js principal <id>
node dist/src/cli.js mohr <id>
node dist/src/cli.js compare <idA> <idB>
node dist/src/cli.js export <id> --format csv --out report.csv
node dist/src/cli.js demo
```

## 内置演示（已核验数值）

1. `σx=100, σy=0, τxy=50`：主应力 `50±√5000`（≈120.711 与 -20.711），较大主方向 **22.5°**；
   `θ=45°` 时 **σn=100、τn=-50**。
2. 等双向拉应力 `σx=σy=80`：所有面剪应力为零，主方向不唯一（`isotropic`，角度为空）。
3. 纯剪 `τxy=40`：主方向为 **±45°**，主应力 ±40；负剪应力时较大主方向为 -45°。

## 范围限制

仅二维平面应力、面内主应力与面内最大剪应力；不输出三维主应力、三维最大剪应力，
不做材料强度/屈服/破坏判断，不做结构安全结论。所有结果仅供教学核验。
