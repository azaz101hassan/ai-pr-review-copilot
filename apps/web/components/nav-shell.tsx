// Server Component layout fragment: persistent top navigation + page slot.
// Active-route highlight is handled by the NavLinks Client subcomponent
// (usePathname() is client-only).
import type { ReactNode } from 'react';
import { NavLinks } from './nav-links';

interface NavShellProps {
  children: ReactNode;
}

export function NavShell({ children }: NavShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-6">
          <a
            href="/"
            className="font-mono text-[13px] font-medium tracking-tight text-foreground"
            aria-label="PR Review Copilot home"
          >
            pr-review-copilot
          </a>
          <NavLinks />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
