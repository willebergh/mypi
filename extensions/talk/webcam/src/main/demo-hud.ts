import { createDemoHudState, DEMO_TERMINAL_MS, expireDemoAgents, parseDemoHudAction, reduceDemoHud } from '../shared/demo-hud.ts';

/** Main-only, one bounded deadline timer. Live mode cancels it; no polling/mock drift. */
export function createDemoHudController(publish: () => void, clock = Date.now) {
  let state = createDemoHudState(clock()), active = false, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    cancel();
    if (!active || disposed) return;
    const deadlines = state.agents.flatMap(a => a.endedAt === undefined ? [] : [a.endedAt + DEMO_TERMINAL_MS]);
    if (!deadlines.length) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!active || disposed) return;
      const next = expireDemoAgents(state, clock());
      if (next !== state) { state = next; publish(); }
      schedule();
    }, Math.max(1, Math.min(DEMO_TERMINAL_MS, Math.min(...deadlines) - clock())));
  };
  return {
    read: () => state,
    setActive(value: boolean) {
      active = value && !disposed;
      if (active) state = expireDemoAgents(state, clock());
      schedule();
    },
    update(value: unknown) {
      if (!active || disposed) throw new Error('Select Demo telemetry before editing demo data');
      const action = parseDemoHudAction(value);
      // Do not expire here: even immediate consecutive actions must first publish
      // the authoritative terminal outcome before its three-second removal.
      state = reduceDemoHud(state, action, clock());
      schedule(); publish();
    },
    dispose() { disposed = true; active = false; cancel(); },
  };
}
