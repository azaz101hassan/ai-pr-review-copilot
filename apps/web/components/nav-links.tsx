'use client';

// Client subcomponent of NavShell: uses usePathname() to highlight the
// active route. Kept separate so NavShell stays a Server Component.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { label: 'Analytics', href: '/' },
  { label: 'Reviews', href: '/reviews' },
  { label: 'Settings', href: '/settings' },
] as const;

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {NAV_ITEMS.map(({ label, href }) => {
        const isActive =
          href === '/' ? pathname === '/' : pathname.startsWith(href);

        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
