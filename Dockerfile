FROM node:20-bookworm-slim

# python3/build-essential/pip: mediasoup 预编译二进制下载失败时可从源码编译（国内网络兜底）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --registry=https://registry.npmmirror.com

COPY . .
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "server.js"]
