import { useEffect, useRef, type ReactNode } from 'react';
import classes from './assignment.module.css';

/**
 * The grading column's wrapper (see .stickyPanel). On large screens it sticks below the header and scrolls on its
 * own, so the Save buttons pinned to its bottom stay on screen. Before the page is scrolled far enough for it to
 * stick, it starts lower down; --sticky-panel-top tells the CSS where, so the panel ends at the bottom of the window
 * then too.
 */
export function StickyPanel({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (getComputedStyle(el).position !== 'sticky') return; // below the lg breakpoint
      el.style.setProperty('--sticky-panel-top', `${Math.round(el.getBoundingClientRect().top)}px`);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      el.style.removeProperty('--sticky-panel-top');
    };
  }, [enabled]);

  return (
    <div ref={ref} className={enabled ? classes.stickyPanel : undefined}>
      {children}
    </div>
  );
}
