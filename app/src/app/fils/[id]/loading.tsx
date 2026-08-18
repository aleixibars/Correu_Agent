import Link from "next/link";
import { THREADS_PATH } from "../../../lib/auth/config";

/**
 * Fallback Next renders while a thread and its draft are read, so the
 * navigation shows the shape of the screen instead of a blank page. Static by
 * design: it must not read the session or the database, since that is exactly
 * the work it is standing in for.
 */
export default function ThreadLoading() {
  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      {/* The header needs the signed-in address, which is part of what is still
          loading, so here it is only its outline. */}
      <div className="app-header" aria-hidden="true">
        <span className="skeleton skeleton--brand" />
        <span className="skeleton skeleton--pill" />
      </div>
      {/* The list needs no query, so a slow thread never traps the reader. */}
      <p>
        <Link href={THREADS_PATH}>← Torna als fils</Link>
      </p>
      <p className="meta" aria-live="polite">
        Carregant el fil…
      </p>
      <div aria-hidden="true">
        <span className="skeleton skeleton--title" />
        {[0, 1].map((message) => (
          <article key={message} className="message">
            <span className="skeleton skeleton--short" />
            <span className="skeleton skeleton--line" />
            <span className="skeleton skeleton--line" />
            <span className="skeleton skeleton--medium" />
          </article>
        ))}
        <section className="card">
          <span className="skeleton skeleton--short" />
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--medium" />
        </section>
      </div>
    </div>
  );
}
