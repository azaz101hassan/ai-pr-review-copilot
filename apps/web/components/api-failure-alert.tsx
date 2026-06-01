// Server-presentational component: page-level alert for a failed
// dashboard endpoint. Visually distinct from EmptyState so the operator
// can tell "the database is idle" from "the API is unreachable."
//
// Uses the destructive Alert primitive at the top of the page. The
// retry affordance is a plain <a href> reload — Server Components have
// no client state to preserve, so a hard reload is the cheapest way
// back to a healthy fetch.
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface ApiFailureAlertProps {
  /** Endpoint identifier shown to the operator, e.g. `/analytics`. */
  endpoint: string;
  /** Human description of what failed, sentence case. */
  description?: string;
}

export function ApiFailureAlert({ endpoint, description }: ApiFailureAlertProps) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Endpoint unreachable</AlertTitle>
      <AlertDescription className="mt-1 text-muted-foreground">
        <span className="font-mono text-xs text-foreground">{endpoint}</span>
        {description ? ` · ${description}` : null}
        {' · '}
        <a
          href="?retry"
          className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          Retry
        </a>
      </AlertDescription>
    </Alert>
  );
}
