import type { LiveHudState } from '../shared/live-protocol';
import './SessionList.css';

/** Read-only overview; selecting a card cannot switch voice, sharing or presentation. */
export default function SessionList({ state }: { state: LiveHudState }) {
  const sessions = state.mode === 'live' && state.connection === 'live' ? state.multisession?.sessions : undefined;
  if (!sessions) return null;
  return <section className="pi-sessions" aria-label="Shared Pi sessions">
    <h2>Shared Pi sessions <span>{sessions.length}</span></h2>
    <ul>{sessions.map(row => <li key={row.instanceId} data-active={row.isActive}>
      <div className="pi-session-heading"><strong>{row.name || 'Unnamed Pi session'}</strong>
        {row.isMain && <span>Main</span>}{row.isActive && <span>Conversation</span>}</div>
      <code>{row.cwd}</code>
      <p>{row.snapshot ? <>{row.snapshot.session.status} · {row.snapshot.session.model}
        {row.snapshot.context.percent !== null && <> · {Math.round(row.snapshot.context.percent)}% context</>}
        {' · '}{row.snapshot.agents.length} agents · {row.snapshot.todoCounts?.pending ?? row.snapshot.todos.filter(t => !t.completed).length} pending todos</>
        : 'Snapshot unavailable'}</p>
    </li>)}</ul>
  </section>;
}
