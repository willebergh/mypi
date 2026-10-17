import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

/** Kitty functional key codes for left/right modifiers and ISO level shifts. */
export function isModifierOnlyEvent(data: string): boolean {
  const match = /^\x1b\[(\d+)(?=[:;u])[^\x1b]*u$/.exec(data);
  if (!match) return false;
  const code = Number(match[1]);
  return code >= 57441 && code <= 57454;
}

/** Passes the first Space straight to the editor; a one-second hold starts dictation. */
export function createSpaceHold(actions: {
  start(): void;
  stop(): void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let down = false;
  let triggered = false;

  function reset() {
    clearTimeout(timer);
    timer = undefined;
    down = false;
    triggered = false;
  }

  return {
    input(data: string): { consume: true } | undefined {
      if (isModifierOnlyEvent(data)) return { consume: true };
      const release = isKeyRelease(data);
      if (!matchesKey(data, "space")) {
        // Further typing cancels the hold, not the already-inserted space.
        if (down && !triggered && !release) reset();
        return undefined;
      }
      if (release) {
        if (!down) return { consume: true };
        const held = triggered;
        reset();
        if (held) actions.stop();
      } else if (!down && !isKeyRepeat(data)) {
        down = true;
        timer = setTimeout(() => {
          timer = undefined;
          triggered = true;
          actions.start();
        }, 1_000);
        // Native insertion also takes Pi's normal immediate-render path.
        return undefined;
      }
      return { consume: true };
    },
    cancel: reset,
  };
}
