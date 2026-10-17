import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

/** Kitty functional key codes for left/right modifiers and ISO level shifts. */
export function isModifierOnlyEvent(data: string): boolean {
  const match = /^\x1b\[(\d+)(?=[:;u])[^\x1b]*u$/.exec(data);
  if (!match) return false;
  const code = Number(match[1]);
  return code >= 57441 && code <= 57454;
}

/** Buffers Space until a tap or a one-second hold can be distinguished. */
export function createSpaceHold(actions: {
  start(): void;
  stop(): void;
  tap(): void;
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
        // Don't delay a typed space past the following character.
        if (down && !triggered && !release) {
          actions.tap();
          reset();
        }
        return undefined;
      }
      if (release) {
        if (!down) return { consume: true };
        const held = triggered;
        reset();
        if (held) actions.stop();
        else actions.tap();
      } else if (!down && !isKeyRepeat(data)) {
        down = true;
        timer = setTimeout(() => {
          timer = undefined;
          triggered = true;
          actions.start();
        }, 1_000);
      }
      return { consume: true };
    },
    cancel: reset,
  };
}
