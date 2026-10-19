import { SCENE_OPTIONS, type SceneConfig } from '../shared/scene-config';
import { Slider, type SceneControlProps } from './SettingControls';

export default function SceneControls({ config, state, change }: SceneControlProps) {
  return <>
    <fieldset><legend>Environment</legend>
      <div className="select-setting"><label htmlFor="sceneId">Scene</label><select id="sceneId" disabled={!state?.config.sceneId} value={config.sceneId ?? 'workshop'} onChange={event => change('sceneId', event.target.value as SceneConfig['sceneId'])}>
        {SCENE_OPTIONS.map(scene => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
      </select></div>
    </fieldset>
    <fieldset><legend>Lighting & atmosphere</legend>
      <Slider id="roomIntensity" label="Room lighting" value={config.roomIntensity} max={2} onChange={value => change('roomIntensity', value)} />
      <Slider id="warmCoolBalance" label="Light balance" value={config.warmCoolBalance} onChange={value => change('warmCoolBalance', value)} ends={['Cool blue', 'Warm amber']} />
    </fieldset>
  </>;
}
