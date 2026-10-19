import * as THREE from 'three';
import { createDesktopCapture } from '../shared/desktop-capture';
import { DESKTOP_SLOTS, type DesktopSlot } from '../shared/desktop-screens';

/** Renderer-owned video elements/textures, independent of environment GPU resource owners. */
export function createDesktopTextures(changed: (textures: Partial<Record<DesktopSlot, THREE.Texture>>) => void) {
  const videos = new Map<MediaStream, { video: HTMLVideoElement; texture: THREE.VideoTexture }>();
  const api = typeof window !== 'undefined' && typeof window.webcam?.getDesktopState === 'function' ? window.webcam : undefined;
  const feed = createDesktopCapture(api, () => navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 12, max: 15 } },
  }), (streams, state) => {
    const next: Partial<Record<DesktopSlot, THREE.Texture>> = {};
    for (const stream of streams.values()) if (!videos.has(stream)) {
      const video = document.createElement('video'); video.muted = true; video.autoplay = true; video.playsInline = true; video.srcObject = stream;
      const texture = new THREE.VideoTexture(video); texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
      videos.set(stream, { video, texture });
      void video.play().catch(() => { stream.getTracks().forEach(t => t.stop()); });
    }
    for (const slot of DESKTOP_SLOTS) {
      const id = state?.mapping[slot], stream = id ? streams.get(id) : undefined;
      if (stream) next[slot] = videos.get(stream)!.texture;
    }
    changed(next); // Unbind maps before releasing GPU textures.
    for (const [stream, entry] of videos) if (![...streams.values()].includes(stream)) {
      entry.video.pause(); entry.video.srcObject = null; entry.video.remove(); entry.texture.dispose(); videos.delete(stream);
    }
  });
  return feed;
}
