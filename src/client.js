import * as mediasoupClient from 'mediasoup-client';

const $ = selector => document.querySelector(selector);

let ws = null;
let device = null;
let sendTransport = null;
let recvTransport = null;
let recvTransportId = null;
let myPeerId = null;
let myName = '玩家';
let selectedPeerId = 'all';
let suppressNextCloseStatus = false;

const pending = new Map();
let reqSeq = 0;

const peers = new Map();
const producerMeta = new Map();
const local = { mic: null, screen: null, screenAudio: null, camera: null };
const localTiles = new Map();
const remoteTiles = new Map();
const remoteAudios = new Map();

let meterContext = null;
let meterFrame = 0;

function setStatus(text, isError = false) {
  const status = $('#status');
  status.textContent = text;
  status.classList.toggle('error', isError);
  if ($('#main').style.display !== 'grid') {
    $('#loginStatus').textContent = isError ? text : '';
  }
}

function request(method, data = {}) {
  return new Promise((resolve, reject) => {
    const id = ++reqSeq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, data }));
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`${method} 请求超时`));
    }, 15000);
  });
}

function onMessage(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }

  if (message.id) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.ok ? waiter.resolve(message.data) : waiter.reject(new Error(message.error));
    return;
  }

  const { event: eventName, data } = message;
  if (eventName === 'newProducer') {
    producerMeta.set(data.producerId, data);
    renderMembers();
    consumeProducer(data).catch(error => console.error('consume failed', error));
  } else if (eventName === 'producerClosed') {
    removeRemote(data.producerId);
  } else if (eventName === 'peerJoined') {
    peers.set(data.id, { id: data.id, name: data.name });
    renderMembers();
    setStatus(`${data.name} 加入了房间`);
  } else if (eventName === 'peerLeft') {
    removePeer(data.id);
  }
}

async function join() {
  const roomName = $('#room').value.trim() || 'lobby';
  myName = $('#name').value.trim() || '玩家';
  const password = $('#password').value;
  $('#joinBtn').disabled = true;
  $('#loginStatus').textContent = '';

  try {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}/ws`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('无法连接服务器'));
    });
    ws.onmessage = onMessage;
    ws.onclose = () => {
      if (suppressNextCloseStatus) {
        suppressNextCloseStatus = false;
        return;
      }
      setStatus('与服务器断开连接，请刷新页面重进', true);
    };

    const info = await request('join', { room: roomName, name: myName, password });
    myPeerId = info.peerId;
    peers.set(myPeerId, { id: myPeerId, name: myName, self: true });
    for (const peer of info.peers) peers.set(peer.id, peer);
    for (const meta of info.producers) producerMeta.set(meta.producerId, meta);

    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: info.rtpCapabilities });

    const sendInfo = await request('createTransport');
    sendTransport = device.createSendTransport(sendInfo);
    sendTransport.on('connect', ({ dtlsParameters }, callback, errback) =>
      request('connectTransport', { transportId: sendInfo.id, dtlsParameters }).then(callback).catch(errback));
    sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) =>
      request('produce', { transportId: sendInfo.id, kind, rtpParameters, appData })
        .then(({ producerId }) => callback({ id: producerId })).catch(errback));

    const recvInfo = await request('createTransport');
    recvTransportId = recvInfo.id;
    recvTransport = device.createRecvTransport(recvInfo);
    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) =>
      request('connectTransport', { transportId: recvInfo.id, dtlsParameters }).then(callback).catch(errback));

    $('#login').style.display = 'none';
    $('#main').style.display = 'grid';
    $('#roomTitle').textContent = roomName;
    document.title = `${roomName} · Party`;
    renderMembers();
    updateStage();
    refreshDevices();

    await Promise.allSettled(info.producers.map(meta => consumeProducer(meta)));
    setStatus(`已进入房间「${roomName}」`);
  } catch (error) {
    setStatus(error.message, true);
    $('#joinBtn').disabled = false;
    if (ws) {
      suppressNextCloseStatus = true;
      try { ws.close(); } catch {}
      ws = null;
    }
  }
}

function mediaConstraints(kind, deviceId) {
  const selected = deviceId ? { deviceId: { exact: deviceId } } : {};
  if (kind === 'audio') {
    return { ...selected, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }
  return { ...selected, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 25 } };
}

async function toggleMic() {
  if (local.mic) {
    await stopMic();
    setStatus('麦克风已关闭');
  } else {
    await startMic();
  }
}

async function startMic() {
  requireMediaDevices();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: mediaConstraints('audio', $('#micSelect').value)
  });
  const track = stream.getAudioTracks()[0];
  try {
    local.mic = await sendTransport.produce({ track, appData: { source: 'mic' } });
  } catch (error) {
    track.stop();
    throw error;
  }
  const producer = local.mic;
  producer.on('trackended', () => {
    if (local.mic === producer) stopMic().catch(() => {});
  });
  $('#micBtn').classList.add('on');
  startMicMeter(stream);
  await refreshDevices();
  renderMembers();
  setStatus('麦克风已开启');
}

async function stopMic() {
  await stopProducer('mic');
  $('#micBtn').classList.remove('on');
  stopMicMeter();
  renderMembers();
}

async function restartMic() {
  if (!local.mic) return;
  await stopMic();
  await startMic();
}

async function toggleCamera() {
  if (local.camera) {
    await stopCamera();
    setStatus('摄像头已关闭');
  } else {
    await startCamera();
  }
}

async function startCamera() {
  requireMediaDevices();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: mediaConstraints('video', $('#camSelect').value)
  });
  const track = stream.getVideoTracks()[0];
  try {
    local.camera = await sendTransport.produce({
      track,
      encodings: [{ maxBitrate: 800_000 }],
      appData: { source: 'camera' }
    });
  } catch (error) {
    track.stop();
    throw error;
  }
  const producer = local.camera;
  producer.on('trackended', () => {
    if (local.camera === producer) stopCamera().catch(() => {});
  });
  addLocalPreview('camera', new MediaStream([track]));
  $('#camBtn').classList.add('on');
  await refreshDevices();
  renderMembers();
  setStatus('摄像头已开启');
}

async function stopCamera() {
  await stopProducer('camera');
  removeLocalPreview('camera');
  $('#camBtn').classList.remove('on');
  renderMembers();
}

async function restartCamera() {
  if (!local.camera) return;
  await stopCamera();
  await startCamera();
}

async function toggleScreen() {
  if (local.screen) {
    await stopScreen();
    setStatus('屏幕共享已停止');
    return;
  }
  requireMediaDevices();
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 25, max: 30 }, height: { max: 1080 } },
    audio: true
  });
  const videoTrack = stream.getVideoTracks()[0];
  try {
    local.screen = await sendTransport.produce({
      track: videoTrack,
      encodings: [{ maxBitrate: 2_500_000 }],
      appData: { source: 'screen' }
    });
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      local.screenAudio = await sendTransport.produce({
        track: audioTrack,
        appData: { source: 'screen-audio' }
      });
    }
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    throw error;
  }
  const producer = local.screen;
  videoTrack.addEventListener('ended', () => {
    if (local.screen === producer) stopScreen().catch(() => {});
  });
  addLocalPreview('screen', stream);
  $('#screenBtn').classList.add('on');
  renderMembers();
  setStatus('正在共享屏幕');
}

async function stopScreen() {
  await stopProducer('screen');
  await stopProducer('screenAudio');
  removeLocalPreview('screen');
  $('#screenBtn').classList.remove('on');
  renderMembers();
}

async function stopProducer(key) {
  const producer = local[key];
  if (!producer) return;
  local[key] = null;
  try { producer.track?.stop(); } catch {}
  try { producer.close(); } catch {}
  try { await request('closeProducer', { producerId: producer.id }); } catch {}
}

function requireMediaDevices() {
  if (!navigator.mediaDevices) {
    throw new Error('当前页面不是安全上下文，请使用 HTTPS 或 localhost');
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillDeviceSelect($('#micSelect'), devices.filter(item => item.kind === 'audioinput'), '默认麦克风');
    fillDeviceSelect($('#camSelect'), devices.filter(item => item.kind === 'videoinput'), '默认摄像头');
  } catch (error) {
    console.warn('enumerateDevices failed', error);
  }
}

function fillDeviceSelect(select, devices, fallback) {
  const selected = select.value;
  select.replaceChildren();
  const defaultOption = new Option(fallback, '');
  select.add(defaultOption);
  devices.forEach((item, index) => {
    select.add(new Option(item.label || `${fallback} ${index + 1}`, item.deviceId));
  });
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function startMicMeter(stream) {
  stopMicMeter();
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  meterContext = new AudioContext();
  const analyser = meterContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = .65;
  meterContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);

  const draw = () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    const level = Math.min(100, Math.sqrt(sum / samples.length) * 320);
    $('#micLevel').style.width = `${level}%`;
    $('#micMeter').setAttribute('aria-valuenow', String(Math.round(level)));
    meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

function stopMicMeter() {
  cancelAnimationFrame(meterFrame);
  meterFrame = 0;
  if (meterContext) meterContext.close().catch(() => {});
  meterContext = null;
  $('#micLevel').style.width = '0%';
  $('#micMeter').setAttribute('aria-valuenow', '0');
}

async function consumeProducer(meta) {
  if (remoteTiles.has(meta.producerId) || remoteAudios.has(meta.producerId)) return;
  const data = await request('consume', {
    producerId: meta.producerId,
    transportId: recvTransportId,
    rtpCapabilities: device.rtpCapabilities
  });
  const consumer = await recvTransport.consume(data);
  await request('resumeConsumer', { consumerId: data.id });
  const stream = new MediaStream([consumer.track]);

  if (consumer.kind === 'video') {
    const tile = makeTile(`${meta.peerName} · ${sourceLabel(meta.source)}`, stream, true);
    tile.dataset.peer = meta.peerId;
    tile._consumer = consumer;
    $('#videos').appendChild(tile);
    remoteTiles.set(meta.producerId, tile);
  } else {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.dataset.peer = meta.peerId;
    audio.srcObject = stream;
    audio._consumer = consumer;
    document.body.appendChild(audio);
    remoteAudios.set(meta.producerId, audio);
  }
  updateStage();
}

function sourceLabel(source) {
  return source === 'screen' ? '屏幕共享' : source === 'camera' ? '摄像头' : '';
}

function makeTile(labelText, stream, muted) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = Boolean(muted);
  video.srcObject = stream;
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = labelText;
  tile.append(video, label);
  tile.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else tile.requestFullscreen().catch(() => {});
  });
  return tile;
}

function addLocalPreview(source, stream) {
  removeLocalPreview(source);
  const tile = makeTile(`我 · ${sourceLabel(source)}（预览）`, stream, true);
  tile.classList.add('mine');
  tile.dataset.peer = myPeerId;
  tile.dataset.source = source;
  localTiles.set(source, tile);
  $('#videos').appendChild(tile);
  updateStage();
}

function removeLocalPreview(source) {
  const tile = localTiles.get(source);
  if (!tile) return;
  tile.remove();
  localTiles.delete(source);
  updateStage();
}

function removeRemote(producerId) {
  const tile = remoteTiles.get(producerId);
  if (tile) {
    try { tile._consumer?.close(); } catch {}
    tile.remove();
    remoteTiles.delete(producerId);
  }
  const audio = remoteAudios.get(producerId);
  if (audio) {
    try { audio._consumer?.close(); } catch {}
    audio.remove();
    remoteAudios.delete(producerId);
  }
  producerMeta.delete(producerId);
  renderMembers();
  updateStage();
}

function removePeer(peerId) {
  const name = peers.get(peerId)?.name || '成员';
  for (const [producerId, meta] of [...producerMeta]) {
    if (meta.peerId === peerId) removeRemote(producerId);
  }
  peers.delete(peerId);
  if (selectedPeerId === peerId) selectedPeerId = 'all';
  renderMembers();
  updateStage();
  setStatus(`${name} 离开了房间`);
}

function sourcesForPeer(peerId) {
  const sources = new Set();
  if (peerId === myPeerId) {
    if (local.mic) sources.add('mic');
    if (local.camera) sources.add('camera');
    if (local.screen) sources.add('screen');
  }
  for (const meta of producerMeta.values()) {
    if (meta.peerId === peerId) sources.add(meta.source);
  }
  return sources;
}

function renderMembers() {
  const list = $('#memberList');
  list.replaceChildren();
  list.appendChild(makeMemberButton('all', '全部画面', new Set()));
  const sorted = [...peers.values()].sort((a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self)));
  for (const peer of sorted) {
    const displayName = peer.self ? `${peer.name}（我）` : peer.name;
    list.appendChild(makeMemberButton(peer.id, displayName, sourcesForPeer(peer.id)));
  }
  $('#roomCount').textContent = `${peers.size} 位成员`;
}

function makeMemberButton(peerId, name, sources) {
  const button = document.createElement('button');
  button.className = 'member';
  button.classList.toggle('selected', selectedPeerId === peerId);
  button.dataset.peer = peerId;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = peerId === 'all' ? '全' : [...name][0]?.toUpperCase() || '?';
  const label = document.createElement('span');
  label.className = 'member-name';
  label.textContent = name;
  const flags = document.createElement('span');
  flags.className = 'media-flags';
  flags.innerHTML = [
    `<span class="${sources.has('mic') ? 'active' : ''}" title="麦克风">麦</span>`,
    `<span class="${sources.has('camera') ? 'active' : ''}" title="摄像头">像</span>`,
    `<span class="${sources.has('screen') ? 'active' : ''}" title="屏幕共享">屏</span>`
  ].join('');
  button.append(avatar, label, flags);
  button.addEventListener('click', () => {
    selectedPeerId = peerId;
    renderMembers();
    updateStage();
  });
  return button;
}

function updateStage() {
  const tiles = [...$('#videos').children];
  for (const tile of tiles) {
    tile.classList.toggle('is-hidden', selectedPeerId !== 'all' && tile.dataset.peer !== selectedPeerId);
  }
  const visible = tiles.filter(tile => !tile.classList.contains('is-hidden'));
  $('#emptyStage').style.display = visible.length ? 'none' : 'grid';
  fitGrid(visible.length);
}

function fitGrid(count) {
  const grid = $('#videos');
  if (count <= 0) {
    grid.style.setProperty('--grid-cols', '1');
    grid.style.setProperty('--grid-rows', '1');
    return;
  }
  const width = Math.max(1, grid.clientWidth - 24);
  const height = Math.max(1, grid.clientHeight - 24);
  let best = { cols: 1, rows: count, area: 0 };
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cellWidth = (width - (cols - 1) * 10) / cols;
    const cellHeight = (height - (rows - 1) * 10) / rows;
    const videoWidth = Math.min(cellWidth, cellHeight * 16 / 9);
    const videoHeight = Math.min(cellHeight, cellWidth * 9 / 16);
    const area = videoWidth * videoHeight;
    if (area > best.area) best = { cols, rows, area };
  }
  grid.style.setProperty('--grid-cols', String(best.cols));
  grid.style.setProperty('--grid-rows', String(best.rows));
}

$('#joinBtn').addEventListener('click', join);
$('#password').addEventListener('keydown', event => { if (event.key === 'Enter') join(); });
$('#micBtn').addEventListener('click', () => toggleMic().catch(error => setStatus(error.message, true)));
$('#camBtn').addEventListener('click', () => toggleCamera().catch(error => setStatus(error.message, true)));
$('#screenBtn').addEventListener('click', () => toggleScreen().catch(error => setStatus(error.message, true)));
$('#micSelect').addEventListener('change', () => restartMic().catch(error => setStatus(error.message, true)));
$('#camSelect').addEventListener('change', () => restartCamera().catch(error => setStatus(error.message, true)));
$('#leaveBtn').addEventListener('click', () => location.reload());

new ResizeObserver(updateStage).observe($('#stage'));
navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
