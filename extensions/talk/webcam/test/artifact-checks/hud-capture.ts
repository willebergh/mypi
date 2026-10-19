import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { DEFAULT_SCENE_CONFIG } from '../../src/shared/scene-config';
const destination=path.resolve('artifacts/hud-preview');
mkdirSync(destination,{recursive:true});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:720,useContentSize:true,show:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,sandbox:true}});
 win.webContents.setFrameRate(30);
 const rendererErrors:string[]=[];
 win.webContents.on('console-message',d=>{if(d.level==='error'){rendererErrors.push(d.message);console.error(d.message)}});
 try{
  await win.loadFile(path.resolve('artifacts/artifact-checks/hud-capture.html'));
  const deadline=Date.now()+10000;
  while(!(await win.webContents.executeJavaScript('!!window.sceneForCapture'))){if(Date.now()>deadline)throw new Error('Capture scene initialization timeout');await sleep(50)}
  const results=[];
  const cases = [
   { name: 'landscape-dashboard', config: { ...DEFAULT_SCENE_CONFIG } },
   { name: 'portrait-dashboard', config: { ...DEFAULT_SCENE_CONFIG, aspectRatio: '9:16' as const } },
   { name: 'portrait-minimal', config: { ...DEFAULT_SCENE_CONFIG, aspectRatio: '9:16' as const, hudMode: 'minimal' as const } },
   { name: 'landscape-selected-inset', config: { ...DEFAULT_SCENE_CONFIG, hudTodos: false, hudWeekly: false, hudInsetTop: 5, hudInsetRight: 8, hudInsetBottom: 4, hudInsetLeft: 9 } },
   { name: 'portrait-padded', config: { ...DEFAULT_SCENE_CONFIG, aspectRatio: '9:16' as const, hudPortraitInsetTop: 4, hudPortraitInsetRight: 10, hudPortraitInsetBottom: 6, hudPortraitInsetLeft: 10, hudInsetTop: 15 } },
   { name: 'landscape-off', config: { ...DEFAULT_SCENE_CONFIG, hudMode: 'off' as const } },
  ];
  for(const {name:base,config} of cases){
   const portrait=config.aspectRatio==='9:16';win.setContentSize(portrait?720:1280,portrait?1280:720);
   await win.webContents.executeJavaScript(`window.sceneForCapture.setConfig(${JSON.stringify(config)})`);
   if(base==='landscape-dashboard') {
    await sleep(180);
    writeFileSync(path.join(destination,'landscape-opening.png'),(await win.webContents.capturePage()).toPNG());
    await sleep(450);
    writeFileSync(path.join(destination,'landscape-unfolding.png'),(await win.webContents.capturePage()).toPNG());
   }
   await sleep(1600);
   const png=await win.webContents.capturePage();
   const name=`${base}.png`;
   writeFileSync(path.join(destination,name),png.toPNG());results.push({name,size:png.getSize()});
  }
  const checks = await win.webContents.executeJavaScript(`(() => {
   const h=window.hudFactory(), d=${JSON.stringify(DEFAULT_SCENE_CONFIG)};
   const meshes=()=>h.scene.children[0].children;
   h.update(d,0,0); h.update(d,2,0);
   const retained=meshes().filter(m=>m.material.uniforms.size.value.y!==158);
   h.update({...d,hudTodos:false},2.1,0);
   h.update({...d,hudTodos:false},3,0); // Finish closing before testing a fresh opening.
   h.update(d,3.1,0);
   if(retained.some(m=>!meshes().includes(m)||m.material.uniforms.opening.value!==1))throw Error('Existing panel restarted');
   const added=meshes().find(m=>m.material.uniforms.size.value.y===158);
   if(added.material.uniforms.opening.value!==0)throw Error('New panel did not animate independently');
   h.update({...d,hudInsetLeft:10,hudInsetTop:8},3.2,0);
   if(h.scene.children[0].scale.x!==1||meshes().find(m=>m.material.uniforms.size.value.y===220).material.uniforms.size.value.x!==284)throw Error('Padding scaled panel/text');
   h.resize(720,1280); h.update({...d,aspectRatio:'9:16',hudPortraitInsetLeft:10,hudInsetLeft:15},4,0);
   const session=meshes().find(m=>m.material.uniforms.size.value.y===200);
   if(!session||session.position.x-session.material.uniforms.size.value.x/2!==96)throw Error('Portrait spacing profile not used');
   h.dispose(); return {independentOpening:true,paddingWithoutScale:true,portraitProfile:true};
  })()`);
  writeFileSync(path.join(destination,'focused-checks.json'),JSON.stringify(checks,null,2));
  await win.webContents.executeJavaScript('window.setCaptureClockOffset(20)');
  await sleep(330);
  writeFileSync(path.join(destination,'eyes-opening.png'),(await win.webContents.capturePage()).toPNG());
  await sleep(800);
  writeFileSync(path.join(destination,'eyes-ready.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`window.sceneForCapture.setConfig(${JSON.stringify({...DEFAULT_SCENE_CONFIG,hudTodos:false})})`);
  await sleep(1700);
  await win.webContents.executeJavaScript(`window.sceneForCapture.setConfig(${JSON.stringify({...DEFAULT_SCENE_CONFIG,hudTodos:true})})`);
  await sleep(160);
  writeFileSync(path.join(destination,'single-panel-opening.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript('window.sceneForCapture.dispose()');
  if(rendererErrors.length)throw new Error('Renderer errors during capture');
  win.destroy();writeFileSync(path.join(destination,'capture.json'),JSON.stringify(results,null,2));app.quit();
 }catch(error){console.error(error);win.destroy();app.exit(1)}
});
