"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { TRIAGE_CATEGORIES, type TriageCategory } from "@correu-agent/shared";
import type { ThreadListItem } from "../lib/threads/list-threads";
import {
  THREAD_STATUSES,
  threadStatusLabel,
  type ThreadStatus,
} from "../lib/threads/thread-status";
import { categoryLabel } from "../lib/category-labels";
import { subjectLabel } from "../lib/subject-label";
import { threadPath } from "../lib/routes";
import { CategoryStamp } from "./CategoryStamp";

/** El fus horari del negoci (context.md §5): mai el del servidor de Render ni
 * el del navegador de qui mira el tauler. */
const MADRID_TZ = "Europe/Madrid";

// A la taula principal el darrer missatge ja porta la data, no només l'hora
// (context.md §5): és l'única pantalla on el revisor decideix què és vell.
const dateTimeFormat = new Intl.DateTimeFormat("ca-ES", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: MADRID_TZ,
});

type DateFilter = "all" | "today" | "week";

/** El dia del missatge al fus del negoci, com a clau `YYYY-MM-DD` comparable. */
const dayKey = (date: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: MADRID_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

/** Dilluns de la setmana d'una clau de dia, com a clau del mateix format. */
const weekStartKey = (key: string): string => {
  const monday = new Date(`${key}T00:00:00Z`);
  const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
};

const matchesDateFilter = (
  lastMessageAt: Date | null,
  filter: DateFilter,
  now: Date,
): boolean => {
  if (filter === "all") return true;
  // Sense data no pot complir "avui" ni "aquesta setmana".
  if (lastMessageAt === null) return false;
  const key = dayKey(lastMessageAt);
  const todayKey = dayKey(now);
  if (filter === "today") return key === todayKey;
  return weekStartKey(key) === weekStartKey(todayKey);
};

/**
 * La taula de "Pendents i urgents" de la pantalla inicial (context.md §2), amb
 * filtres per categoria, estat i data del darrer missatge — al moment, sense
 * tornar a consultar el servidor: la llista que arriba ja és tot el que hi ha
 * pendent (`actionableThreads`), així que filtrar-la al navegador n'hi ha prou.
 * Component de client perquè els desplegables necessiten estat local; l'acció
 * de descartar segueix sent el Server Action que rep com a prop.
 */
export const PendingThreadsTable = ({
  threads,
  rejectDraft,
}: {
  threads: ThreadListItem[];
  rejectDraft: (formData: FormData) => void;
}) => {
  const [category, setCategory] = useState<TriageCategory | "all">("all");
  const [status, setStatus] = useState<ThreadStatus | "all">("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");

  // Només les opcions que realment surten a la llista: un desplegable amb
  // categories o estats que ara mateix no té ningú pendent no ajuda a filtrar.
  const availableCategories = useMemo(
    () =>
      TRIAGE_CATEGORIES.filter((option) =>
        threads.some((thread) => thread.category === option),
      ),
    [threads],
  );
  const availableStatuses = useMemo(
    () =>
      THREAD_STATUSES.filter((option) =>
        threads.some((thread) => thread.status === option),
      ),
    [threads],
  );

  const filtered = useMemo(() => {
    // Estable durant els re-renders del filtre, en comptes de re-avaluar "ara"
    // a cada fila i arriscar-se que "avui" canviï de resposta a mig filtratge.
    const now = new Date();
    return threads.filter(
      (thread) =>
        (category === "all" || thread.category === category) &&
        (status === "all" || thread.status === status) &&
        matchesDateFilter(thread.lastMessageAt, dateFilter, now),
    );
  }, [threads, category, status, dateFilter]);

  return (
    <>
      <div className="filter-bar">
        <label className="filter-bar__item">
          Categoria
          <select
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as TriageCategory | "all")
            }
          >
            <option value="all">Totes</option>
            {availableCategories.map((option) => (
              <option key={option} value={option}>
                {categoryLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-bar__item">
          Estat
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as ThreadStatus | "all")
            }
          >
            <option value="all">Tots</option>
            {availableStatuses.map((option) => (
              <option key={option} value={option}>
                {threadStatusLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-bar__item">
          Últim missatge
          <select
            value={dateFilter}
            onChange={(event) => setDateFilter(event.target.value as DateFilter)}
          >
            <option value="all">Tot</option>
            <option value="today">Avui</option>
            <option value="week">Aquesta setmana</option>
          </select>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p>Cap fil coincideix amb els filtres.</p>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Fils pendents i urgents"
          tabIndex={0}
        >
          <table className="thread-table">
            <thead>
              <tr>
                <th scope="col">Assumpte</th>
                <th scope="col">Categoria</th>
                <th scope="col">Estat</th>
                <th scope="col">Últim missatge</th>
                <th scope="col">Acció</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ id, subject, category: rowCategory, status: rowStatus, lastMessageAt, draftId }) => (
                <tr key={id}>
                  <td>{subjectLabel(subject)}</td>
                  <td>
                    {rowCategory === null ? (
                      <span className="meta">—</span>
                    ) : (
                      <CategoryStamp category={rowCategory} />
                    )}
                  </td>
                  <td className="status">{threadStatusLabel(rowStatus)}</td>
                  <td className="meta">
                    {lastMessageAt === null ? (
                      "—"
                    ) : (
                      <time dateTime={lastMessageAt.toISOString()}>
                        {dateTimeFormat.format(lastMessageAt)}
                      </time>
                    )}
                  </td>
                  <td>
                    {/* Explicit call to action, not just a link on the
                        subject: aquesta és la fila d'on el revisor actua. */}
                    <div className="row-actions">
                      <Link href={threadPath(id)} className="btn">
                        Respondre
                      </Link>
                      {/* Només quan hi ha un esborrany viu a descartar: una
                          fila urgent sense esborrany encara no en té cap. */}
                      {rowStatus === "draft-pending" && draftId !== null && (
                        <form action={rejectDraft}>
                          <input type="hidden" name="draftId" value={draftId} />
                          <button type="submit" className="btn-ghost">
                            Descarta
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};
