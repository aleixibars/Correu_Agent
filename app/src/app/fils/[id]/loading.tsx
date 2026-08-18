import Link from "next/link";
import { AppHeaderSkeleton } from "../../../components/AppHeaderSkeleton";
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
      <AppHeaderSkeleton active={THREADS_PATH} />
      {/* The list needs no query, so a slow thread never traps the reader. */}
      <p>
        <Link href={THREADS_PATH}>← Torna als fils</Link>
      </p>
      {/* The blocks below sit where the loaded thread puts them: the subject,
          then the line that will carry its category and status, then the mail
          and the draft. */}
      <span className="skeleton skeleton--title" aria-hidden="true" />
      <p className="meta" aria-live="polite">
        Carregant el fil…
      </p>
      <div aria-hidden="true">
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
