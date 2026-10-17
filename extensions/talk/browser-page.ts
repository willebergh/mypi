export function renderBrowserPage(nonce: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new Error("Invalid page nonce");
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi Talk — Codex WebRTC</title>
<style nonce="${nonce}">
body { color: #eee; background: #17191c; font: 17px system-ui; max-width: 650px; margin: 8vh auto; padding: 24px; }
button { padding: 12px 18px; margin: 8px 8px 8px 0; font: inherit; } audio { display: block; margin-top: 20px; width: 100%; }
#status { padding: 16px; background: #272b30; white-space: pre-wrap; } small { color: #bbb; }
</style>
<h1>Pi Talk · Codex route</h1>
<p>This page handles the microphone and speaker for your Pi session. Your Codex credential stays in Pi.</p>
<p>Use headphones. Browser echo cancellation is requested, but feedback is still possible.</p>
<button id="start">Start microphone</button><button id="stop" disabled>Stop Talk</button>
<button id="speaker">Enable speaker</button>
<p id="status">Ready. Click Start microphone and allow microphone access.</p>
<audio id="audio" autoplay controls></audio>
<p><small>Closing this page or running /talk stop ends the voice connection. Pi tasks already started can keep running.</small></p>
<script nonce="${nonce}">
(() => {
  const key = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  const status = document.getElementById('status');
  const start = document.getElementById('start');
  const stop = document.getElementById('stop');
  const audio = document.getElementById('audio');
  let ws, pc, dc, microphone, ended = false, announced = false;
  const bytes = (value) => new TextEncoder().encode(value).length;
  const show = (value) => { status.textContent = value; };
  function send(value) {
    const encoded = JSON.stringify(value);
    if (!ws || ws.readyState !== WebSocket.OPEN || bytes(encoded) > 300 * 1024 || ws.bufferedAmount > 512 * 1024) throw new Error('relay');
    ws.send(encoded);
  }
  function end(notify = true, message = 'Talk stopped. Start a new /talk session in Pi to reconnect.') {
    if (ended) return;
    ended = true;
    if (notify && ws && ws.readyState === WebSocket.OPEN) { try { send({type:'closed'}); } catch {} }
    if (microphone) microphone.getTracks().forEach((track) => track.stop());
    if (dc) dc.close();
    if (pc) pc.close();
    if (ws) ws.close();
    audio.pause(); audio.srcObject = null;
    start.disabled = true; stop.disabled = true;
    show(message);
  }
  function fail(message) {
    if (ended) return;
    try { send({type:'error'}); } catch {}
    end(false, message);
  }
  function ready() {
    if (!announced && !ended && dc && dc.readyState === 'open' && pc.connectionState === 'connected') {
      announced = true;
      send({type:'ready'});
      show('Talk live — microphone is on. Return to Pi for captions and delegated work.');
    }
  }
  document.getElementById('speaker').onclick = () => {
    audio.play().catch(() => show('Speaker is not ready yet. Try again once Talk is connected.'));
  };
  stop.onclick = () => end();
  window.addEventListener('pagehide', () => end());
  start.onclick = async () => {
    start.disabled = true; stop.disabled = false;
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) { fail('This link has expired. Start /talk again in Pi.'); return; }
    try {
      show('Connecting to Pi…');
      ws = new WebSocket('ws://' + location.host + '/peer', ['mypi-talk', key]);
      ws.onclose = () => end(false);
      ws.onerror = () => fail('Could not connect to Pi. Start /talk again.');
      ws.onmessage = async (message) => {
        if (ended) return;
        try {
          if (typeof message.data !== 'string' || bytes(message.data) > 300 * 1024) throw new Error('message');
          const event = JSON.parse(message.data);
          if (event.type === 'stop') { end(false); return; }
          if (event.type === 'answer') {
            await pc.setRemoteDescription({type:'answer', sdp:event.sdp});
          } else if (event.type === 'send') {
            const encoded = JSON.stringify(event.event);
            if (!dc || dc.readyState !== 'open' || dc.bufferedAmount + bytes(encoded) > 512 * 1024) throw new Error('data');
            dc.send(encoded);
          }
        } catch { fail('Talk transport failed. Check the error in Pi and restart /talk.'); }
      };
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, {once:true});
        ws.addEventListener('error', reject, {once:true});
        ws.addEventListener('close', reject, {once:true});
      });
      if (ended) return;
      show('Allow microphone access…');
      microphone = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if (ended) { microphone.getTracks().forEach((track) => track.stop()); return; }
      microphone.getTracks().forEach((track) => { track.onended = () => fail('Microphone access ended. Restart /talk in Pi.'); });
      pc = new RTCPeerConnection();
      microphone.getTracks().forEach((track) => pc.addTrack(track, microphone));
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        audio.play().catch(() => show('Connected, but playback was blocked. Click Enable speaker.'));
      };
      pc.onconnectionstatechange = () => {
        if (ended) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fail('WebRTC connection ended. Restart /talk in Pi.');
        else ready();
      };
      dc = pc.createDataChannel('oai-events');
      dc.onopen = ready;
      dc.onerror = () => fail('Voice data channel failed. Restart /talk in Pi.');
      dc.onclose = () => { if (!ended) fail('Voice data channel closed. Restart /talk in Pi.'); };
      dc.onmessage = (message) => {
        try {
          if (typeof message.data !== 'string' || bytes(message.data) > 256 * 1024) throw new Error('event');
          send({type:'event', event:JSON.parse(message.data)});
        } catch { fail('Voice event relay failed. Restart /talk in Pi.'); }
      };
      show('Creating Codex voice connection…');
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error('ICE')); }, 10_000);
          const changed = () => { if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
          function cleanup() { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); }
          pc.addEventListener('icegatheringstatechange', changed);
          changed();
        });
      }
      if (ended) return;
      const sdp = pc.localDescription.sdp;
      if (bytes(sdp) > 256 * 1024) throw new Error('SDP');
      send({type:'offer', sdp});
    } catch {
      fail('Could not start voice. Check microphone permission, the browser connection, and the error in Pi.');
    }
  };
})();
</script></html>`;
}
