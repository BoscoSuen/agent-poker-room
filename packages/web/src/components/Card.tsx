const SUIT: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
export function Card({ c, big, dim, cls, style }: { c: string | null; big?: boolean; dim?: boolean; cls?: string; style?: Record<string, string> }) {
  if (!c) return <div class={`cardf back ${big ? 'big' : ''} ${dim ? 'dim' : ''}`} style={style} />;
  const r = c[0] === 'T' ? '10' : c[0];
  return <div class={`cardf s-${c[1]} ${big ? 'big' : ''} ${dim ? 'dim' : ''} ${cls ?? ''}`} style={style}><span>{r}</span><span class="s">{SUIT[c[1]]}</span></div>;
}
