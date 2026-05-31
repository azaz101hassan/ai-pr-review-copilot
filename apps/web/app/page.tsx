// Analytics page — Server Component scaffold.
// The full implementation (live SSE tiles, filter bar, analytics data
// fetch) lands in U8. This scaffold sets the tile hierarchy U8 inherits:
//   - Primary row (top, larger): Volume + Severity rollup — the
//     "what's happening" headline; readable at a glance.
//   - Secondary row (smaller): Latency p50 / p95 and token cost —
//     the "how is the bot performing" detail.
//   - Supporting list (full-width, below): Top-N rules — context.
// Uniform 4-up grids are deliberately avoided; the hierarchy IS the UX.
import { EmptyState } from '@/components/empty-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function AnalyticsPage() {
  return (
    <div className="space-y-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Analytics
        </h1>
        <p className="text-sm text-muted-foreground">
          Review pipeline at a glance.
        </p>
      </header>

      <section
        aria-label="Headline metrics"
        className="grid gap-4 sm:grid-cols-2"
      >
        <PrimaryTile label="Reviews" value="—" />
        <PrimaryTile label="Findings by severity" value="—" />
      </section>

      <section
        aria-label="Supporting metrics"
        className="grid gap-4 sm:grid-cols-3"
      >
        <SecondaryTile label="Latency p50" value="—" />
        <SecondaryTile label="Latency p95" value="—" />
        <SecondaryTile label="Tokens" value="—" />
      </section>

      <EmptyState
        title="No reviews yet"
        description={
          <>
            Run <code className="font-mono text-foreground">npm run seed:dev</code>{' '}
            to populate the local store with sample reviews, or open a PR
            against a watched repository.
          </>
        }
      />
    </div>
  );
}

// Headline metric tile. Larger value, more vertical room, designed to read
// from across the desk per the type-led hierarchy.
function PrimaryTile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="border-border">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-mono text-4xl font-semibold tabular-nums tracking-tight text-foreground">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

// Supporting metric tile. Smaller value, calmer surface; reachable but
// secondary to the headline tiles.
function SecondaryTile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="border-border">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-mono text-2xl font-medium tabular-nums text-foreground">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
