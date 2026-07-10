# Node deployment

Use this when Docker cannot pull base images on the server.

## Requirements

- Node.js 22 or newer
- npm
- Public server IP

mediasoup in this project requires Node.js 22+.

## First deploy

```bash
cd /www/wwwroot/party
git pull --ff-only origin main

cp .env.example .env
nano .env
```

Set `.env` like this:

```bash
PORT=8100
BIND=0.0.0.0
ANNOUNCED_IP=your_server_public_ip
RTC_MIN_PORT=40000
RTC_MAX_PORT=40099
APP_PASSWORD=your_strong_password
```

Install dependencies and build the browser bundle:

```bash
npm ci --registry=https://registry.npmmirror.com
npm run build
```

Run a temporary foreground test:

```bash
npm start
```

Then open:

```text
http://your_server_public_ip:8100
```

## Keep it running with PM2

```bash
npm install -g pm2 --registry=https://registry.npmmirror.com
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Use the command printed by `pm2 startup`, then run `pm2 save` again.

Useful checks:

```bash
pm2 status
pm2 logs party-share
curl http://127.0.0.1:8100/healthz
```

## Update later

```bash
cd /www/wwwroot/party
git pull --ff-only origin main
npm ci --registry=https://registry.npmmirror.com
npm run build
pm2 restart party-share
curl http://127.0.0.1:8100/healthz
```

## Ports

Open these in the cloud security group and the server firewall:

- TCP 8100 for temporary `IP:PORT` access
- UDP 40000-40099 for WebRTC media

When you later switch to a domain and HTTPS reverse proxy, TCP 8100 can be closed to the public, but UDP 40000-40099 must still stay open.
