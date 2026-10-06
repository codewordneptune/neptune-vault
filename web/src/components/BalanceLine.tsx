// The balance over the last 30 days as a quiet line on Home's balance card
// (app/balanceLine.ts). Drawn for the eye; a screen reader is told where
// it started and where it is now.

import { useId } from 'react';

const W = 300;
const H = 44;
const PAD = 3;

export function BalanceLine({ points, from, to }: { points: number[]; from: string; to: string }) {
  const gradient = 'vault-line-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const x = (i: number) => ((i / (points.length - 1)) * W).toFixed(1);
  const y = (v: number) => (PAD + (1 - (v - min) / span) * (H - 2 * PAD)).toFixed(1);
  const line = points.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ');
  return (
    <div className="vault-balance-line">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`url(#${gradient})`} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="vault-balance-line-cap" aria-hidden>
        <span>30 days ago</span>
        <span>Today</span>
      </div>
      <span className="sr-only">
        Over the last 30 days the balance went from {from} to {to} NPT.
      </span>
    </div>
  );
}
