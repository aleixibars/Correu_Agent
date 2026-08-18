/**
 * Fallback Next renders while the thread list query runs, so the navigation
 * shows the shape of the list instead of a blank page. Static by design: it
 * must not read the session or the database, since that is exactly the work it
 * is standing in for.
 */
export default function ThreadsLoading() {
  return (
    <div className="app-shell">
      <div className="airmail-stripe" />
      {/* The header needs the signed-in address, which is part of what is still
          loading, so here it is only its outline. */}
      <div className="app-header" aria-hidden="true">
        <span className="skeleton skeleton--brand" />
        <span className="skeleton skeleton--pill" />
      </div>
      <h1>Fils</h1>
      <p className="meta" aria-live="polite">
        Carregant els fils…
      </p>
      <table className="thread-table" aria-hidden="true">
        <tbody>
          {/* A handful of rows: enough to read as a list, short enough not to
              promise more threads than the tenant may have. */}
          {[0, 1, 2, 3, 4].map((row) => (
            <tr key={row}>
              <td>
                <span className="skeleton skeleton--medium" />
              </td>
              <td>
                <span className="skeleton skeleton--pill" />
              </td>
              <td>
                <span className="skeleton skeleton--short" />
              </td>
              <td>
                <span className="skeleton skeleton--short" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
