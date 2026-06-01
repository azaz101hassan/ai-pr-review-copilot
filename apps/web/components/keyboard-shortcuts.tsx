'use client';

// Global keyboard shortcut layer. Mounts once in NavShell.
//
// Layered on top of native focus and link behavior; nothing here replaces
// the underlying affordance. Enter on a focused row is just the anchor's
// default activation; j/k just calls .focus() on the next/previous anchor.
//
// Typing into a form control suppresses all single-letter shortcuts so
// the user can type "j" or "g" into a filter input without being teleported.
// Esc inside a form control blurs back to the page so the next j/k works.
//
// The single-key shortcuts (/, ?, j, k) and the two-key g-sequences
// (g a, g r) mirror GitHub's PR-page conventions; an operator who lives
// in PR review threads already has the muscle memory.

import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';

const FILTER_SELECTOR =
  '[aria-label="Filter controls"] :is(select, input):not([type="hidden"])';
const ROW_SELECTOR = '[data-keynav-list] a[href]';
const G_SEQUENCE_MS = 1000;
// Public custom-event name used by the in-nav discoverability button to
// open the overlay without re-implementing the keyboard handler. Kept
// on `window` so a Server-rendered button can fire it without sharing
// component state.
export const SHORTCUTS_OPEN_EVENT = 'pr-copilot:open-shortcuts';

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function focusFirstFilter(): boolean {
  const el = document.querySelector<HTMLElement>(FILTER_SELECTOR);
  if (!el) return false;
  el.focus();
  if (el instanceof HTMLInputElement) el.select();
  return true;
}

function focusRowDelta(delta: 1 | -1): boolean {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>(ROW_SELECTOR),
  );
  if (rows.length === 0) return false;
  const active = document.activeElement;
  const index = active instanceof HTMLElement ? rows.indexOf(active) : -1;
  if (index === -1) {
    rows[0]?.focus();
    return true;
  }
  const next = Math.max(0, Math.min(rows.length - 1, index + delta));
  rows[next]?.focus();
  return true;
}

interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Sync controlled state into the native dialog element.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Native dialog dispatches 'close' on Esc, backdrop click handlers, or
  // explicit close() calls. Forward all of those into React state.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => onClose();
    dialog.addEventListener('close', handler);
    return () => dialog.removeEventListener('close', handler);
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      onClick={(e) => {
        // Close when the user clicks outside the inner panel.
        if (e.target === e.currentTarget) onClose();
      }}
      className="rounded-lg border border-border bg-card p-0 text-card-foreground shadow-none backdrop:bg-black/50"
      aria-labelledby="shortcuts-title"
    >
      <div className="w-80 p-6">
        <h2
          id="shortcuts-title"
          className="mb-4 text-sm font-semibold text-foreground"
        >
          Keyboard shortcuts
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <Kbd>/</Kbd>
          <dd className="text-muted-foreground">Focus the filter bar</dd>
          <Kbd>j</Kbd>
          <dd className="text-muted-foreground">Next review in the list</dd>
          <Kbd>k</Kbd>
          <dd className="text-muted-foreground">Previous review in the list</dd>
          <Kbd>Enter</Kbd>
          <dd className="text-muted-foreground">Open the focused review</dd>
          <Kbd>g a</Kbd>
          <dd className="text-muted-foreground">Go to analytics</dd>
          <Kbd>g r</Kbd>
          <dd className="text-muted-foreground">Go to reviews</dd>
          <Kbd>Esc</Kbd>
          <dd className="text-muted-foreground">Close this dialog or unfocus</dd>
          <Kbd>?</Kbd>
          <dd className="text-muted-foreground">Show this dialog</dd>
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">
          Two-key sequences (<span className="font-mono">g a</span>,{' '}
          <span className="font-mono">g r</span>) must be pressed within one
          second.
        </p>
      </div>
    </dialog>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <dt>
      <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] font-medium text-foreground">
        {children}
      </kbd>
    </dt>
  );
}

export function KeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const [overlayOpen, setOverlayOpen] = useState(false);

  // Two-key g-sequence state; ref because we only need the latest value
  // inside the keydown listener and changing it mustn't re-run the effect.
  const pendingGRef = useRef<{ at: number } | null>(null);

  // Close overlay on route change so it never persists across navigations.
  useEffect(() => {
    setOverlayOpen(false);
  }, [pathname]);

  // Listen for a programmatic open request from the nav button. This is a
  // window event rather than a context provider because the trigger and
  // the dialog don't share an ancestor in a way that survives the Server
  // Component boundary.
  useEffect(() => {
    function onOpen() {
      setOverlayOpen(true);
    }
    window.addEventListener(SHORTCUTS_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SHORTCUTS_OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Bail entirely on modifier-key combos; those belong to the browser
      // (Cmd-K, Ctrl-R, etc.) and the shortcut layer must not collide.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const typing = isTypingTarget(e.target);

      // Esc inside an input blurs back to the page so the next j/k works.
      if (e.key === 'Escape' && typing && e.target instanceof HTMLElement) {
        e.target.blur();
        return;
      }

      // All other shortcuts are suppressed while typing.
      if (typing) return;

      // '?' (shift + /) opens the overlay.
      if (e.key === '?') {
        e.preventDefault();
        setOverlayOpen(true);
        return;
      }

      // '/' focuses the first filter control.
      if (e.key === '/') {
        if (focusFirstFilter()) e.preventDefault();
        return;
      }

      // Two-key g-sequence: 'g' arms, 'a' / 'r' commits within the window.
      if (pendingGRef.current && Date.now() - pendingGRef.current.at < G_SEQUENCE_MS) {
        if (e.key === 'a') {
          e.preventDefault();
          pendingGRef.current = null;
          router.push('/');
          return;
        }
        if (e.key === 'r') {
          e.preventDefault();
          pendingGRef.current = null;
          router.push('/reviews');
          return;
        }
        // Any other key cancels the pending g.
        pendingGRef.current = null;
      }

      if (e.key === 'g') {
        pendingGRef.current = { at: Date.now() };
        return;
      }

      // 'j' / 'k' move row focus.
      if (e.key === 'j') {
        if (focusRowDelta(1)) e.preventDefault();
        return;
      }
      if (e.key === 'k') {
        if (focusRowDelta(-1)) e.preventDefault();
        return;
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router]);

  return (
    <ShortcutsOverlay open={overlayOpen} onClose={() => setOverlayOpen(false)} />
  );
}
