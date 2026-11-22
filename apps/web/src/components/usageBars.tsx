export function RefreshIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: 'middle', transformOrigin: 'center' }}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function resetTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const isSameDay = d.toDateString() === now.toDateString();
  return isSameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Date-only reset for monthly cycles (Kiro `YYYY-MM-DD` is parsed as UTC midnight). */
export function resetDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function fmtCredits(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function fmtMoney(amount: number, currency?: string): string {
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return `${sym}${amount.toFixed(2)}`;
}

export function fmtPct(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

export function ago(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export function Bar({ ratio, color, allowance, reverse }: { ratio: number; color: string; allowance?: boolean; reverse?: boolean }) {
  const w = Math.min(100, Math.max(0, ratio * 100));
  // `allowance` and `reverse` both use a scaled gradient so the full green→red
  // range always maps to 0–100% of the track, revealing more colour as it fills.
  // `reverse` flips the stops (red→green) so high values are rewarded with green.
  const useGradient = (allowance || reverse) && ratio > 0;
  const stops = reverse
    ? 'hsl(0,75%,50%), hsl(40,90%,50%), hsl(120,65%,42%)'
    : 'hsl(120,65%,42%), hsl(40,90%,50%), hsl(0,75%,50%)';
  const fillStyle = useGradient
    ? {
        width: `${w}%`,
        background: `linear-gradient(to right, ${stops})`,
        backgroundSize: `${(1 / Math.min(ratio, 1)) * 100}%`,
        backgroundRepeat: 'no-repeat' as const,
      }
    : { width: `${w}%`, background: color };
  return (
    <div className="usage-bar-track">
      <div className="usage-bar-fill" style={fillStyle} />
    </div>
  );
}

export function AllowanceRows(props: {
  fiveHourPct?: number;
  fiveHourResetsAt?: number;
  sevenDayPct?: number;
  sevenDayResetsAt?: number;
  monthlyPct?: number;
  monthlyResetsAt?: number;
  creditsUsed?: number;
  creditsLimit?: number;
  prepaidBalance?: number;
  onDemandUsed?: number;
  onDemandCap?: number;
  extraUsageUsed?: number;
  extraUsageLimit?: number;
  extraUsagePct?: number;
  extraUsageCurrency?: string;
  manualResetsAvailable?: number;
  creditsBalance?: number;
  hasCredits?: boolean;
  unlimitedCredits?: boolean;
  longWindowLabel?: string;  // default '7d window used'
  monthlyWindowLabel?: string;  // default 'monthly credits used'
}): JSX.Element | null {
  const {
    fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt,
    monthlyPct, monthlyResetsAt, creditsUsed, creditsLimit,
    prepaidBalance, onDemandUsed, onDemandCap,
    extraUsageUsed, extraUsageLimit, extraUsagePct, extraUsageCurrency,
    manualResetsAvailable, creditsBalance, hasCredits, unlimitedCredits,
  } = props;
  if (
    fiveHourPct === undefined && fiveHourResetsAt === undefined
    && sevenDayPct === undefined && sevenDayResetsAt === undefined
    && monthlyPct === undefined && monthlyResetsAt === undefined
    && creditsUsed === undefined && creditsLimit === undefined
    && prepaidBalance === undefined && onDemandUsed === undefined
    && onDemandCap === undefined
    && extraUsageUsed === undefined && extraUsageLimit === undefined
    && extraUsagePct === undefined
    && manualResetsAvailable === undefined
    && creditsBalance === undefined
    && hasCredits === undefined
    && unlimitedCredits === undefined
  ) {
    return null;
  }

  const longLabel = props.longWindowLabel ?? '7d window used';
  const monthlyLabel = props.monthlyWindowLabel ?? 'monthly credits used';
  const hasFive = fiveHourPct !== undefined || fiveHourResetsAt !== undefined;
  const hasLong = sevenDayPct !== undefined || sevenDayResetsAt !== undefined;
  const hasMonthly = monthlyPct !== undefined || monthlyResetsAt !== undefined
    || creditsUsed !== undefined || creditsLimit !== undefined;
  const hasMonetary = prepaidBalance !== undefined || onDemandUsed !== undefined || onDemandCap !== undefined;
  const hasExtraUsage = extraUsageUsed !== undefined || extraUsageLimit !== undefined || extraUsagePct !== undefined;
  const pctClass = (n: number | undefined) =>
    n !== undefined && n >= 80 ? 'accent-red' : n !== undefined && n >= 50 ? 'accent-amber' : 'accent-dim';

  return (
    <div className="usage-rows">
      {hasFive && (
        <>
          <div className="usage-row">
            <span className="usage-row-label">5h window used</span>
            <span className={`usage-row-value ${pctClass(fiveHourPct)}`}>
              {fiveHourPct !== undefined ? `${Math.round(fiveHourPct)}%` : '—'}
            </span>
          </div>
          {fiveHourPct !== undefined && (
            <Bar ratio={fiveHourPct / 100} color="" allowance />
          )}
          {fiveHourResetsAt && (
            <div className="usage-row">
              <span className="usage-row-label">resets</span>
              <span className="usage-row-value">{resetTime(fiveHourResetsAt)}</span>
            </div>
          )}
        </>
      )}
      {hasFive && hasLong && (
        <div className="usage-sep" />
      )}
      {hasLong && (
        <>
          <div className="usage-row">
            <span className="usage-row-label">{longLabel}</span>
            <span className={`usage-row-value ${pctClass(sevenDayPct)}`}>
              {sevenDayPct !== undefined ? `${Math.round(sevenDayPct)}%` : '—'}
            </span>
          </div>
          {sevenDayPct !== undefined && (
            <Bar ratio={sevenDayPct / 100} color="" allowance />
          )}
          {sevenDayResetsAt && (
            <div className="usage-row">
              <span className="usage-row-label">resets</span>
              <span className="usage-row-value">{resetTime(sevenDayResetsAt)}</span>
            </div>
          )}
        </>
      )}
      {(hasFive || hasLong) && hasMonthly && (
        <div className="usage-sep" />
      )}
      {hasMonthly && (
        <>
          <div className="usage-row">
            <span className="usage-row-label">{monthlyLabel}</span>
            <span className={`usage-row-value ${pctClass(monthlyPct)}`}>
              {monthlyPct !== undefined ? fmtPct(monthlyPct) : '—'}
            </span>
          </div>
          {monthlyPct !== undefined && (
            <Bar ratio={monthlyPct / 100} color="" allowance />
          )}
          {creditsUsed !== undefined && creditsLimit !== undefined && (
            <div className="usage-row">
              <span className="usage-row-label">credits</span>
              <span className="usage-row-value">{fmtCredits(creditsUsed)} of {fmtCredits(creditsLimit)}</span>
            </div>
          )}
          {monthlyResetsAt && (
            <div className="usage-row">
              <span className="usage-row-label">resets</span>
              <span className="usage-row-value">{resetDate(monthlyResetsAt)}</span>
            </div>
          )}
        </>
      )}
      {(hasFive || hasLong || hasMonthly) && hasMonetary && (
        <div className="usage-sep" />
      )}
      {hasMonetary && (
        <>
          {prepaidBalance !== undefined && (
            <div className="usage-row">
              <span className="usage-row-label">prepaid balance</span>
              <span className="usage-row-value">{fmtUsd(prepaidBalance)}</span>
            </div>
          )}
          {onDemandUsed !== undefined && (
            <div className="usage-row">
              <span className="usage-row-label">on-demand used</span>
              <span className="usage-row-value">{fmtUsd(onDemandUsed)}</span>
            </div>
          )}
          {onDemandCap !== undefined && (
            <div className="usage-row">
              <span className="usage-row-label">on-demand limit</span>
              <span className="usage-row-value">{fmtUsd(onDemandCap)}</span>
            </div>
          )}
        </>
      )}
      {(hasFive || hasLong || hasMonthly || hasMonetary) && hasExtraUsage && (
        <div className="usage-sep" />
      )}
      {hasExtraUsage && (
        <>
          <div className="usage-row">
            <span className="usage-row-label">extra usage</span>
            <span className={`usage-row-value ${pctClass(extraUsagePct ?? (extraUsageLimit && extraUsageUsed !== undefined ? (extraUsageUsed / extraUsageLimit) * 100 : undefined))}`}>
              {extraUsageUsed !== undefined && extraUsageLimit !== undefined
                ? `${fmtMoney(extraUsageUsed, extraUsageCurrency)} / ${fmtMoney(extraUsageLimit, extraUsageCurrency)}`
                : extraUsageUsed !== undefined
                  ? fmtMoney(extraUsageUsed, extraUsageCurrency)
                  : '—'}
            </span>
          </div>
          {(extraUsagePct !== undefined || (extraUsageUsed !== undefined && extraUsageLimit !== undefined && extraUsageLimit > 0)) && (
            <Bar
              ratio={(extraUsagePct !== undefined ? extraUsagePct : (extraUsageUsed! / extraUsageLimit!) * 100) / 100}
              color=""
              allowance
            />
          )}
        </>
      )}
      {(hasFive || hasLong || hasMonthly || hasMonetary || hasExtraUsage) && (creditsBalance !== undefined || hasCredits !== undefined || unlimitedCredits !== undefined || manualResetsAvailable !== undefined) && (
        <div className="usage-sep" />
      )}
      {(creditsBalance !== undefined || hasCredits !== undefined || unlimitedCredits !== undefined) && (
        <div className="usage-row">
          <span className="usage-row-label">credits</span>
          <span className="usage-row-value">
            {unlimitedCredits ? 'Unlimited' : creditsBalance !== undefined ? fmtUsd(creditsBalance) : hasCredits ? 'Available' : 'None'}
          </span>
        </div>
      )}
      {manualResetsAvailable !== undefined && (
        <div className="usage-row">
          <span className="usage-row-label">manual resets</span>
          <span className="usage-row-value">
            {manualResetsAvailable} available
          </span>
        </div>
      )}
    </div>
  );
}
