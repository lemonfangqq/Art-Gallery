# 🎨 小画家画廊 — 服务器版 (Art Gallery Server)

用于展示孩子们画作的在线画廊。带后端服务：元数据存 PostgreSQL（Supabase），图片存 Cloudflare R2 对象存储，服务端 sharp 压缩，Docker 部署到 Render。

## 功能一览

| 层级 | 页面 | 功能 |
|---|---|---|
| L1 | 首页 | 小画家卡片墙、新建/编辑/删除小画家、12 种头像颜色 |
| L2 | 画家页 | 画集卡片墙、新建/编辑/删除画集、上传作品入口 |
| L3 | 画集页 | 作品瀑布流、懒加载、批量上传（单张/多张/拖拽） |
| L4 | 作品详情 | 大图查看、上一幅/下一幅、编辑信息、删除、下载原图 |
| L5 | 灯箱 | 全屏浏览、键盘 ←/→ 切换、Esc 关闭 |

服务器特有能力：

- **服务端压缩**：上传后 sharp 自动压缩到最长边 1200px、JPEG 质量 0.85；压缩图用于展示，原图另存用于下载
- **图片旋转**：详情页一键顺时针/逆时针旋转 90°，服务端 sharp 处理后覆盖存储
- **私有桶 + 签名 URL**：R2 桶保持私有，图片访问走 `/api/artworks/:id/image`，后端签发 1 小时有效的临时 URL 后 302 重定向
- **旧数据迁移**：`POST /api/migrate` 从 GitHub `data.json` 一键导入画家/画集/作品元数据

## 技术栈

| 组件 | 技术 |
|---|---|
| 后端 | Node.js 20 + Express + TypeScript |
| 数据库 | PostgreSQL（Supabase） |
| 对象存储 | Cloudflare R2（S3 兼容 API） |
| 图像处理 | sharp |
| 部署 | Docker 多阶段构建 → Render |

## 项目结构

```
server/
  src/index.ts     Express API（画家/画集/作品 CRUD、上传、旋转、迁移）
  src/db.ts        PostgreSQL 连接与建表（启动时自动建表）
  src/r2.ts        R2 上传/删除/签名工具
  public/          前端单页应用（调用 /api/* 接口）
  package.json
  tsconfig.json
Dockerfile         多阶段构建（builder 编译 TS，runner 仅装运行时依赖）
render.yaml        Render 部署配置
```

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET / POST | `/api/artists` | 画家列表 / 新建 |
| GET / PUT / DELETE | `/api/artists/:id` | 画家详情 / 更新 / 删除（级联删画集和作品） |
| GET / POST | `/api/albums` | 画集列表（支持 `?artistId=`） / 新建 |
| PUT / DELETE | `/api/albums/:id` | 更新 / 删除（级联删作品） |
| GET / POST | `/api/artworks` | 作品列表（支持 `?albumId=`、`?artistId=`） / 上传（multipart，字段 `image`） |
| GET | `/api/artworks/:id/image` | 签名 URL 302 重定向到压缩图 |
| PUT / DELETE | `/api/artworks/:id` | 更新标题/描述 / 删除（同时删 R2 文件） |
| POST | `/api/artworks/:id/rotate` | 旋转压缩图，body：`{"direction":"cw"\|"ccw"}` |
| POST | `/api/migrate` | 从 GitHub `data.json` 导入旧数据 |

## 数据库表

启动时自动创建，字段与旧版 data.json 一一对应：

- `artists`：`id, name, bio, color, created_at`
- `albums`：`id, artist_id(外键，级联删除), name, desc, created_at`
- `artworks`：`id, album_id(外键，级联删除), artist_id, title, description, date, compressed_file, original_file, created_at`

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | Supabase PostgreSQL 连接串 |
| `R2_ACCOUNT_ID` | Cloudflare 账户 ID |
| `R2_ACCESS_KEY_ID` | R2 API Token 的 Access Key |
| `R2_SECRET_ACCESS_KEY` | R2 API Token 的 Secret Key |
| `R2_BUCKET` | R2 桶名 |
| `R2_PUBLIC_URL` | R2 公开访问域名（如 `https://pub-xxx.r2.dev`） |
| `PORT` | 服务端口（默认 3000） |

## 部署步骤

1. 创建 Supabase 项目，复制数据库连接串（使用 Transaction pooler 地址）
2. 创建 Cloudflare R2 桶，生成 API Token（对象读写权限），记下桶名和公开访问域名
3. 在 Render 创建 Web Service，选 Docker 环境，`dockerfilePath` 填 `./Dockerfile`，配置上表环境变量
4. 部署完成后调用 `POST /api/migrate` 导入历史数据（可选）

## 本地开发

```bash
cd server
npm install
npm run dev        # tsx watch 模式，默认 http://localhost:3000
npm run build      # 编译到 dist/
npm start          # 运行编译产物
```

## 已知限制

- **尚未加管理员鉴权**：所有接口公开可访问，公开部署前需自行加一层访问控制（最优先）
- **HEIC 已移除**：Render 环境无法解码 HEIC，iPhone 照片需先转 JPG 再上传
- **迁移数据不兼容旋转**：从 GitHub 导入的旧作品图片 URL 不是 R2 key，旋转接口对其返回 400
- **签名 URL 不缓存**：每次图片加载都会请求后端签发 URL，流量大时可考虑给 302 响应加缓存头
