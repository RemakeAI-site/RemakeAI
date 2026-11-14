import { useState } from "react";
import { Archive, ArrowUpRight, Check, ChevronLeft, ChevronRight, Film, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api, useStudio } from "../api";
import { OperationsConfirm, OperationsCover, OperationsEmpty, OperationsHeading, OperationsLoading, OperationsNotice, errorText } from "./components";
import { formatDateTime } from "./dates";
import type { Category, PageData, Publication, Status, StudioSettings, TrashItem } from "./types";

type ArchiveAction = "keep" | "metadata" | "media" | "trash";

const archiveActions = {
  keep: { label: "Сохранить все", text: "", success: "Выпуск отмечен для хранения." },
  metadata: { label: "Архивировать метаданные", text: "Запись будет архивирована, а её медиа перемещены в корзину. Описание, даты, ссылки и сценарий сохранятся.", success: "Метаданные архивированы." },
  media: { label: "Убрать медиа", text: "Медиафайлы будут перенесены в корзину. Карточка, описание и ссылки останутся доступны.", success: "Медиафайлы перенесены в корзину." },
  trash: { label: "В корзину", text: "Публикация и её материалы будут доступны для восстановления в корзине.", success: "Публикация перемещена в корзину." },
} as const;

function PublicationDetails({ item, timezone, dateFormat, category, status, showStatus = true }: { item: Publication; timezone: string; dateFormat?: string; category?: Category; status?: Status; showStatus?: boolean }) {
  return <div className="ops-row-detail">
    <OperationsCover id={item.cover_media_id ?? item.preview_media_id ?? null} className="ops-archive-cover" fallback={<Archive size={18} />} />
    <div>
      <Link to={`/publications/${item.id}`}><strong>{item.title}</strong></Link>
      <small className="muted">{category?.name && `${category.name} · `}{formatDateTime(item.published_at ?? item.created_at, timezone, dateFormat)}</small>
      {showStatus && status && <div><span className="badge" style={{ color: status.color }}>{status.name}</span></div>}
    </div>
  </div>;
}

export function ArchivePage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [selection, setSelection] = useState<{ item: Publication; action: ArchiveAction } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const settings = useStudio<StudioSettings>("/settings");
  const categories = useStudio<Category[]>("/categories");
  const statuses = useStudio<Status[]>("/statuses");
  const cleanup = useStudio<{ limit: number; items: Publication[] }>("/system/archive", true, 15_000);
  const params = new URLSearchParams({ archived: "1", page: String(page), limit: "18", sort: "updated" });
  if (search) params.set("q", search);
  if (categoryId) params.set("category_id", categoryId);
  const records = useStudio<PageData<Publication>>(`/publications?${params}`);
  const categoryMap = new Map(categories.data?.map(entry => [entry.id, entry]));
  const statusMap = new Map(statuses.data?.map(entry => [entry.id, entry]));
  const timezone = settings.data?.timezone ?? "Europe/Minsk";
  const pages = Math.max(1, Math.ceil((records.data?.total ?? 0) / (records.data?.limit ?? 18)));
  async function run(item: Publication, action: ArchiveAction) {
    setNotice(null);
    setBusyId(item.id);
    try {
      await api("/system/archive", { method: "POST", body: JSON.stringify({ id: item.id, action }) });
      setSelection(null);
      setNotice({ text: archiveActions[action].success });
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true });
    } finally {
      setBusyId(null);
    }
  }
  return <div className="page ops-stack">
    <OperationsHeading title="Архив" description="Опубликованные и архивированные выпуски, ссылки на TikTok и управление старыми материалами." actions={<Link className="btn" to="/trash"><Trash2 size={16} aria-hidden /> Корзина</Link>} />
    {!selection && notice && <OperationsNotice variant={notice.error ? "error" : undefined}>{notice.text}</OperationsNotice>}
    {cleanup.error && <OperationsNotice variant="error">{errorText(cleanup.error)}</OperationsNotice>}
    {!!cleanup.data?.items.length && <section className="panel ops-section ops-stack">
      <h2>Предложения по очистке</h2>
      <p className="muted">По настройкам студия оставляет {cleanup.data.limit} последних опубликованных выпусков каждой рубрики. Содержимое можно обработать вручную прямо здесь.</p>
      {cleanup.data.items.map(item => <div className="ops-row" key={item.id}>
        <PublicationDetails item={item} category={item.category_id ? categoryMap.get(item.category_id) : undefined} timezone={timezone} dateFormat={settings.data?.date_format} showStatus={false} />
        <div className="ops-toolbar">
          <button className="btn" type="button" disabled={!!busyId} onClick={() => run(item, "keep")}><Check size={15} aria-hidden /> {archiveActions.keep.label}</button>
          <button className="btn" type="button" disabled={!!busyId} onClick={() => { setNotice(null); setSelection({ item, action: "metadata" }); }}><Archive size={15} aria-hidden /> {archiveActions.metadata.label}</button>
          <button className="btn" type="button" disabled={!!busyId} onClick={() => { setNotice(null); setSelection({ item, action: "media" }); }}><Film size={15} aria-hidden /> {archiveActions.media.label}</button>
          <button className="btn danger" type="button" disabled={!!busyId} onClick={() => { setNotice(null); setSelection({ item, action: "trash" }); }}><Trash2 size={15} aria-hidden /> {archiveActions.trash.label}</button>
        </div>
      </div>)}
    </section>}
    <section className="panel ops-section ops-stack">
      <h2>Публикации</h2>
      <div className="ops-field-grid">
        <label className="ops-field">Поиск в архиве<input type="search" placeholder="Название, описание или тег" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
        <label className="ops-field">Рубрика<select value={categoryId} onChange={event => { setCategoryId(event.target.value); setPage(1); }}><option value="">Все рубрики</option>
          {categories.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
      </div>
      {records.error && <OperationsNotice variant="error">{errorText(records.error)}</OperationsNotice>}
      {records.isPending && <OperationsLoading />}
      {records.data?.items.length === 0 && <OperationsEmpty>В архиве нет публикаций по выбранным условиям.</OperationsEmpty>}
      {records.data?.items.map(item => <div className="ops-row" key={item.id}>
        <PublicationDetails item={item} category={item.category_id ? categoryMap.get(item.category_id) : undefined} status={statusMap.get(item.status_id)} timezone={timezone} dateFormat={settings.data?.date_format} />
        {item.tiktok_url && /^https?:\/\//i.test(item.tiktok_url) && <a className="btn" href={item.tiktok_url} target="_blank" rel="noopener noreferrer">TikTok <ArrowUpRight size={15} aria-hidden /></a>}
      </div>)}
      {pages > 1 && <div className="ops-toolbar">
        <button className="btn" type="button" aria-label="Предыдущая страница" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} aria-hidden /></button>
        <span className="muted">{page} / {pages} · {records.data?.total ?? 0}</span>
        <button className="btn" type="button" aria-label="Следующая страница" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={16} aria-hidden /></button>
      </div>}
    </section>
    {selection && <OperationsConfirm title={`${archiveActions[selection.action].label}?`} text={archiveActions[selection.action].text} label="Подтвердить" pending={!!busyId} error={notice?.error ? notice.text : undefined} onClose={() => { setSelection(null); setNotice(null); }} onConfirm={() => run(selection.item, selection.action)} />}
  </div>;
}

const trashNames: Record<TrashItem["type"], string> = { category: "Рубрика", publication: "Публикация", idea: "Идея", attachment: "Медиафайл", cover: "Обложка или логотип" };

export function TrashPage() {
  const trash = useStudio<TrashItem[]>("/trash");
  const settings = useStudio<StudioSettings>("/settings");
  const [filter, setFilter] = useState<TrashItem["type"] | "">("");
  const [permanent, setPermanent] = useState<TrashItem | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const timezone = settings.data?.timezone ?? "Europe/Minsk";
  const items = (trash.data ?? []).filter(item => !filter || item.type === filter);
  async function handle(item: TrashItem, purge: boolean) {
    setNotice(null);
    setPending(item.id);
    try {
      const endpoint = `/trash/${item.type}/${item.id}`;
      await api(purge ? endpoint : `${endpoint}/restore`, purge
        ? { method: "DELETE", body: JSON.stringify({ confirm: true }) }
        : { method: "POST" });
      setPermanent(null);
      setNotice({ text: purge ? "Объект удалён окончательно." : "Объект восстановлен." });
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true });
    } finally {
      setPending(null);
    }
  }
  return <div className="page ops-stack">
    <OperationsHeading title="Корзина" description={`Удалённые материалы можно восстановить в течение ${settings.data?.trash_days ?? 30} дней. Связанные рубрики и публикации восстанавливаются вместе.`} actions={<Link className="btn" to="/settings">Настройки</Link>} />
    {!permanent && notice && <OperationsNotice variant={notice.error ? "error" : undefined}>{notice.text}</OperationsNotice>}
    <section className="panel ops-section ops-stack">
      <label className="ops-field">Тип объекта<select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="">Все объекты</option>
        {Object.entries(trashNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      {trash.error && <OperationsNotice variant="error">{errorText(trash.error)}</OperationsNotice>}
      {trash.isPending && <OperationsLoading />}
      {!trash.isPending && !items.length && <OperationsEmpty>{filter ? "В корзине нет объектов этого типа." : "Корзина пуста."}</OperationsEmpty>}
      {items.map(item => <div className="ops-row" key={`${item.type}:${item.id}`}>
        <div><strong>{item.name}</strong><small className="muted">{trashNames[item.type]} · удалено {formatDateTime(item.deleted_at, timezone, settings.data?.date_format)}{item.group && " · часть группы"}</small></div>
        <div className="ops-toolbar">
          <button className="btn" type="button" disabled={!!pending} onClick={() => handle(item, false)}>{pending === item.id && !permanent ? "Восстанавливаем…" : "Восстановить"}</button>
          <button className="btn danger" type="button" disabled={!!pending} onClick={() => { setNotice(null); setPermanent(item); }}>Удалить навсегда</button>
        </div>
      </div>)}
    </section>
    {permanent && <OperationsConfirm title="Удалить навсегда?" text={`«${permanent.name}»${permanent.group ? " и связанные элементы этой группы" : ""} будут удалены окончательно. Отменить действие можно только восстановлением из отдельной резервной копии.`} label="Удалить навсегда" pending={!!pending} error={notice?.error ? notice.text : undefined} onClose={() => { setPermanent(null); setNotice(null); }} onConfirm={() => handle(permanent, true)} />}
  </div>;
}
