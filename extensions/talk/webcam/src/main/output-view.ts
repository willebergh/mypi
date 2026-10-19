import { validateCameraPose, validateOutputViewRequest, type CameraPose, type OutputViewRequest, type OutputViewState } from '../shared/output-view.ts';

/** Framing only: does not create a renderer, change audio, or touch camera transport. */
export class OutputView {
  private state: OutputViewState = { mode: 'hero', pose: null, revision: 0 };
  private readonly publish: (state: OutputViewState, includeEditor: boolean) => void;
  constructor(publish: (state: OutputViewState, includeEditor: boolean) => void) { this.publish = publish; }
  get(): OutputViewState { return this.state; }
  /** Bootstrap before any renderer exists; revisions remain runtime-only. */
  restore(value: OutputViewRequest): void {
    const request = validateOutputViewRequest(value);
    this.state = { mode: request.mode, pose: request.pose ?? null, revision: 0 };
  }
  preferences(): OutputViewRequest {
    return validateOutputViewRequest(this.state);
  }
  set(value: unknown): OutputViewState {
    const request = validateOutputViewRequest(value);
    this.state = { mode: request.mode, pose: request.pose ?? null, revision: this.state.revision + 1 };
    this.publish(this.state, true);
    return this.state;
  }
  editorPose(value: unknown): CameraPose {
    const pose = validateCameraPose(value);
    if (this.state.mode === 'follow-editor') {
      this.state = { ...this.state, pose, revision: this.state.revision + 1 };
      this.publish(this.state, false);
    }
    return pose;
  }
}
