import type { TableEvent, Table } from '@pokergarden/engine';

interface Stat { hands: number; vpip: number; pfr: number; riverBets: number; showdowns: number; bluffs: number }

/**
 * Public-information opponent stats, keyed by player name (so they follow a player across seatings, like the Board).
 * Only real showdowns count; the forced reveal of an agent winning uncontested (hand === 'uncontested') is ignored.
 */
export class Reads {
  private stats = new Map<string, Stat>();
  private hand = { vpip: new Set<string>(), pfr: new Set<string>(), riverAgg: new Set<string>() };

  constructor(private table: Table) {}

  private get(name: string): Stat {
    let s = this.stats.get(name);
    if (!s) { s = { hands: 0, vpip: 0, pfr: 0, riverBets: 0, showdowns: 0, bluffs: 0 }; this.stats.set(name, s); }
    return s;
  }
  private name(seat: number) { return this.table.seats[seat]?.player?.name; }

  onEvent(ev: TableEvent) {
    if (ev.type === 'hand_started') {
      this.hand = { vpip: new Set(), pfr: new Set(), riverAgg: new Set() };
      for (const i of ev.seats) { const n = this.name(i); if (n) this.get(n).hands++; }
    } else if (ev.type === 'action') {
      const n = this.name(ev.seat); const street = this.table.hand?.street;
      if (!n || ev.timeout) return;
      const aggro = ev.action === 'bet' || ev.action === 'raise';
      if (street === 'preflop') {
        if ((aggro || ev.action === 'call') && !this.hand.vpip.has(n)) { this.hand.vpip.add(n); this.get(n).vpip++; }
        if (aggro && !this.hand.pfr.has(n)) { this.hand.pfr.add(n); this.get(n).pfr++; }
      } else if (street === 'river' && aggro) {
        this.get(n).riverBets++; this.hand.riverAgg.add(n);
      }
    } else if (ev.type === 'showdown' && ev.hand !== 'uncontested') {
      const n = this.name(ev.seat); if (!n) return;
      const s = this.get(n); s.showdowns++;
      if (this.hand.riverAgg.has(n) && ev.hand === 'High Card') s.bluffs++;
    }
  }

  reset() { this.stats.clear(); }

  /** One line per opponent still in the hand. */
  linesFor(view: { you: number | null; seats: { idx: number; name: string | null; inHand: boolean; folded: boolean }[] }): string {
    const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
    const out: string[] = [];
    for (const s of view.seats) {
      if (s.idx === view.you || !s.name || !s.inHand || s.folded) continue;
      const st = this.stats.get(s.name); if (!st || st.hands === 0) continue;
      out.push(`- ${s.name}: ${st.hands} hands, VPIP ${pct(st.vpip, st.hands)}%, PFR ${pct(st.pfr, st.hands)}%, river bets ${st.riverBets}, bluffs shown ${st.bluffs}/${st.showdowns} showdowns`);
    }
    return out.length ? `Opponent reads (this session, public info):\n${out.join('\n')}` : '';
  }
}
