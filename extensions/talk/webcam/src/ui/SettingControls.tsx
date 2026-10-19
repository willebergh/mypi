import type { SceneConfig, SceneState } from '../shared/scene-config';

export interface SceneControlProps {
  config: SceneConfig;
  state: SceneState | null;
  change: <K extends keyof SceneConfig>(key: K, value: SceneConfig[K]) => void;
}

export function Slider({ id, label, value, min = 0, max = 1, onChange, ends, disabled = false, unit, step = 0.01 }: {
  id: string; label: string; value: number; min?: number; max?: number;
  onChange: (value: number) => void; ends?: [string, string]; disabled?: boolean; unit?: string; step?: number;
}) {
  return <div className="setting">
    <div className="setting-label"><label htmlFor={id}>{label}</label><output htmlFor={id}>{unit ? `${value.toFixed(1)}${unit}` : value.toFixed(2)}</output></div>
    <input id={id} type="range" disabled={disabled} min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} />
    {ends && <div className="range-ends"><span>{ends[0]}</span><span>{ends[1]}</span></div>}
  </div>;
}

export function Color({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return <div className="color-setting"><label htmlFor={id}>{label}</label><div className="color-value"><span>{value.toUpperCase()}</span><input id={id} type="color" value={value} onChange={event => onChange(event.target.value)} /></div></div>;
}
