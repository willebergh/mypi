import type { FaceTimeVoiceHandle } from "./facetime-mode.ts";

/** Owns a call, not a peer. No FaceTime/hangup or Pi abort/queue operations here. */
export class VoiceReapError extends Error {}

export function createVoiceRouter<Target, Leg, Context = unknown>(options: {
  main: Target;
  signal: AbortSignal;
  timeoutMs: number;
  start(target: Target, signal: AbortSignal, context?: Context): Promise<Leg>;
  close(leg: Leg): Promise<void>;
  gate(leg: Leg, enabled: boolean): void;
  pending(leg: Leg): boolean;
  introduce(leg: Leg, purpose?: string): void;
  notice(leg: Leg, text: string): void;
  changed(target: Target): void;
  expired(): void;
}) {
  const controller = new AbortController();
  let leg: Leg | undefined;
  let target = options.main;
  let enabled = false;
  let ended = false;
  let changing = false;
  let reapFailed = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let transition: Promise<void> = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  let recovery: Promise<void> | undefined;

  async function replace(next: Target, token: number, context?: Context) {
    const previous = leg;
    leg = undefined;
    if (previous) {
      // Reap the old peer completely BEFORE even creating the replacement.
      try { options.gate(previous, false); } catch { /* Closing still reaps the peer. */ }
      try { await options.close(previous); } catch (error) { reapFailed = true; throw error; }
    }
    if (ended || token !== epoch) throw new Error("Voice transfer cancelled or superseded");
    target = next;
    options.changed(next);
    let fresh: Leg;
    try { fresh = await options.start(next, controller.signal, context); }
    catch (error) { if (error instanceof VoiceReapError) reapFailed = true; throw error; }
    if (ended || token !== epoch) { await options.close(fresh); throw new Error("Voice transfer cancelled or superseded"); }
    leg = fresh;
    options.gate(fresh, enabled);
    if (ended || token !== epoch) throw new Error("Voice transfer cancelled or superseded");
  }
  async function transfer(next: Target, notice?: string, context?: Context) {
    if (ended || changing || reapFailed) throw new Error("Voice routing is unavailable or already changing");
    if (leg && options.pending(leg)) throw new Error("Finish the pending questionnaire before transferring");
    if (leg && next === target) return;
    changing = true;
    const token = ++epoch;
    transition = (async () => {
      try {
        await replace(next, token, context);
        if (leg && notice && !ended) options.notice(leg, notice);
      } catch (error) {
        if (!ended && !reapFailed && token === epoch && next !== options.main) {
          await replace(options.main, token, context);
          if (leg && !ended) options.notice(leg, "Destination voice was lost. Returned to main. Submitted work stays in its original Pi session; no task was replayed.");
        }
        throw error;
      } finally { changing = false; }
    })();
    return transition;
  }
  function stop(): Promise<void> {
    if (cleanup) return cleanup;
    ended = true;
    epoch++;
    clearTimeout(timer);
    controller.abort();
    options.signal.removeEventListener("abort", abort);
    cleanup = (async () => {
      await transition.catch(() => {});
      const previous = leg;
      leg = undefined;
      if (previous) await options.close(previous);
      target = options.main;
      options.changed(target);
    })();
    return cleanup;
  }
  const abort = () => { void stop(); };
  options.signal.addEventListener("abort", abort, { once: true });
  const handle: FaceTimeVoiceHandle = {
    setAudioEnabled(value) {
      if (ended) throw new Error("The FaceTime voice connection has closed");
      enabled = value;
      if (leg) options.gate(leg, value);
    },
    introduceOutgoingCall(purpose) { if (!ended && leg && enabled && !changing) options.introduce(leg, purpose); },
    stop,
  };
  return {
    handle,
    async start() {
      if (options.signal.aborted) { await stop(); throw new Error("FaceTime call cancelled"); }
      changing = true;
      transition = replace(options.main, ++epoch).finally(() => { changing = false; });
      try { await transition; } catch (error) { await stop(); throw error; }
      if (ended) throw new Error("FaceTime call cancelled");
      // This deadline belongs to the call and is never recreated by transfer.
      timer = setTimeout(() => { options.expired(); void stop(); }, options.timeoutMs);
      return handle;
    },
    transfer,
    target: () => target,
    changing: () => changing,
    available: () => !!leg && !ended && !changing,
    recoverable: () => !ended && !reapFailed,
    /** A disconnected destination can disappear during its asynchronous startup. */
    lost(next: Target): Promise<void> {
      if (ended || target !== next || next === options.main) return Promise.resolve();
      if (recovery) return recovery;
      recovery = (async () => {
        await transition.catch(() => {});
        if (ended || target !== next) return;
        await transfer(options.main, "Destination disconnected. Returned to main. Submitted work was not cancelled or replayed; check the destination terminal.");
      })().finally(() => { recovery = undefined; });
      return recovery;
    },
  };
}
