import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FaceTimeAspectSync, previewAspect } from '../src/main/facetime-aspect.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const deferred = () => { let resolve, reject; const promise = new Promise((r,j) => { resolve=r;reject=j; }); return { promise,resolve,reject }; };
const view = (aspect, windowId = '42:window', peer = 'Exact displayed peer') => ({
  available: true, windowId, peer, source: 'local_preview_geometry', remoteOrientation: 'unknown',
  localPreview: aspect === '9:16' ? { width: 84, height: 150 } : { width: 150, height: 84 },
});
function fixture(t, options = {}) {
  let callbacks, aspect = options.aspect ?? '16:9', remote = options.remote ?? view('16:9');
  const calls = [], applied = [], statuses = [];
  const client = { start() {}, close() { calls.push(['close']); },
    async request(command,args) {
      calls.push([command,args]);
      if (options.request) return options.request(command,args,{ get remote(){return remote;}, set remote(v){remote=v;}, callbacks });
      if (command === 'video.status') return remote;
      const before = remote; remote = view(previewAspect(remote.localPreview) === '16:9' ? '9:16' : '16:9');
      callbacks.onEvent({ event:'video.layout_changed',source:'local_preview_geometry',after:remote.localPreview });
      return { attempted:true, verifiedChange:true, before, after:remote };
    } };
  const sync = new FaceTimeAspectSync({ pollMs:60000,
    createTransport(c) { callbacks=c;return client; }, getAspect:()=>aspect,
    async applyAspect(next,current) {
      if (options.apply) await options.apply(next,current);
      if(current()) { aspect=next;applied.push(next); }
    }, onStatus:s=>statuses.push(s),
  });
  t.after(()=>sync.close());
  sync.start();
  const snapshot = () => callbacks.onSnapshot({ video:remote });
  return { sync,callbacks,calls,applied,statuses,snapshot,
    get aspect(){return aspect;},set remote(v){remote=v;},
    studio(next){ aspect=next;sync.studioAspectChanged(next); },
    event(){callbacks.onEvent({event:'video.layout_changed',source:'local_preview_geometry'});},
  };
}
test('classifies positive dimensions with a near-square ambiguity band',()=>{
  assert.equal(previewAspect({width:84,height:150}),'9:16');
  assert.equal(previewAspect({width:150,height:69}),'16:9');
  for(const value of [{width:100,height:100},{width:102,height:100},{width:0,height:1},{width:Infinity,height:10},{width:'84',height:150},null])
    assert.equal(previewAspect(value),null);
});
test('fresh initial FaceTime observation updates scene, not FaceTime',async t=>{
  const f=fixture(t,{remote:view('9:16')});f.snapshot();await settle();
  assert.equal(f.aspect,'9:16');assert.deepEqual(f.applied,['9:16']);
  assert(!f.calls.some(([c])=>c==='video.rotate'));assert.equal(f.sync.status().state,'following');
});
test('layout event refreshes actual context, ignores stale event dimensions and does not echo',async t=>{
  const f=fixture(t);f.snapshot();await settle();
  f.remote=view('9:16');f.callbacks.onEvent({event:'video.layout_changed',source:'local_preview_geometry',after:{width:150,height:84}});
  await settle();assert.equal(f.aspect,'9:16');assert(!f.calls.some(([c])=>c==='video.rotate'));
});
test('studio change reads fresh target, rotates exactly once and ignores echo',async t=>{
  const f=fixture(t);f.snapshot();await settle();f.studio('9:16');await settle();
  const rotates=f.calls.filter(([c])=>c==='video.rotate');
  assert.equal(rotates.length,1);assert.deepEqual(rotates[0][1],{expectedWindowId:'42:window',expectedPeer:'Exact displayed peer'});
  assert.equal(f.aspect,'9:16');assert.equal(f.sync.status().observedAspect,'9:16');assert.equal(f.sync.status().error,null);
  f.event();await settle();assert.equal(f.calls.filter(([c])=>c==='video.rotate').length,1);
});
test('no rotation when studio already matches observed orientation',async t=>{
  const f=fixture(t);f.snapshot();await settle();f.studio('16:9');await settle();
  assert(!f.calls.some(([c])=>c==='video.rotate'));
});
test('missing context keeps manual control local; no stale target is used',async t=>{
  const f=fixture(t);f.snapshot();await settle();f.remote={available:false};f.studio('9:16');await settle();
  assert.equal(f.aspect,'9:16');assert(!f.calls.some(([c])=>c==='video.rotate'));assert.match(f.sync.status().error,/no rotation sent/);
});
test('near-square FaceTime view is not guessed or rotated',async t=>{
  const v=view('16:9');v.localPreview={width:100,height:100};
  const f=fixture(t,{remote:v});f.snapshot();await settle();f.studio('9:16');await settle();
  assert.equal(f.aspect,'9:16');assert.match(f.sync.status().error,/ambiguous/);assert(!f.calls.some(([c])=>c==='video.rotate'));
});
test('offline studio choice is never replayed; reconnect follows new observation',async t=>{
  const f=fixture(t);f.studio('9:16');await settle();assert.equal(f.calls.length,0);
  f.snapshot();await settle();assert.equal(f.aspect,'16:9');assert(!f.calls.some(([c])=>c==='video.rotate'));
});
test('unknown rotation outcome is surfaced, never retried on event or reconnect',async t=>{
  const f=fixture(t,{request:async(command,args,state)=>{
    if(command==='video.status')return state.remote;
    throw new Error('FaceTime video.rotate timed out; outcome unknown, not retried');
  }});
  f.snapshot();await settle();f.studio('9:16');await settle();
  assert.match(f.sync.status().error,/outcome unknown/);f.event();await settle();
  f.callbacks.onDisconnect(new Error('lost'));f.snapshot();await settle();
  assert.equal(f.calls.filter(([c])=>c==='video.rotate').length,1);
});
test('a failed verification does not count as a matching orientation',async t=>{
  const f=fixture(t,{request:async(command,args,state)=>command==='video.status'?state.remote:{attempted:true,verifiedChange:false,after:view('16:9')}});
  f.snapshot();await settle();f.studio('9:16');await settle();
  assert.match(f.sync.status().error,/did not verify/);assert.equal(f.calls.filter(([c])=>c==='video.rotate').length,1);
});
test('late observation cannot overwrite a newer studio intent',async t=>{
  const gate=deferred();let reads=0;
  const f=fixture(t,{request:async(command)=>{
    assert.equal(command,'video.status');reads++;return reads===1?gate.promise:view('9:16');
  }});
  f.snapshot();await tick();f.studio('9:16');gate.resolve(view('16:9'));await settle();
  assert.equal(f.aspect,'9:16');assert.deepEqual(f.applied,[]);
});
test('guard is rechecked after waiting on the serialized app mutation',async t=>{
  const gate=deferred();let inside=false;
  const f=fixture(t,{remote:view('9:16'),apply:async()=>{inside=true;await gate.promise;}});
  f.snapshot();await settle();assert(inside);f.studio('16:9');gate.resolve();await settle();
  assert.equal(f.aspect,'16:9');assert.deepEqual(f.applied,[]);
});
test('superseded queued studio choices are coalesced before mutation',async t=>{
  const f=fixture(t);f.snapshot();await settle();f.studio('9:16');f.studio('16:9');await settle();
  assert.equal(f.aspect,'16:9');assert(!f.calls.some(([c])=>c==='video.rotate'));
});
test('replacement video context uses new target values, never cached peer/window',async t=>{
  const f=fixture(t);f.snapshot();await settle();f.remote=view('16:9','99:new-window','New peer');
  f.studio('9:16');await settle();
  assert.deepEqual(f.calls.find(([c])=>c==='video.rotate')[1],{expectedWindowId:'99:new-window',expectedPeer:'New peer'});
});
test('close invalidates an in-flight observation and all future work',async t=>{
  const gate=deferred();const f=fixture(t,{request:async()=>gate.promise});
  f.snapshot();await tick();f.sync.close();gate.resolve(view('9:16'));await settle();
  f.event();f.snapshot();f.studio('9:16');await settle();
  assert.deepEqual(f.applied,[]);assert.equal(f.calls.filter(([c])=>c==='video.status').length,1);assert.equal(f.sync.status().state,'disabled');
});
