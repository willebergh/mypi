import { app } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { OffscreenRenderer } from '../../src/main/offscreen';
const root = process.cwd();
app.getAppPath = () => root; // This standalone fixture uses the existing project addon, no rebuild.
const results: unknown[] = [];
const output = new OffscreenRenderer(async win => {
  await win.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><style>body{margin:0}</style><canvas id="c"></canvas><script>
  const c=document.getElementById('c'),ctx=c.getContext('2d');
  function draw(t){if(c.width!==innerWidth||c.height!==innerHeight){c.width=innerWidth;c.height=innerHeight;}ctx.fillStyle='#182d46';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='#ffbd71';ctx.fillRect((t*.1)%(c.width-50),100,50,50);requestAnimationFrame(draw)}requestAnimationFrame(draw);
  </script>`));
}, () => {});
const pause = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
async function check(width:number,height:number) {
  const deadline=Date.now()+6000;
  while(Date.now()<deadline) {
    const status=output.refreshStatus();
    if(status.native.error)throw new Error(status.native.error);
    if(status.width===width&&status.height===height&&status.native.framesProcessed>=3) {
      results.push({requested:[width,height],actual:output.window!.getContentSize(),windowID:output.window!.id,frames:status.native.framesProcessed,errors:status.native.failedFrames});return;
    }
    await pause(30);
  }
  throw new Error('Timed out: '+JSON.stringify({size:output.window?.getContentSize(),status:output.refreshStatus()}));
}
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=> {
  try {
    await output.start(); await check(1280,720);
    await output.setResolution(720,1280);await check(720,1280);
    await output.setResolution(1280,720);await check(1280,720);
    await output.stop();
    writeFileSync(path.join(root,'artifacts/aspect-resize-smoke.json'),JSON.stringify({passed:true,fixture:'animated 2D canvas, existing Metal addon',results},null,2));
    app.quit();
  }catch(error){writeFileSync(path.join(root,'artifacts/aspect-resize-smoke.json'),JSON.stringify({passed:false,error:String(error),results},null,2));await output.stop();app.exit(1);}
});
