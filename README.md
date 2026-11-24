# 圈子（Quanzi）

10 人以内的私密聊天群，**邀请码 + 昵称即入**，移动端优先的 PWA。自研前端 + Supabase（Postgres / RLS / Realtime / Storage），实时走真正的 WebSocket 长连接，不是轮询。

## 功能

- 邀请码 + 昵称入群，**群上限 10 人由数据库触发器强制**，不是前端假限制
- 文字 / 语音 / 图片 / 文件四类消息
- 消息撤回（2 分钟窗口，数据库触发器校验，超时或非本人写入直接失败）
- 已读回执（`已读 N/对方人数`，实时更新）
- 历史搜索：文字按 `pg_trgm` 三元组索引匹配中文片段，文件名单独可搜
- 在线状态、正在输入提示、断线自动重连并补拉漏消息
- **邀请码只由主控人生成/重置**（界面不渲染入口 + RPC 层拒绝，双保险）
- **存储管理**：接近 1GB 时弹出清理对话框，文件按大小降序，支持「删除」或「保存到本机后再删」
- 手机浏览器直接打开可用，可「添加到主屏幕」当 App 使用

## 技术架构

| 层 | 实现 |
| --- | --- |
| 前端 | React 18 + Vite + TypeScript，手写 CSS，无 UI 框架 |
| 身份 | Supabase 匿名登录（设备级），进群只需邀请码 + 昵称 |
| 数据 | Postgres 6 张表 + 行级安全（RLS）按群隔离 |
| 实时 | Supabase Realtime（Phoenix Channel over WSS）：`postgres_changes` + `presence` + `broadcast` |
| 文件 | Storage 私有桶 `quanzi-media`，访问走短期签名 URL |
| 服务端逻辑 | 16 个 `SECURITY DEFINER` 函数（RPC），不额外部署 Edge Functions |

数据库脚本在 `db/`：`001_schema.sql`（表 / 策略 / 触发器 / RPC / Realtime）、`002_rpc_extra.sql`（存储计量与附件消息一体发送）。

关键安全点：

- 所有表默认 RLS，成员只能读写自己所在群的数据
- `members` 没有 INSERT 策略 → 入群只能走 `join_group()` RPC，邀请码校验在服务端
- 存储删除策略只放行 `is_owner()`，前端删除走官方 Storage API
- 前端只使用 publishable key，secret key 不出现在客户端

## 本地开发

```bash
npm install
npm run dev
```

`.env` 需要两个变量（publishable key 可公开，可安全提交）：

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
```

## 构建与发布

```bash
npm run build      # 产物在 dist/
```

产物为纯静态文件，`base` 已设为相对路径，可直接放到任意静态托管（GitHub Pages / Cloudflare Pages / OSS）。

## 主控人（应用所有者）

首次使用时，进入「我是主控人」，输入部署时设置的主控口令完成认领；认领后该设备即为控制端，可创建圈子、生成与重置邀请码、清理存储。认领信息保存在 `app_config.owner_user_id`，如需换设备，将该项置空后重新认领即可。

## 已知限制（Supabase 免费版）

- 数据库 500MB、文件存储 1GB、月出站 5GB、单文件上传 50MB、实时并发 200 连接
- 项目连续 7 天无数据库活动会被自动暂停（有人在用即可避免）
- 语音：iOS 录制 `audio/mp4`，安卓 Chrome 录制 `webm/opus`，前端已做双格式兼容
- 图片上传前在客户端压缩到 1600px（免费版没有服务端图片变换）