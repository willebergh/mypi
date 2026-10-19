import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SCENE_CONFIG } from '../../src/shared/scene-config';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const output = path.resolve('artifacts/hud-preview');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  const errors: string[] = [];
  window.webContents.setFrameRate(30);
  window.webContents.on('console-message', message => { if (message.level === 'error') errors.push(message.message); });
  const js = (source: string) => window.webContents.executeJavaScript(source);
  const config = (patch: object) => js(`window.sceneForCapture.setConfig(${JSON.stringify({ ...DEFAULT_SCENE_CONFIG, ...patch })})`);
  const capture = async (name: string) => writeFileSync(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  try {
    mkdirSync(output, { recursive: true });
    await window.loadFile(path.resolve('artifacts/artifact-checks/hud-capture.html'));
    const deadline = Date.now() + 10000;
    while (!await js('!!window.sceneForCapture')) { if (Date.now() > deadline) throw Error('Scene timeout'); await wait(50); }
    const checks = await js(`(() => {
      const h=window.hudFactory(), d=${JSON.stringify(DEFAULT_SCENE_CONFIG)};
      const meshes=()=>h.scene.children[0].children;
      const progress=m=>m.material.uniforms.opening.value;
      h.update(d,0,0);h.update(d,2,0);
      const todo=meshes().find(m=>m.material.uniforms.size.value.y===158);
      const retained=meshes().filter(m=>m!==todo);
      const hidden={...d,hudTodos:false};
      h.update(hidden,2.1,0); h.update(hidden,2.35,0);
      if(!meshes().includes(todo)||progress(todo)<=0||progress(todo)>=1)throw Error('Panel did not close gradually');
      if(retained.some(m=>!meshes().includes(m)||progress(m)!==1))throw Error('Unrelated panel changed');
      const before=progress(todo); h.update(d,2.35,0);
      if(!meshes().includes(todo)||Math.abs(progress(todo)-before)>0.00001)throw Error('Reverse toggle jumped');
      h.update(d,4,0);h.update(hidden,4.1,0);h.update(hidden,5,0);
      if(meshes().includes(todo)||meshes().length!==3)throw Error('Closed panel not released');
      h.update(d,5.1,0);
      const reopened=meshes().find(m=>m.material.uniforms.size.value.y===158);
      if(!reopened||progress(reopened)!==0)throw Error('New opening did not start independently');
      h.update(d,7,0);const off={...d,hudMode:'off'};
      h.update(off,7.1,0);h.update(off,7.35,0);
      if(!h.scene.visible||!meshes().some(m=>progress(m)>0&&progress(m)<1))throw Error('Off skipped closing render');
      h.update(off,8.2,0);
      if(h.scene.visible||meshes().length)throw Error('Off did not finish/dispose');
      h.update(d,8.3,0);h.update(d,10,0);
      if(!h.scene.visible||meshes().length!==4||meshes().some(m=>progress(m)!==1))throw Error('HUD failed to reopen');
      h.dispose();return {panelClose:true,unrelatedPanelsStable:true,continuousReversal:true,closedResourcesReleased:true,offCloseAndReopen:true};
    })()`);
    await config({}); await wait(1600);
    await config({ hudTodos: false }); await wait(280); await capture('panel-closing');
    await wait(600); await config({ hudMode: 'off' }); await wait(280); await capture('hud-closing');
    await wait(700); await capture('hud-closed');
    if (errors.length) throw Error(errors.join('\n'));
    writeFileSync(path.join(output, 'closing-checks.json'), JSON.stringify(checks, null, 2));
    await js('window.sceneForCapture.dispose()'); window.destroy(); console.log(checks); app.quit();
  } catch (error) { console.error(error); window.destroy(); app.exit(1); }
});
