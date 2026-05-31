// Rendered by notFound() when the API returns 404 for a review id.
// Renders inside <NavShell> (the root layout), not Next.js's default 404 page.
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function ReviewNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <p className="text-base font-medium text-foreground">
        Review not found.
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        This review may have been deleted, or the ID is incorrect.
      </p>
      <Button variant="outline" size="sm" asChild>
        <Link href="/reviews">Back to reviews</Link>
      </Button>
    </div>
  );
}
