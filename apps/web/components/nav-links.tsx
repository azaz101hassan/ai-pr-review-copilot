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
    <nav className="flex items-center gap-6" aria-label="Primary">
      {NAV_ITEMS.map(({ label, href }) => {
        const isActive =
          href === '/' ? pathname === '/' : pathname.startsWith(href);

        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative py-4 text-sm transition-colors',
              isActive
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
            {isActive && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 -bottom-px h-px bg-foreground"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
