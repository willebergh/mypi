import { CHARACTER_OPTIONS, type SceneConfig } from '../shared/scene-config';
import { Color, Slider, type SceneControlProps } from './SettingControls';

export default function CharacterControls({ config, state, change }: SceneControlProps) {
  return <>
    <fieldset><legend>Character</legend>
      <div className="select-setting"><label htmlFor="characterId">Model</label><select id="characterId" disabled={!state?.config.characterId} value={config.characterId ?? 'robot'} onChange={event => change('characterId', event.target.value as SceneConfig['characterId'])}>
        {CHARACTER_OPTIONS.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
      </select></div>
    </fieldset>
    <fieldset><legend>Eyes & expression</legend>
      <Color id="eyeGlowColor" label="Phosphor color" value={config.eyeGlowColor} onChange={value => change('eyeGlowColor', value)} />
      <Slider id="eyeGlowIntensity" label="Eye glow" value={config.eyeGlowIntensity} max={3} onChange={value => change('eyeGlowIntensity', value)} />
      <Slider id="eyeSquint" label="Squint" value={config.eyeSquint} onChange={value => change('eyeSquint', value)} ends={['Open', 'Narrow']} />
    </fieldset>
    <fieldset><legend>Shell & fabric</legend>
      <Color id="casingTint" label="Casing tint" value={config.casingTint} onChange={value => change('casingTint', value)} />
      <Slider id="casingWear" label="Surface wear" value={config.casingWear} onChange={value => change('casingWear', value)} ends={['Clean', 'Weathered']} />
      <Color id="hoodieColor" label="Hoodie color" value={config.hoodieColor} onChange={value => change('hoodieColor', value)} />
    </fieldset>
    <fieldset><legend>Motion</legend>
      <Slider id="idleIntensity" label="Idle intensity" value={config.idleIntensity} max={1.5} onChange={value => change('idleIntensity', value)} ends={['Still', 'Restless']} />
    </fieldset>
  </>;
}
