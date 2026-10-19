import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SCENE_CONFIG, HUD_PANEL_KEYS, HUD_INSET_KEYS, HUD_PORTRAIT_INSET_KEYS, type SceneConfig, type SceneState } from '../shared/scene-config';

function schemaWarning(state: SceneState) {
  if (state.config.aspectRatio !== '16:9' && state.config.aspectRatio !== '9:16') {
    return 'This Electron copy is out of date. Use Quit (not the window close button) on all Pi Talk copies, then restart pnpm dev to enable portrait output.';
  }
  if (state.config.hudMode === undefined || state.config.hudOpacity === undefined) {
    return 'HUD is using demo defaults. Restart Electron once to enable shared HUD controls.';
  }
  if (HUD_PANEL_KEYS.some(key => typeof state.config[key] !== 'boolean') || [...HUD_INSET_KEYS, ...HUD_PORTRAIT_INSET_KEYS].some(key => typeof state.config[key] !== 'number')) {
    return 'Restart Electron once to enable HUD panel selection and independent portrait/landscape spacing profiles.';
  }
  if (state.config.sceneId === undefined) {
    return 'This Electron copy predates coded scene selection. Load the updated app later to enable the scene selector.';
  }
  if (state.config.characterId === undefined) {
    return 'This Electron copy predates character selection. Load the updated app later to enable the character selector.';
  }
  return '';
}

/** Local edits are immediate; a trailing 33ms flush coalesces slider IPC traffic. */
export function useSceneConfig(initial?: SceneState) {
  const [config, setConfig] = useState<SceneConfig>(initial?.config ?? { ...DEFAULT_SCENE_CONFIG });
  const [state, setState] = useState<SceneState | null>(initial ?? null);
  const [error, setError] = useState('');
  const current = useRef(config);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localVersion = useRef(0);
  const pending = useRef(false);
  const aspectIntent = useRef(false);
  const live = useRef(true);
  const acknowledged = useRef(!!initial);
  const lastRevision = useRef(initial?.revision ?? -1);

  useEffect(() => {
    live.current = true;
    const apply = (next: SceneState) => {
      if (!live.current || next.revision < lastRevision.current) return;
      lastRevision.current = next.revision;
      acknowledged.current = true;
      setState(next);
      setError(schemaWarning(next));
      if (!pending.current) { current.current = next.config; setConfig(next.config); }
    };
    const unsubscribe = window.webcam.onSceneState(apply);
    window.webcam.getSceneState().then(apply).catch(failure => setError(String(failure)));
    return () => { live.current = false; unsubscribe(); if (timer.current) clearTimeout(timer.current); };
  }, []);

  const edit = useCallback((next: SceneConfig) => {
    if (!acknowledged.current) return; // Never overwrite saved preferences with initial UI defaults.
    // Carry the actual edited-field intent across debounce/coalescing. A stale
    // appearance edit must never undo an automatic FaceTime aspect change.
    if (next.aspectRatio !== current.current.aspectRatio) aspectIntent.current = true;
    current.current = next;
    localVersion.current++;
    pending.current = true;
    setConfig(next);
    if (timer.current) return;
    // At most one queued flush; continuous drags still reach output about 30 times/sec.
    timer.current = setTimeout(async () => {
      timer.current = null;
      const version = localVersion.current;
      const sent = current.current;
      const aspectChange = aspectIntent.current;
      aspectIntent.current = false;
      try {
        const nextState = await window.webcam.setSceneConfig(sent, { aspectChange });
        if (!live.current) return;
        setState(previous => previous && previous.revision >= nextState.revision ? previous : nextState);
        setError(schemaWarning(nextState));
        if (version === localVersion.current) {
          pending.current = false;
          current.current = nextState.config;
          setConfig(nextState.config);
        }
      } catch (failure) {
        if (live.current) { pending.current = false; setError(String(failure)); }
      }
    }, 33);
  }, []);
  return { config, state, error, edit };
}
