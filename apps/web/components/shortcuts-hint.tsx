'use client';

// Tiny discoverability affordance in the top nav: shows the operator
// that the `?` keyboard layer exists and opens the overlay when
// clicked. Reads as a label first, button second — the kbd glyph is
// the lede and the button chrome is invisible at rest.
//
// Dispatches a window event that <KeyboardShortcuts /> listens for,
// rather than sharing state through context. The two components don't
// have a common React ancestor below the Server-rendered NavShell.

import { SHORTCUTS_OPEN_EVENT } from '@/components/keyboard-shortcuts';

export function ShortcutsHint() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(SHORTCUTS_OPEN_EVENT))}
      className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background md:inline-flex"
      aria-label="Show keyboard shortcuts"
    >
      <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[11px] font-medium text-foreground">
        ?
      </kbd>
      <span>shortcuts</span>
    </button>
  );
}
