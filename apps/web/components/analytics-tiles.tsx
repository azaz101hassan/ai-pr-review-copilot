// Server-presentational component: renders analytics tiles from an
// AnalyticsResponse snapshot. No client hooks; call site owns Suspense.
//
// Tile hierarchy (deliberate, per design principle 4):
//   Primary row  — Volume + Severity rollup. Larger, headline-weight.
//   Secondary row — Latency p50/p95 + Token cost. Calmer, smaller.
//   Supporting list — Top-N rules table. Full-width, below tiles.
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
// Tile components
// ---------------------------------------------------------------------------

interface PrimaryTileProps {
  label: string;
  children: React.ReactNode;
}

function PrimaryTile({ label, children }: PrimaryTileProps) {
  return (
    <Card className="border-border">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

interface SecondaryTileProps {
  label: string;
  value: string;
  unit?: string;
}

function SecondaryTile({ label, value, unit }: SecondaryTileProps) {
  return (
    <Card className="border-border">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-baseline gap-1">
        <p className="font-mono text-2xl font-medium tabular-nums text-foreground">
          {value}
        </p>
        {unit && (
          <span className="text-xs text-muted-foreground">{unit}</span>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Severity breakdown bar
// Proportional segments in error / warning / info order.
// Each segment is labeled so color is not the only signal.
// ---------------------------------------------------------------------------

interface SeverityBarProps {
  error: number;
  warning: number;
  info: number;
}

function SeverityBar({ error, warning, info }: SeverityBarProps) {
  const totalFindings = error + warning + info;

  if (totalFindings === 0) {
    return (
      <p className="font-mono text-4xl font-semibold tabular-nums text-foreground">
        0
      </p>
    );
  }

  const segments: Array<{ count: number; color: string; label: string }> = [
    { count: error, color: 'bg-[var(--severity-error)]', label: 'error' },
    {
      count: warning,
      color: 'bg-[var(--severity-warning)]',
      label: 'warning',
    },
    { count: info, color: 'bg-[var(--severity-info)]', label: 'info' },
  ].filter((s) => s.count > 0);

  return (
    <div className="space-y-3">
      {/* Total count */}
      <p className="font-mono text-4xl font-semibold tabular-nums text-foreground">
        {totalFindings}
      </p>

      {/* Proportional bar */}
      <div
        className="flex h-1.5 overflow-hidden rounded-full bg-border"
        role="img"
        aria-label={`Findings: ${error} error, ${warning} warning, ${info} info`}
      >
        {segments.map(({ count, color, label }) => (
          <span
            key={label}
            className={color}
            style={{ width: `${(count / totalFindings) * 100}%` }}
            aria-hidden="true"
          />
        ))}
      </div>

      {/* Per-severity counts — text labels alongside color */}
      <dl className="flex gap-4 text-xs">
        {error > 0 && (
          <div className="flex items-center gap-1">
            <span
              className="h-1.5 w-1.5 rounded-full bg-[var(--severity-error)]"
              aria-hidden="true"
            />
            <dt className="sr-only">Error</dt>
            <dd className="tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{error}</span>{' '}
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
            <dd className="tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{warning}</span>{' '}
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
            <dd className="tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{info}</span> info
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}`;
  return `${(ms / 1000).toFixed(1)}`;
}

function msUnit(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? 'ms' : 's';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Top-N rules table
// ---------------------------------------------------------------------------

interface TopRulesProps {
  rules: AnalyticsResponse['topRules'];
}

function TopRulesTable({ rules }: TopRulesProps) {
  if (rules.length === 0) return null;

  return (
    <section aria-label="Top rules by finding count">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
  const totalTokens = tokenTotals.input_tokens + tokenTotals.output_tokens;

  return (
    <div className="space-y-8">
      {/* Primary row: volume + severity — readable at a glance */}
      <section
        aria-label="Headline metrics"
        className="grid gap-4 sm:grid-cols-2"
      >
        <PrimaryTile label="Reviews">
          <p className="font-mono text-4xl font-semibold tabular-nums text-foreground">
            {volume}
          </p>
          {(statusBreakdown.completed > 0 || statusBreakdown.failed > 0) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {statusBreakdown.completed} completed
              {statusBreakdown.failed > 0
                ? `, ${statusBreakdown.failed} failed`
                : ''}
              {statusBreakdown.in_progress > 0
                ? `, ${statusBreakdown.in_progress} in progress`
                : ''}
            </p>
          )}
        </PrimaryTile>

        <PrimaryTile label="Findings by severity">
          <SeverityBar
            error={severityRollup.error}
            warning={severityRollup.warning}
            info={severityRollup.info}
          />
        </PrimaryTile>
      </section>

      {/* Secondary row: latency + tokens — reachable but calmer */}
      <section
        aria-label="Performance metrics"
        className="grid gap-4 sm:grid-cols-3"
      >
        <SecondaryTile
          label="Latency p50"
          value={formatMs(latency.p50)}
          unit={msUnit(latency.p50)}
        />
        <SecondaryTile
          label="Latency p95"
          value={formatMs(latency.p95)}
          unit={msUnit(latency.p95)}
        />
        <SecondaryTile
          label="Tokens"
          value={volume > 0 ? formatTokens(totalTokens) : '—'}
        />
      </section>

      {/* Supporting list: top rules */}
      {topRules.length > 0 && <TopRulesTable rules={topRules} />}
    </div>
  );
}
