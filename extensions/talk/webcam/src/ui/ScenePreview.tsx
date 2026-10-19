import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createScene, type AvatarScene, type SceneStats } from '../avatar/scene';
import type { CameraPose } from '../shared/output-view';
import { acquireLiveHudFeed } from '../shared/live-feed';
import { createSpeechAudioFeed } from '../shared/speech-audio-feed';
import type { SceneConfig } from '../shared/scene-config';

export interface PreviewHandle { resetCamera(): void; getCameraPose(): CameraPose | null }
interface Props {
  config: SceneConfig;
  initialPose?: CameraPose | null;
  onStats: (stats: SceneStats) => void;
  onError: (message: string) => void;
}
const ScenePreview = forwardRef<PreviewHandle, Props>(function ScenePreview({ config, initialPose, onStats, onError }, ref) {
  const mount = useRef<HTMLDivElement>(null);
  const scene = useRef<AvatarScene | null>(null);
  const savedPose = useRef(initialPose);
  const latest = useRef(config);
  latest.current = config;
  useImperativeHandle(ref, () => ({ resetCamera: () => scene.current?.resetCamera(), getCameraPose: () => scene.current?.getCameraPose() ?? null }), []);
  useEffect(() => {
    const element = mount.current!;
    let observer: ResizeObserver | null = null;
    const audio = createSpeechAudioFeed();
    const liveHud = acquireLiveHudFeed();
    let cameraApiAvailable = typeof window.webcam?.updateEditorPose === 'function';
    try {
      const avatar = createScene(element, { mode: 'editor', config: latest.current, initialCameraPose: savedPose.current ?? undefined,
        width: element.clientWidth, height: element.clientHeight, getSpeechAudioFrame: audio.read, getHudSnapshot: liveHud.snapshot, onStats, onError,
        onCameraPose: pose => {
          if (cameraApiAvailable) void window.webcam.updateEditorPose(pose).catch(error => {
            if (/No handler|not registered/i.test(String(error))) cameraApiAvailable = false;
          });
        } });
      scene.current = avatar;
      observer = new ResizeObserver(entries => {
        const size = entries[0]?.contentRect;
        if (size && size.width > 0 && size.height > 0) avatar.resize(size.width, size.height);
      });
      observer.observe(element);
    } catch (error) { onError(String(error)); }
    return () => { liveHud.dispose(); audio.dispose(); observer?.disconnect(); scene.current?.dispose(); scene.current = null; };
  }, [onStats, onError]);
  useEffect(() => { scene.current?.setConfig(config); }, [config]);
  return <div ref={mount} className="preview-canvas-mount" data-testid="scene-preview" />;
});
export default ScenePreview;
