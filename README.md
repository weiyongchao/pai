# 打牌计分小程序（微信云开发）

## 功能

- 微信授权登录：使用微信昵称/头像，支持自定义修改
- 首页：展示头像、昵称、战绩（参与/胜/负），提供「我要开房」「扫码进房」
- 房间：成员列表、积分（默认 0）、点击成员弹窗转移积分（整数）、交易流水展示
- 房间二维码：生成房间小程序码，其他人扫码直接进入房间
- 自动结算：所有人退房或全员离线 10 分钟后自动关闭房间并写入战绩（按最终积分正负判定胜负）

## 本地运行（微信开发者工具）

1. 用微信开发者工具导入本项目根目录（`project.config.json` 同级）
2. 确认 `project.config.json` 里的 `appid` 为你的小程序 AppID（云开发通常需要真实 AppID）
3. 开通并启用「云开发」，在开发者工具右侧「云开发」面板**创建并选择一个环境**（你现在控制台的报错就是“未选择环境/没有默认环境”）
4. 右侧「云开发」面板：
   - 数据库：创建集合 `users`、`rooms`、`room_members`、`room_logs`
   - 云函数：上传并部署 `cloudfunctions/` 下所有云函数（云端安装依赖）
     - 云端「云函数列表」应看到 `getMyProfile/updateProfile/createRoom/joinRoom/getRoomDetail/transferScore/getRoomCode/getMyActiveRoom` 等
     - 如果云端只看到一个名为 `cloudfunctions` 的函数，通常是部署错目录（误把 `cloudfunctions/cloudfunctions` 当成云函数部署了），会导致体验版/线上调用时报 `FUNCTION_NOT_FOUND`

> 环境指定方式二选一：
> - 推荐：在开发者工具「云开发」面板选择环境（`wx.cloud.DYNAMIC_CURRENT_ENV` 生效）
> - 或者：在 `miniprogram/env.js` 填 `envId`（例如 `cloud1-xxxx`），可避免“未选择环境”导致的 -501000 报错

建议将上述 4 个集合权限设置为「仅管理员可读写」，客户端只通过云函数访问，避免被伪造写入。

## 常见报错

- `-501000 INVALID_ENV / Environment not found`：未创建或未选择云环境 → 在开发者工具「云开发」面板创建并选中环境，或设置 `miniprogram/env.js`
- `FUNCTION_NOT_FOUND`：云函数未部署 → 在「云开发 → 云函数」上传并部署对应函数（云端安装依赖）
- `-404006 empty poll result base resp`：开启了「云函数本地调试」但本地调试进程无返回 → 先关闭本地调试改用云端运行，或重启开发者工具/清缓存
- `-501007 invalid parameters. 不能更新_id的值`：使用 `collection.doc(id).set` 时不要在 `data` 里写 `_id` → 重新上传部署云函数
- `-502005 database collection not exists / DATABASE_COLLECTION_NOT_EXIST`：数据库集合未创建 → 在「云开发 → 数据库」新建集合（至少：`users`、`rooms`、`room_members`、`room_logs`）
- `errCode: 41030 invalid page`：生成小程序码时 page 校验失败 → 先上传一次小程序代码到微信后台，或将 `getRoomCode` 云函数中的 `checkPath` 设为 `false`（本项目已处理并带兜底重试）
- `-604101 function has no permission to call this API`：云函数无权限调用微信开放接口（常见于 `wxacode.getUnlimited`）→ 在云开发控制台为当前环境开通「云调用/微信开放接口」，并授权「小程序码」相关接口后再试
  - 说明：即使未开通小程序码权限，房间页依然可以通过「分享给好友」入房（走分享 path），只是无法生成可扫码进入的小程序码图片

## 云函数清单

- `getMyProfile`：读取我的资料/战绩
- `updateProfile`：更新昵称/头像
- `createRoom`：开房（创建房间+房主入房）
- `joinRoom`：入房（确保成员存在）
- `getRoomDetail`：房间详情（房间/成员/流水）
- `transferScore`：积分转移（事务更新双方积分+写流水）
- `getRoomCode`：生成房间小程序码（带缓存）
- `endRoom`：房主结算（写入战绩并结束房间）
- `heartbeatRoom`：心跳（记录在线状态）
- `getMyActiveRoom`：读取我当前仍在进行中的房间（用于首页“回到房间”按钮）
- `getMyRoomSummary`：本局我的汇总（输赢给谁、总计）
- `leaveRoom`：退房（标记离开并触发自动关闭检查）
- `autoCloseRooms`：自动关闭与结算（定时触发器每 5 分钟检查一次）

## 数据与规则（简化版）

- `users`：用户资料与累计战绩
  - `_id = openid`
  - `nickName`、`avatarUrl`
  - `stats.gamesPlayed` / `stats.wins` / `stats.losses`
  - `recentGames`（最近 10~20 场历史战绩，用于首页展示）
- `rooms`：每个房间代表一局
  - `_id = roomId`（<=32 字符，适配小程序码 `scene`）
  - `ownerOpenid`、`status=active|ended`
- `room_members`：房间成员积分
  - `_id = ${roomId}_${openid}`
  - `score`（可正可负，默认 0）
  - `active`（是否在房间内）
  - `lastSeenAt`（最后在线时间，用于 10 分钟离线自动关闭）
- `room_logs`：房间流水（join/transfer/settle）

胜负判定（可按你们玩法再改）：结算时 `score > 0` 记为胜，`score < 0` 记为负，`score == 0` 只计参与不计胜负。
