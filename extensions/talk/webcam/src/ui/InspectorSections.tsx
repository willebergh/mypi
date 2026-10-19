import type { EditorPreferences } from '../shared/settings';
import { DEFAULT_SCENE_CONFIG, HUD_PANEL_KEYS, HUD_INSET_KEYS, HUD_PORTRAIT_INSET_KEYS, type SceneConfig } from '../shared/scene-config';
import type { LiveHudState } from '../shared/live-protocol';
import type { SceneControlProps } from './SettingControls';
import SceneControls from './SceneControls';
import CharacterControls from './CharacterControls';
import OverlayControls from './OverlayControls';

interface Props extends SceneControlProps {
  section: EditorPreferences['inspectorSection'];
  onSectionChange: (section: EditorPreferences['inspectorSection']) => void;
  liveHud: LiveHudState;
  edit: (config: SceneConfig) => void;
  onModeChange: (mode: 'live' | 'demo') => void;
}

const sections = ['Scene', 'Character', 'Overlay'] as const;

export default function InspectorSections({ config, state, change, edit, liveHud, onModeChange, section, onSectionChange }: Props) {
  // Reset has always included HUD settings; retain its capability guards and scope.
  const insetKeys = config.aspectRatio === '9:16' ? HUD_PORTRAIT_INSET_KEYS : HUD_INSET_KEYS;
  const canReset = !!state?.config.characterId
    && (state.config.aspectRatio === '16:9' || state.config.aspectRatio === '9:16')
    && state.config.hudMode !== undefined && state.config.hudOpacity !== undefined
    && HUD_PANEL_KEYS.every(key => typeof state.config[key] === 'boolean')
    && [...insetKeys, ...HUD_PORTRAIT_INSET_KEYS].every(key => typeof state.config[key] === 'number');
  return <>
    <div className="inspector-tabs" role="group" aria-label="Inspector sections">
      {sections.map(name => <button key={name} id={`inspect-${name}`} aria-pressed={section === name} aria-controls={`inspector-${name}`} onClick={() => onSectionChange(name)}>{name}</button>)}
    </div>
    <div className="settings-scroll">
      <section id="inspector-Scene" aria-labelledby="inspect-Scene" hidden={section !== 'Scene'}><SceneControls config={config} state={state} change={change} /></section>
      <section id="inspector-Character" aria-labelledby="inspect-Character" hidden={section !== 'Character'}><CharacterControls config={config} state={state} change={change} /></section>
      <section id="inspector-Overlay" aria-labelledby="inspect-Overlay" hidden={section !== 'Overlay'}><OverlayControls config={config} state={state} change={change} edit={edit} liveHud={liveHud} onModeChange={onModeChange} /></section>
      <details className="reset-settings"><summary>Reset settings</summary>
        <p className="panel-note" id="reset-settings-scope">Resets lighting, character appearance, motion and all HUD settings, including both padding profiles. Keeps the scene, character model, output format and framing.</p>
        <button className="text-button" disabled={!canReset} aria-describedby="reset-settings-scope" onClick={() => edit({ ...DEFAULT_SCENE_CONFIG, sceneId: config.sceneId, characterId: config.characterId, aspectRatio: config.aspectRatio })}>Reset settings</button>
      </details>
    </div>
  </>;
}
