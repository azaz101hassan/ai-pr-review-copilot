// Server-presentational component: renders analytics in three altitudes.
// No client hooks; call site owns Suspense.
//
// Altitude hierarchy (read top-to-bottom at decreasing scale):
//   Row 1 — Volume + status breakdown (primary: 4xl mono headline, glance-readable)
//   Row 2 — Severity rollup + proportional bar (secondary: 2xl headline)
//   Row 3 — Latency + token cost (tertiary: single muted line)
//   Below  — Top-N rules table (supporting detail, preserved as-is)
//
// The scale step (4xl → 2xl → sm) does the hierarchy work, not card chrome.
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { analyticsVolume, type AnalyticsResponse } from '@/lib/api-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format milliseconds as a human duration string with unit. */
function formatLatency(ms: number | null): string {
  if (ms === null) return 'no data';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format a raw token count with thousands grouping. */
function formatTokenCount(n: number): string {
  return new Intl.NumberFormat('en').format(n);
}

// ---------------------------------------------------------------------------
// Row 1: Volume + status breakdown
// ---------------------------------------------------------------------------

interface VolumeRowProps {
  volume: number;
  completed: number;
  failed: number;
  in_progress: number;
}

function VolumeRow({ volume, completed, failed, in_progress }: VolumeRowProps) {
  return (
    <div>
      {/* Primary headline: glance-readable volume count, mono 4xl */}
      <div className="font-mono text-4xl font-semibold leading-none tabular-nums text-foreground">
        {volume}
      </div>
      {/* Breakdown sits below as a muted ledger, label-led to keep semantics clear */}
      <p className="mt-2 flex flex-wrap items-baseline gap-x-1 text-sm text-muted-foreground">
        <span>reviews</span>
        <span aria-hidden="true">·</span>
        <span>
          <span className="font-mono tabular-nums text-foreground">
            {completed}
          </span>{' '}
          completed
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <span
            className={`font-mono tabular-nums ${failed > 0 ? 'text-[var(--severity-error)]' : 'text-muted-foreground'}`}
          >
            {failed}
          </span>{' '}
          failed
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <span
            className={`font-mono tabular-nums ${in_progress > 0 ? 'text-[var(--severity-warning)]' : 'text-muted-foreground'}`}
          >
            {in_progress}
          </span>{' '}
          in progress
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row 2: Severity rollup + proportional bar
// ---------------------------------------------------------------------------

interface SeverityRowProps {
  error: number;
  warning: number;
  info: number;
}

function SeverityRow({ error, warning, info }: SeverityRowProps) {
  const total = error + warning + info;

  return (
    <div className="space-y-2">
      {/* Secondary headline: total findings, mono 2xl */}
      <div className="font-mono text-2xl font-medium leading-none tabular-nums text-foreground">
        {total}
      </div>
      {/* Breakdown line below the headline */}
      <p className="flex flex-wrap items-baseline gap-x-1 text-sm text-muted-foreground">
        <span>findings</span>
        <span aria-hidden="true">·</span>
        <span>
          <span
            className={`font-mono tabular-nums ${error > 0 ? 'text-[var(--severity-error)]' : 'text-muted-foreground'}`}
          >
            {error}
          </span>{' '}
          error
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <span
            className={`font-mono tabular-nums ${warning > 0 ? 'text-[var(--severity-warning)]' : 'text-muted-foreground'}`}
          >
            {warning}
          </span>{' '}
          warning
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <span
            className={`font-mono tabular-nums ${info > 0 ? 'text-[var(--severity-info)]' : 'text-muted-foreground'}`}
          >
            {info}
          </span>{' '}
          info
        </span>
      </p>

      {/* Proportional bar — only rendered when there are findings */}
      {total > 0 && (
        <div className="space-y-1.5">
          <div
            className="flex h-1 w-full overflow-hidden rounded-full bg-border"
            role="img"
            aria-label={`Findings: ${error} error, ${warning} warning, ${info} info`}
          >
            {error > 0 && (
              <span
                className="bg-[var(--severity-error)]"
                style={{ width: `${(error / total) * 100}%` }}
                aria-hidden="true"
              />
            )}
            {warning > 0 && (
              <span
                className="bg-[var(--severity-warning)]"
                style={{ width: `${(warning / total) * 100}%` }}
                aria-hidden="true"
              />
            )}
            {info > 0 && (
              <span
                className="bg-[var(--severity-info)]"
                style={{ width: `${(info / total) * 100}%` }}
                aria-hidden="true"
              />
            )}
          </div>

          {/* Dot legend — color + text label, never color alone */}
          <dl className="flex flex-wrap gap-x-4 gap-y-1">
            {error > 0 && (
              <div className="flex items-center gap-1">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-[var(--severity-error)]"
                  aria-hidden="true"
                />
                <dt className="sr-only">Error</dt>
                <dd className="text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums text-foreground">
                    {error}
                  </span>{' '}
                  error
                </dd>
              </div>
            )}
            {warning > 0 && (
              <div className="flex items-center gap-1">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-[var(--severity-warning)]"
                  aria-hidden="true"
                />
                <dt className="sr-only">Warning</dt>
                <dd className="text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums text-foreground">
                    {warning}
                  </span>{' '}
                  warning
                </dd>
              </div>
            )}
            {info > 0 && (
              <div className="flex items-center gap-1">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-[var(--severity-info)]"
                  aria-hidden="true"
                />
                <dt className="sr-only">Info</dt>
                <dd className="text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums text-foreground">
                    {info}
                  </span>{' '}
                  info
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row 3: Latency + token totals
// ---------------------------------------------------------------------------

interface StatsRowProps {
  p50: number | null;
  p95: number | null;
  tokenTotal: number;
}

function StatsRow({ p50, p95, tokenTotal }: StatsRowProps) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-1 text-sm text-muted-foreground">
      <span>Latency p50</span>
      <span className="font-mono tabular-nums text-foreground">
        {formatLatency(p50)}
      </span>
      <span aria-hidden="true">·</span>
      <span>p95</span>
      <span className="font-mono tabular-nums text-foreground">
        {formatLatency(p95)}
      </span>
      <span aria-hidden="true">·</span>
      <span>Tokens</span>
      <span className="font-mono tabular-nums text-foreground">
        {formatTokenCount(tokenTotal)}
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Top-N rules table (preserved — structure and copy unchanged)
// ---------------------------------------------------------------------------

interface TopRulesProps {
  rules: AnalyticsResponse['topRules'];
}

function TopRulesTable({ rules }: TopRulesProps) {
  if (rules.length === 0) return null;

  return (
    <section aria-label="Top rules by finding count">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        Top rules
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            <TableHead className="w-[80px] text-right">Findings</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map(({ rule_id, count }) => (
            <TableRow key={rule_id}>
              <TableCell>
                <span className="font-mono text-xs text-foreground">
                  {rule_id}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {count}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface AnalyticsTilesProps {
  data: AnalyticsResponse;
}

export function AnalyticsTiles({ data }: AnalyticsTilesProps) {
  const { statusBreakdown, severityRollup, latency, tokenTotals, topRules } =
    data;
  const volume = analyticsVolume(data);
  // Sum only the tokens billed at full rate. Anthropic prices cache-read
  // at ~10% of input and cache-write at ~1.25x; folding them into a flat
  // sum inflates the headline number against the operator's real spend.
  // Per-review TokenBreakdown still surfaces the cache splits in context.
  const tokenTotal = tokenTotals.input_tokens + tokenTotals.output_tokens;

  return (
    <div className="space-y-5">
      {/* Row 1: volume + status breakdown */}
      <section aria-label="Review volume and status">
        <VolumeRow
          volume={volume}
          completed={statusBreakdown.completed}
          failed={statusBreakdown.failed}
          in_progress={statusBreakdown.in_progress}
        />
      </section>

      {/* Row 2: severity rollup + proportional bar */}
      <section aria-label="Findings by severity">
        <SeverityRow
          error={severityRollup.error}
          warning={severityRollup.warning}
          info={severityRollup.info}
        />
      </section>

      {/* Row 3: latency + token totals */}
      <section aria-label="Performance metrics">
        <StatsRow
          p50={latency.p50}
          p95={latency.p95}
          tokenTotal={tokenTotal}
        />
      </section>

      {/* Supporting list: top rules */}
      {topRules.length > 0 && (
        <div className="pt-3">
          <TopRulesTable rules={topRules} />
        </div>
      )}
    </div>
  );
}
