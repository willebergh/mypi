import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  // Prebundle both pages together: discovery-triggered reloads must not interrupt a cold-start WebGL scene.
  optimizeDeps: {
    entries: ['ui.html', 'output.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'three',
      'three/examples/jsm/controls/OrbitControls.js', 'three/addons/geometries/RoundedBoxGeometry.js',
      'three/addons/utils/BufferGeometryUtils.js'],
  },
  build: { rollupOptions: { input: { ui: 'ui.html', output: 'output.html' } } },
});
