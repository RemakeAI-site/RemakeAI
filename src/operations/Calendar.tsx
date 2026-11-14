import { useMemo, useState, type FormEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import { Link } from "react-router-dom";
import { api, useStudio } from "../api";
import { OperationsCover, OperationsEmpty, OperationsHeading, OperationsLoading, OperationsModal, OperationsNotice, errorText } from "./components";
import { addDays, addMonths, calendarBoundary, dateCaption, dateKey, dateTimeInput, monthStart, startOfWeek, timeCaption, zonedInputToISO } from "./dates";
import type { Category, PageData, Publication, Status, StudioSettings } from "./types";

const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const modes = { month: "Месяц", week: "Неделя", list: "Список" } as const;
type Mode = keyof typeof modes;

function Reschedule({ item, day, timezone, onClose }: { item?: Publication; day: string; timezone: string; onClose: () => void }) {
  const [at, setAt] = useState(item?.scheduled_at ? dateTimeInput(item.scheduled_at, timezone) : `${day}T12:00`);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const publications = useStudio<PageData<Publication>>(`/publications?limit=50&q=${encodeURIComponent(search)}`, !item);
  const record = item ?? publications.data?.items.find(entry => entry.id === selection);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!record) return;
    setError("");
    setPending(true);
    try {
      const date = record.scheduled_at && dateTimeInput(record.scheduled_at, timezone) === at
        ? record.scheduled_at
        : zonedInputToISO(at, timezone);
      const status = ["published", "archived"].includes(record.status_id) ? record.status_id : "scheduled";
      await api(`/publications/${record.id}`, { method: "PATCH", body: JSON.stringify({ version: record.version, scheduled_at: date, status_id: status }) });
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  const unschedule = async () => {
    if (!item) return;
    setError("");
    setPending(true);
    try {
      await api(`/publications/${item.id}`, { method: "PATCH", body: JSON.stringify({ version: item.version, scheduled_at: null, status_id: item.status_id === "scheduled" ? "ready" : item.status_id }) });
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <OperationsModal label={item ? "Перенести публикацию" : "Запланировать публикацию"} onClose={() => { if (!pending) onClose(); }}>
      <form className="ops-modal-form" onSubmit={save}>
        <h2>{item ? "Перенести публикацию" : "Запланировать публикацию"}</h2>
        {item ? <p className="muted">{item.title}</p> : <>
          <label className="ops-field">Поиск публикации
            <input type="search" value={search} onChange={event => { setSearch(event.target.value); setSelection(""); }} placeholder="Введите название" autoFocus />
          </label>
          <label className="ops-field">Публикация
            <select required value={selection} onChange={event => setSelection(event.target.value)}>
              <option value="">Выберите публикацию</option>
              {publications.data?.items.map(entry => <option value={entry.id} key={entry.id}>{entry.title}</option>)}
            </select>
          </label>
          {publications.error && <OperationsNotice variant="error">{errorText(publications.error)}</OperationsNotice>}
        </>}
        <label className="ops-field">Дата и время · {timezone}
          <input type="datetime-local" required value={at} onChange={event => setAt(event.target.value)} autoFocus={!!item} />
        </label>
        {error && <OperationsNotice variant="error">{error}</OperationsNotice>}
        <div className="ops-toolbar">
          <button className="btn primary" type="submit" disabled={!record || pending}>{pending ? "Сохраняем…" : "Сохранить"}</button>
          <button className="btn" type="button" disabled={pending} onClick={onClose}>Отмена</button>
          {item && <button className="btn ghost" type="button" disabled={pending} onClick={unschedule}>Снять с плана</button>}
        </div>
      </form>
    </OperationsModal>
  );
}

export function CalendarPage() {
  const settings = useStudio<StudioSettings>("/settings");
  const statuses = useStudio<Status[]>("/statuses");
  const categories = useStudio<Category[]>("/categories");
  const timezone = settings.data?.timezone ?? "Europe/Minsk";
  const today = dateKey(new Date(), timezone);
  const [anchorChoice, setAnchor] = useState<string | null>(null);
  const [selectedChoice, setSelected] = useState<string | null>(null);
  const anchor = anchorChoice ?? today;
  const selected = selectedChoice ?? today;
  const [mode, setMode] = useState<Mode>("month");
  const [editor, setEditor] = useState<Publication | true | null>(null);
  const first = mode === "week" ? startOfWeek(anchor) : mode === "month" ? startOfWeek(monthStart(anchor)) : monthStart(anchor);
  const last = mode === "week" ? addDays(first, 7) : mode === "month" ? addDays(first, 42) : addMonths(anchor, 1);
  const dates = mode === "list" ? [] : Array.from({ length: mode === "month" ? 42 : 7 }, (_, index) => addDays(first, index));
  const from = useMemo(() => calendarBoundary(first, timezone), [first, timezone]);
  const to = useMemo(() => calendarBoundary(last, timezone), [last, timezone]);
  const entries = useStudio<Publication[]>(`/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const grouped = useMemo(() => {
    const result = new Map<string, Publication[]>();
    for (const item of entries.data ?? []) {
      if (!item.scheduled_at) continue;
      const day = dateKey(item.scheduled_at, timezone);
      result.set(day, [...(result.get(day) ?? []), item]);
    }
    return result;
  }, [entries.data, timezone]);
  const statusMap = new Map(statuses.data?.map(item => [item.id, item]));
  const categoryMap = new Map(categories.data?.map(item => [item.id, item]));
  const move = (direction: number) => {
    const next = mode === "week" ? addDays(anchor, direction * 7) : addMonths(anchor, direction);
    setAnchor(next);
    setSelected(next);
  };
  const picked = grouped.get(selected) ?? [];
  const title = dateCaption(anchor, { month: "long", year: "numeric" });
  const eventRows = (items: Publication[]) => items.map(item => {
    const status = statusMap.get(item.status_id);
    const category = item.category_id ? categoryMap.get(item.category_id) : undefined;
    return <div className="ops-row" key={item.id}>
      <div className="ops-row-detail">
        <OperationsCover id={item.cover_media_id ?? item.preview_media_id ?? null} className="ops-cover" fallback={<CalendarDays size={16} />} />
        <div><Link to={`/publications/${item.id}`}><strong>{item.title}</strong></Link>
          <small className="muted">{item.scheduled_at && timeCaption(item.scheduled_at, timezone)}{category && ` · ${category.name}`}{status && ` · ${status.name}`}</small>
        </div>
      </div>
      <button type="button" className="btn" onClick={() => setEditor(item)}>Перенести</button>
    </div>;
  });
  return (
    <div className="page ops-stack">
      <OperationsHeading title="Календарь" description="Планируйте дату и время выпуска и открывайте материалы прямо из контент-плана." actions={<button className="btn primary" type="button" onClick={() => setEditor(true)}><CalendarDays size={17} aria-hidden /> Запланировать</button>} />
      <div className="panel ops-section ops-toolbar">
        <button className="btn" type="button" title="Предыдущий период" aria-label="Предыдущий период" onClick={() => move(-1)}><ChevronLeft size={17} aria-hidden /></button>
        <button className="btn" type="button" title="Следующий период" aria-label="Следующий период" onClick={() => move(1)}><ChevronRight size={17} aria-hidden /></button>
        <button className="btn" type="button" onClick={() => { setAnchor(null); setSelected(null); }}>Сегодня</button>
        <h2 className="ops-calendar-label">{title}</h2>
        <div className="ops-toolbar" aria-label="Вид календаря">
          {Object.entries(modes).map(([key, label]) => <button className="btn" type="button" key={key} aria-pressed={mode === key} onClick={() => setMode(key as Mode)}>{label}</button>)}
        </div>
      </div>
      {entries.error && <OperationsNotice variant="error">{errorText(entries.error)}</OperationsNotice>}
      {entries.isPending && <OperationsLoading />}
      {mode === "list" ? <section className="panel ops-section ops-calendar-list" aria-label="Список публикаций">
        {!grouped.size && !entries.isPending && <OperationsEmpty>В этом месяце нет запланированных публикаций.</OperationsEmpty>}
        {[...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([day, items]) => <div key={day}>
          <h3>{dateCaption(day, { weekday: "long", day: "numeric", month: "long" })}</h3>
          {eventRows(items)}
        </div>)}
      </section> : <>
        <div className="ops-calendar" aria-label={`Календарь · ${title}`}>
          {weekdays.map(day => <div className="ops-calendar-head muted" key={day}>{day}</div>)}
          {dates.map(day => {
            const items = grouped.get(day) ?? [];
            return <div className={`ops-calendar-cell ${mode} ${day.slice(0, 7) !== anchor.slice(0, 7) && mode === "month" ? "outside" : ""}`} key={day}>
              <button className={`btn ghost ops-day ${day === today ? "today" : ""}`} type="button" aria-pressed={day === selected} aria-label={`${dateCaption(day, { day: "numeric", month: "long" })}, публикаций: ${items.length}`} onClick={() => setSelected(day)}>{Number(day.slice(-2))}</button>
              {!!items.length && <span className="ops-event-count" aria-hidden>{items.length}</span>}
              <div className="ops-calendar-events">
                {items.slice(0, 4).map(item => <Link to={`/publications/${item.id}`} className="ops-event" title={item.title} key={item.id}>
                  <i style={{ background: statusMap.get(item.status_id)?.color ?? "#20d6cd" }} aria-hidden />
                  <span>
                    <span className="ops-event-name">{item.title}</span>
                    <span className="ops-event-time muted">{item.scheduled_at && timeCaption(item.scheduled_at, timezone)}</span>
                  </span>
                </Link>)}
                {items.length > 4 && <small className="muted">+ ещё {items.length - 4}</small>}
              </div>
            </div>;
          })}
        </div>
        <section className="panel ops-section">
          <div className="ops-toolbar"><Clock3 size={16} aria-hidden /><h2>{dateCaption(selected, { weekday: "long", day: "numeric", month: "long" })}</h2></div>
          {picked.length ? eventRows(picked) : <OperationsEmpty>На этот день ничего не запланировано.</OperationsEmpty>}
        </section>
      </>}
      {editor && <Reschedule item={editor === true ? undefined : editor} day={selected} timezone={timezone} onClose={() => setEditor(null)} />}
    </div>
  );
}
