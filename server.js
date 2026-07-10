import crypto from 'crypto';
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as mediasoup from 'mediasoup';

const PORT = Number(process.env.PORT || 8100);
const BIND = process.env.BIND || '0.0.0.0';
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '';
const RTC_MIN_PORT = Number(process.env.RTC_MIN_PORT || 40000);
const RTC_MAX_PORT = Number(process.env.RTC_MAX_PORT || 40099);
const APP_PASSWORD = process.env.APP_PASSWORD || '';

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000 },
  {
    kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 }
  }
];

let worker;
const rooms = new Map(); // name -> { name, router, peers: Map<peerId, peer> }

async function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    const router = await worker.createRouter({ mediaCodecs });
    room = { name, router, peers: new Map() };
    rooms.set(name, room);
    console.log(`room created: ${name}`);
  }
  return room;
}

function broadcast(room, event, data, exceptPeerId) {
  for (const [pid, p] of room.peers) {
    if (pid !== exceptPeerId && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ event, data }));
    }
  }
}

const app = express();
app.use(express.static('public'));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  let room = null;
  let peer = null;

  function closePeer() {
    if (!room || !peer) return;
    room.peers.delete(peer.id);
    for (const t of peer.transports.values()) t.close();
    broadcast(room, 'peerLeft', { id: peer.id });
    console.log(`peer left: ${peer.name} (${room.name}), remaining ${room.peers.size}`);
    if (room.peers.size === 0) {
      room.router.close();
      rooms.delete(room.name);
      console.log(`room closed: ${room.name}`);
    }
    room = null;
    peer = null;
  }

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, method, data = {} } = msg;
    const reply = d => ws.send(JSON.stringify({ id, ok: true, data: d || {} }));
    const fail = e => ws.send(JSON.stringify({ id, ok: false, error: String((e && e.message) || e) }));

    try {
      if (method === 'join') {
        if (APP_PASSWORD && data.password !== APP_PASSWORD) throw new Error('密码错误');
        if (peer) throw new Error('已经加入过房间');
        room = await getRoom(String(data.room || 'lobby').slice(0, 32));
        peer = {
          id: crypto.randomUUID().slice(0, 8),
          name: String(data.name || '玩家').slice(0, 16),
          ws,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map()
        };
        room.peers.set(peer.id, peer);
        const producers = [];
        for (const [pid, p] of room.peers) {
          for (const [prodId, prod] of p.producers) {
            producers.push({
              peerId: pid, peerName: p.name,
              producerId: prodId, kind: prod.kind, source: prod.appData.source
            });
          }
        }
        broadcast(room, 'peerJoined', { id: peer.id, name: peer.name }, peer.id);
        console.log(`peer joined: ${peer.name} (${room.name}), total ${room.peers.size}`);
        return reply({
          peerId: peer.id,
          rtpCapabilities: room.router.rtpCapabilities,
          peers: [...room.peers.values()].filter(p => p !== peer).map(p => ({ id: p.id, name: p.name })),
          producers
        });
      }

      if (!peer) throw new Error('尚未加入房间');

      if (method === 'createTransport') {
        const listenIps = ANNOUNCED_IP
          ? [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }]
          : [{ ip: '127.0.0.1' }];
        const transport = await room.router.createWebRtcTransport({
          listenIps,
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: 3_000_000
        });
        peer.transports.set(transport.id, transport);
        return reply({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters
        });
      }

      if (method === 'connectTransport') {
        const transport = peer.transports.get(data.transportId);
        if (!transport) throw new Error('transport 不存在');
        await transport.connect({ dtlsParameters: data.dtlsParameters });
        return reply();
      }

      if (method === 'produce') {
        const transport = peer.transports.get(data.transportId);
        if (!transport) throw new Error('transport 不存在');
        const producer = await transport.produce({
          kind: data.kind,
          rtpParameters: data.rtpParameters,
          appData: { source: (data.appData && data.appData.source) || 'mic' }
        });
        peer.producers.set(producer.id, producer);
        producer.on('transportclose', () => peer && peer.producers.delete(producer.id));
        broadcast(room, 'newProducer', {
          peerId: peer.id, peerName: peer.name,
          producerId: producer.id, kind: producer.kind, source: producer.appData.source
        }, peer.id);
        return reply({ producerId: producer.id });
      }

      if (method === 'closeProducer') {
        const producer = peer.producers.get(data.producerId);
        if (producer) {
          producer.close();
          peer.producers.delete(data.producerId);
          broadcast(room, 'producerClosed', { peerId: peer.id, producerId: data.producerId }, peer.id);
        }
        return reply();
      }

      if (method === 'consume') {
        const transport = peer.transports.get(data.transportId);
        if (!transport) throw new Error('transport 不存在');
        if (!room.router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
          throw new Error('无法消费该媒体流');
        }
        const consumer = await transport.consume({
          producerId: data.producerId,
          rtpCapabilities: data.rtpCapabilities,
          paused: true
        });
        peer.consumers.set(consumer.id, consumer);
        consumer.on('transportclose', () => peer && peer.consumers.delete(consumer.id));
        consumer.on('producerclose', () => peer && peer.consumers.delete(consumer.id));
        return reply({
          id: consumer.id,
          producerId: data.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters
        });
      }

      if (method === 'resumeConsumer') {
        const consumer = peer.consumers.get(data.consumerId);
        if (!consumer) throw new Error('consumer 不存在');
        await consumer.resume();
        return reply();
      }

      throw new Error(`未知方法: ${method}`);
    } catch (e) {
      fail(e);
    }
  });

  ws.on('close', closePeer);
  ws.on('error', closePeer);
});

(async () => {
  worker = await mediasoup.createWorker({ rtcMinPort: RTC_MIN_PORT, rtcMaxPort: RTC_MAX_PORT });
  worker.on('died', () => {
    console.error('mediasoup worker died, exiting');
    process.exit(1);
  });
  server.listen(PORT, BIND, () => {
    console.log(`party-share listening on ${BIND}:${PORT}`);
    console.log(`RTC ports ${RTC_MIN_PORT}-${RTC_MAX_PORT}/udp, announced ip: ${ANNOUNCED_IP || '(local test)'}`);
    if (!APP_PASSWORD) console.warn('APP_PASSWORD 未设置，任何人都可加入！');
  });
})();
