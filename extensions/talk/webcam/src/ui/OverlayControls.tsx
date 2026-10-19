import { DEFAULT_SCENE_CONFIG, HUD_PANEL_KEYS, HUD_INSET_KEYS, HUD_PORTRAIT_INSET_KEYS, type SceneConfig } from '../shared/scene-config';
import type { LiveHudState } from '../shared/live-protocol';
import { Slider, type SceneControlProps } from './SettingControls';
import DemoControls from './DemoControls';

interface Props extends SceneControlProps {
  liveHud: LiveHudState;
  edit: (config: SceneConfig) => void;
  onModeChange: (mode: 'live' | 'demo') => void;
}

export default function OverlayControls({ config, state, change, edit, liveHud, onModeChange }: Props) {
  const canConfigureHud = state?.config.hudMode !== undefined && state?.config.hudOpacity !== undefined;
  const canSelectHudPanels = !!state && HUD_PANEL_KEYS.every(key => typeof state.config[key] === 'boolean');
  const insetKeys = config.aspectRatio === '9:16' ? HUD_PORTRAIT_INSET_KEYS : HUD_INSET_KEYS;
  const canAdjustHudInsets = !!state && insetKeys.every(key => typeof state.config[key] === 'number');
  const canConfigureHudProfiles = !!state && HUD_PORTRAIT_INSET_KEYS.every(key => typeof state.config[key] === 'number');
  return <>
    <fieldset className="hud-settings"><legend>Telemetry</legend>
      <div className="select-setting"><label htmlFor="hudSource">Source</label><select id="hudSource" value={liveHud.mode} onChange={event => onModeChange(event.target.value as 'live' | 'demo')}>
        <option value="live">Live (Pi publisher)</option><option value="demo">Demo (authored fixtures)</option>
      </select></div>
      <p className="panel-note">{liveHud.mode === 'demo' ? 'Demo uses authored data. No real call or live Pi telemetry.' : 'Live is read-only Pi telemetry. Offline never falls back to demo.'}</p>
    </fieldset>
    <fieldset className="hud-settings"><legend>HUD display</legend>
      <label className="hud-toggle"><input id="showHud" type="checkbox" disabled={!canConfigureHud} checked={config.hudMode !== 'off'} onChange={event => change('hudMode', event.target.checked ? 'dashboard' : 'off')} />Show HUD</label>
      <Slider id="hudOpacity" label="Hologram intensity" disabled={!canConfigureHud} value={config.hudOpacity ?? DEFAULT_SCENE_CONFIG.hudOpacity} onChange={value => change('hudOpacity', value)} />
      <div className="hud-panel-choices" role="group" aria-label="Visible HUD panels">
        <span className="hud-panel-label">Visible panels</span>
        {([
          ['hudSession', 'Session', 'Main context & recent events'],
          ['hudSubagents', 'Subagents', 'Per-agent context windows'],
          ['hudTodos', 'Todos', 'Task queue'],
          ['hudWeekly', 'Weekly limit', 'Provider usage budget'],
        ] as const).map(([key, label, detail]) => <label key={key} title={detail}>
          <input type="checkbox" disabled={canSelectHudPanels === false} checked={config[key] ?? true} onChange={event => change(key, event.target.checked)} />
          <span>{label}</span>
        </label>)}
      </div>
      <details className="hud-spacing"><summary>Safe area · {config.aspectRatio === '9:16' ? 'Portrait' : 'Landscape'}</summary>
        <p className="panel-note">Extra safe area (% of output). Each orientation keeps its own spacing.</p>
        {insetKeys.map(key => <Slider key={key} id={key} label={key.replace(/^hud(?:Portrait)?Inset/, '')} value={config[key] ?? 0} max={15} step={0.5} unit="%" disabled={!canAdjustHudInsets} onChange={value => change(key, value)} />)}
        <button className="text-button" disabled={!canAdjustHudInsets} onClick={() => edit({ ...config, ...Object.fromEntries(insetKeys.map(key => [key, 0])) })}>Reset {config.aspectRatio === '9:16' ? 'portrait' : 'landscape'} padding</button>
      </details>
      {(!canSelectHudPanels || !canAdjustHudInsets || !canConfigureHudProfiles) && <p className="compatibility-note">Restart Electron once to enable independent spacing profiles.</p>}
    </fieldset>
    <DemoControls liveHud={liveHud} />
  </>;
}
