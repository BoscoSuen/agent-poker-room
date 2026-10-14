import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles.css';
import { Home } from './pages/Home';
import { Game } from './pages/Game';

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}
export function navigate(to: string) { history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')); }

function App() {
  const path = usePath();
  const m = path.match(/^\/g\/([a-z0-9]+)/i);
  if (m) return <Game id={m[1]} />;
  return <Home />;
}
render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
