# party-share

自建多人屏幕共享 / 语音房间。Node.js + mediasoup（SFU），单容器部署，
媒体流由浏览器直连服务器 IP 的 UDP 端口段，无 P2P、无 TURN。

## 架构

```
浏览器 ──HTTPS/WSS(网页+信令)──> Cloudflare Tunnel ──> 127.0.0.1:8100 (本服务)
浏览器 ──UDP 40000-40099(音视频)──────────直连────────> 服务器公网IP (mediasoup)
```

## 功能

- 房间制：任意房间名，进房需要访问密码（`APP_PASSWORD`，全站一个）
- 每人可开：麦克风、屏幕共享（含系统声音）、摄像头
- 屏幕共享 ≤1080p / ≤30fps / ≤2.5Mbps，摄像头 720p / ≤0.8Mbps（改 `src/client.js`）
- 双击画面全屏

## 部署（服务器）

```bash
# 1. 上传代码到服务器（或 git clone）
scp -r . root@服务器:/www/wwwroot/party-share

# 2. 修改 docker-compose.yml：ANNOUNCED_IP 填公网 IP，APP_PASSWORD 设密码

# 3. 构建并启动
cd /www/wwwroot/party-share
docker compose up -d --build

# 4. 本机自测
curl http://127.0.0.1:8100/healthz   # 应输出 ok
```

放行端口（云安全组 + 宝塔防火墙）：**UDP 40000-40099**（必须）。
8100 不需要对外开放。

Cloudflare Tunnel 添加 Public Hostname：`play.juryory.com → HTTP → localhost:8100`。

## 本地开发

```bash
npm install
npm run build        # 打包前端到 public/bundle.js
node server.js       # 默认 127.0.0.1 回环测试模式（无 ANNOUNCED_IP）
# 浏览器打开 http://localhost:8100
```

注意：`getDisplayMedia` 要求安全上下文，`http://localhost` 可以，
`http://局域网IP` 不行（需 HTTPS）。

## 排障

- 能进房间但没画面/没声音 → UDP 40000-40099 没放行
- 网页打不开 → 隧道或 8100 服务问题，`docker compose logs -f` 看日志
- mediasoup 构建失败 → 检查 npm 源；Dockerfile 已带源码编译兜底工具链
