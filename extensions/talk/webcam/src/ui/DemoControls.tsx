import { useEffect, useRef, useState } from 'react';
import { DEMO_CONTEXT_WINDOW, DEMO_HUD_VERSION, DEMO_MAX_AGENTS, DEMO_MAX_TODOS,
  demoAgentTerminal, type DemoHudAction } from '../shared/demo-hud';
import type { LiveHudState } from '../shared/live-protocol';
import { Slider } from './SettingControls';

/** Read the same main-owned snapshot as both scene consumers. No local fake HUD. */
export default function DemoControls({ liveHud }: { liveHud: LiveHudState }) {
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const demo = liveHud.demo;
  const selected = liveHud.mode === 'demo';
  // A newly HMR'd renderer can have an old preload OR a new preload with old main.
  // Require both the method and main's versioned snapshot before invoking IPC.
  const supported = typeof window.webcam?.updateDemoHud === 'function' && demo?.version === DEMO_HUD_VERSION;
  const enabled = selected && supported;
  async function send(action: DemoHudAction) {
    if (!enabled) return;
    setError('');
    try { await window.webcam.updateDemoHud!(action); }
    catch (failure) {
      if (mounted.current) setError(String(failure).includes('No handler')
        ? 'Backend restart required: load updated Electron main/preload later.'
        : 'Demo update was not applied. Confirm Demo is still selected; backend restart may be required.');
    }
    // Only the shared subscription updates the controls/preview/output, not this reply.
  }
  const command = (type: 'reset' | 'agent-add' | 'agents-clear' | 'todo-add' | 'todos-clear') => void send({ version: 1, type });
  const rowCommand = (type: 'agent-reopen' | 'agent-remove' | 'agent-up' | 'todo-toggle' | 'todo-remove', id: number) => void send({ version: 1, type, id });
  return <fieldset className="hud-settings demo-controls"><legend>Demo / not live Pi data</legend>
    <p className="panel-note">Authored fictional agents and tasks only. No Pi mutations, tools, calls or simulated audio. Preview and Output share this data.</p>
    {!selected && <p className="panel-note">Select Telemetry source → Demo to edit fixtures. Live remains read-only.</p>}
    {selected && !supported && <p className="compatibility-note" role="status">Backend restart required: load updated Electron main/preload later to enable shared Demo controls. Controls have not been applied.</p>}
    {error && <p className="compatibility-note" role="alert">{error}</p>}
    <fieldset className="demo-editors" disabled={!enabled}>
      <div className="demo-actions"><button onClick={() => command('reset')}>Reset demo</button>
        <label className="hud-toggle"><input type="checkbox" checked={demo?.offline ?? false} onChange={event => void send({ version: 1, type: 'offline', value: event.target.checked })} />Demo offline</label></div>
      <Slider id="demo-main-context" label="Main context" min={0} max={100} step={1} unit="%" value={demo?.mainContextPercent ?? 0}
        onChange={percent => void send({ version: 1, type: 'main-context', percent })} />
      <p className="panel-note">{(DEMO_CONTEXT_WINDOW * (demo?.mainContextPercent ?? 0) / 100).toLocaleString()} / {DEMO_CONTEXT_WINDOW.toLocaleString()} tokens · fixed fictional window</p>
      <Slider id="demo-weekly" label="Weekly used" min={0} max={100} step={1} unit="%" value={demo?.weeklyUsedPercent ?? 0}
        onChange={percent => void send({ version: 1, type: 'weekly', percent })} />
      <details open><summary>Subagents · {demo?.agents.length ?? 0}/{DEMO_MAX_AGENTS}</summary>
        <p className="panel-note">Complete publishes a final outcome, then removes it after 3 seconds. Reopen starts a new ID. Remove/Empty is not success. Move up tests reordering; HUD still caps visible rows.</p>
        <div className="demo-actions"><button disabled={(demo?.agents.length ?? 0) >= DEMO_MAX_AGENTS} onClick={() => command('agent-add')}>Add agent</button><button onClick={() => command('agents-clear')}>Empty agents</button></div>
        <div className="demo-rows">{demo?.agents.map((agent, index) => {
          const terminal = demoAgentTerminal(agent.status);
          return <div className="demo-row" key={agent.id}>
            <strong>#{agent.id} {agent.label}</strong><span className="panel-note">{agent.model} · {agent.status}</span>
            <Slider id={`demo-agent-${agent.id}`} label="Context" min={0} max={100} step={1} unit="%" disabled={terminal}
              value={agent.contextPercent} onChange={percent => void send({ version: 1, type: 'agent-context', id: agent.id, percent })} />
            <span className="panel-note">{(DEMO_CONTEXT_WINDOW * agent.contextPercent / 100).toLocaleString()} / {DEMO_CONTEXT_WINDOW.toLocaleString()} tokens</span>
            <div className="demo-actions">
              {!terminal && <select aria-label={`Demo agent ${agent.id} status`} value={agent.status}
                onChange={event => void send({ version: 1, type: 'agent-status', id: agent.id, status: event.target.value as 'queued' | 'starting' | 'thinking' | 'running' })}>
                <option value="queued">Queued</option><option value="starting">Starting</option><option value="thinking">Thinking</option><option value="running">Running</option>
              </select>}
              {terminal ? <button onClick={() => rowCommand('agent-reopen', agent.id)}>Reopen</button>
                : <button onClick={() => void send({ version: 1, type: 'agent-status', id: agent.id, status: 'completed' })}>Complete</button>}
              <button disabled={index === 0} aria-label={`Move demo agent ${agent.id} up`} onClick={() => rowCommand('agent-up', agent.id)}>↑ Up</button>
              <button onClick={() => rowCommand('agent-remove', agent.id)}>Remove</button>
            </div>
          </div>;
        })}</div>
        {demo?.agents.length === 0 && <p className="panel-note">No demo agents.</p>}
      </details>
      <details open><summary>Todos · {demo?.todos.filter(todo => todo.completed).length ?? 0}/{demo?.todos.length ?? 0} done</summary>
        <p className="panel-note">Ascending numeric IDs; pending work first, at most one completed HUD row. Full counts include all fixture tasks. No in-progress metadata.</p>
        <div className="demo-actions"><button disabled={(demo?.todos.length ?? 0) >= DEMO_MAX_TODOS} onClick={() => command('todo-add')}>Add todo</button><button onClick={() => command('todos-clear')}>Empty todos</button></div>
        <div className="demo-rows">{demo?.todos.map(todo => <div className="demo-row" key={todo.id}>
          <span>#{todo.id} {todo.text} {todo.completed ? '· done' : '· pending'}</span>
          <div className="demo-actions"><button onClick={() => rowCommand('todo-toggle', todo.id)}>{todo.completed ? 'Reopen' : 'Complete'}</button><button onClick={() => rowCommand('todo-remove', todo.id)}>Remove</button></div>
        </div>)}</div>
        {demo?.todos.length === 0 && <p className="panel-note">No demo todos.</p>}
      </details>
    </fieldset>
  </fieldset>;
}
