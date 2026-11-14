import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, CircleHelp, ImagePlus, Save, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api, mediaUrl, uploadOriginal, useStudio } from "../api";
import { OperationsConfirm, OperationsEmpty, OperationsHeading, OperationsLoading, OperationsNotice, errorText, prettyBytes } from "./components";
import type { Category, Status, StudioSettings, SystemData } from "./types";

const gib = 1024 ** 3;
const fieldTypes = {
  text: "Текст",
  number: "Число",
  date: "Дата",
  boolean: "Переключатель",
  select: "Список вариантов",
  url: "URL",
} as const;
type CustomType = keyof typeof fieldTypes;
type CustomField = { id: string; name: string; type: CustomType; options: string[]; sort_order: number };
type SettingGroup = "appearance" | "content" | "categories" | "storage" | "data" | "other";

function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return <label className="ops-field">{label}{children}{help && <small>{help}</small>}</label>;
}

function SettingPanel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="panel ops-section ops-stack"><h2>{title}</h2>{children}</section>;
}

function StatusEditor({ statuses }: { statuses: Status[] }) {
  const [edits, setEdits] = useState<Record<string, Partial<Status>>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const edit = (id: string, patch: Partial<Status>) => setEdits(previous => ({ ...previous, [id]: { ...previous[id], ...patch } }));
  async function save(event: FormEvent, status: Status) {
    event.preventDefault();
    setNotice(null);
    setPending(status.id);
    try {
      await api(`/statuses/${status.id}`, { method: "PATCH", body: JSON.stringify(edits[status.id] ?? {}) });
      setEdits(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== status.id)));
      setNotice({ text: "Статус обновлён." });
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true });
    } finally {
      setPending(null);
    }
  }
  return <SettingPanel title="Статусы публикаций">
    {statuses.map(status => {
      const draft = { ...status, ...edits[status.id] };
      return <form className="ops-status-form" key={status.id} onSubmit={event => save(event, status)}>
        <div className="ops-status-editor">
          <Field label="Название">
            <input required maxLength={120} value={draft.name} onChange={event => edit(status.id, { name: event.target.value })} />
          </Field>
          <Field label="Цвет">
            <input type="color" value={draft.color} onChange={event => edit(status.id, { color: event.target.value })} />
          </Field>
          <Field label="Порядок">
            <input type="number" min="0" value={draft.sort_order} onChange={event => edit(status.id, { sort_order: Number(event.target.value) })} />
          </Field>
        </div>
        <button className="btn" type="submit" disabled={!edits[status.id] || !!pending}>{pending === status.id ? "Сохраняем…" : "Сохранить"}</button>
      </form>;
    })}
    {notice && <OperationsNotice variant={notice.error ? "error" : undefined}>{notice.text}</OperationsNotice>}
  </SettingPanel>;
}

function CustomFieldsEditor() {
  const fields = useStudio<CustomField[]>("/custom-fields");
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomType>("text");
  const [options, setOptions] = useState("");
  const [order, setOrder] = useState(0);
  const [removing, setRemoving] = useState<CustomField | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  function reset() {
    setEditing(null);
    setName("");
    setType("text");
    setOptions("");
    setOrder(0);
  }
  function startEdit(field: CustomField) {
    setEditing(field);
    setName(field.name);
    setType(field.type);
    setOptions((field.options ?? []).join("\n"));
    setOrder(field.sort_order);
    setNotice(null);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    try {
      const values = [...new Set(options.split("\n").map(option => option.trim()).filter(Boolean))];
      if (type === "select" && !values.length) throw new Error("Укажите хотя бы один вариант.");
      await api(editing ? `/custom-fields/${editing.id}` : "/custom-fields", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify({ name, type, options: type === "select" ? values : [], sort_order: order }),
      });
      setNotice({ text: editing ? "Поле обновлено." : "Поле добавлено." });
      reset();
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true });
    } finally {
      setPending(false);
    }
  }
  async function remove() {
    if (!removing) return;
    setPending(true);
    setNotice(null);
    try {
      await api(`/custom-fields/${removing.id}`, { method: "DELETE" });
      if (editing?.id === removing.id) reset();
      setRemoving(null);
      setNotice({ text: "Поле удалено." });
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true });
    } finally {
      setPending(false);
    }
  }
  return <SettingPanel title="Пользовательские поля">
    {fields.isPending && <OperationsLoading />}
    {fields.error && <OperationsNotice variant="error">{errorText(fields.error)}</OperationsNotice>}
    {fields.data?.length === 0 && <OperationsEmpty>Создайте первое дополнительное поле для карточек публикаций.</OperationsEmpty>}
    {fields.data?.map(field => <div className="ops-row" key={field.id}>
      <div><strong>{field.name}</strong><small className="muted">{fieldTypes[field.type]}</small></div>
      <div className="ops-toolbar">
        <button className="btn" type="button" onClick={() => startEdit(field)}>Изменить</button>
        <button className="btn danger" type="button" onClick={() => { setNotice(null); setRemoving(field); }}>Удалить</button>
      </div>
    </div>)}
    <form className="ops-stack" onSubmit={save}>
      <h3>{editing ? `Редактировать «${editing.name}»` : "Новое поле"}</h3>
      <div className="ops-field-grid">
        <Field label="Название"><input maxLength={120} value={name} onChange={event => setName(event.target.value)} required placeholder="Например, музыка" /></Field>
        <Field label="Тип">
          <select value={type} onChange={event => setType(event.target.value as CustomType)}>
            {Object.entries(fieldTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </Field>
        <Field label="Порядок"><input type="number" min="0" value={order} onChange={event => setOrder(Number(event.target.value))} /></Field>
      </div>
      {type === "select" && <Field label="Варианты — по одному в строке"><textarea rows={3} value={options} onChange={event => setOptions(event.target.value)} placeholder="Вариант 1" required /></Field>}
      {!removing && notice && <OperationsNotice variant={notice.error ? "error" : undefined}>{notice.text}</OperationsNotice>}
      <div className="ops-toolbar">
        <button className="btn primary" type="submit" disabled={pending}>{editing ? "Сохранить поле" : "Добавить поле"}</button>
        {editing && <button className="btn" type="button" onClick={reset}>Отмена</button>}
      </div>
    </form>
    {removing && <OperationsConfirm title="Удалить поле?" text={`Поле «${removing.name}» и его значения в публикациях будут удалены.`} label="Удалить" pending={pending} error={notice?.error ? notice.text : undefined} onClose={() => { setRemoving(null); setNotice(null); }} onConfirm={remove} />}
  </SettingPanel>;
}

export function SettingsPage() {
  const settings = useStudio<StudioSettings>("/settings");
  const statuses = useStudio<Status[]>("/statuses");
  const system = useStudio<SystemData>("/system", false);
  const categories = useStudio<Category[]>("/categories");
  const [group, setGroup] = useState<SettingGroup>("appearance");
  const [patch, setPatch] = useState<Partial<StudioSettings>>({});
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [logoRemove, setLogoRemove] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  if (!settings.data) return <div className="page ops-stack"><OperationsHeading title="Настройки" />{settings.error ? <OperationsNotice variant="error">{errorText(settings.error)}</OperationsNotice> : <OperationsLoading />}</div>;
  const state = { ...settings.data, ...patch };
  const edit = <Key extends keyof StudioSettings>(key: Key, value: StudioSettings[Key]) => setPatch(previous => ({ ...previous, [key]: value }));
  const setError = (cause: unknown) => setNotice({ text: errorText(cause), error: true });
  function setGroupTab(value: SettingGroup) {
    setGroup(value);
    if (value === "storage") void system.refetch();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    try {
      await api("/settings", { method: "PATCH", body: JSON.stringify(patch) });
      setPatch({});
      setNotice({ text: "Настройки сохранены." });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  async function sendLogo(file: File) {
    setNotice(null);
    setProgress(0);
    try {
      await uploadOriginal(file, { target_type: "logo" }, percentage => setProgress(percentage / 100));
      setNotice({ text: "Логотип обновлён." });
    } catch (cause) {
      setError(cause);
    } finally {
      setProgress(null);
      if (logoInput.current) logoInput.current.value = "";
    }
  }
  async function removeLogo() {
    setPending(true);
    setNotice(null);
    try {
      await api("/media/cover", { method: "PATCH", body: JSON.stringify({ target_type: "logo", media_id: null }) });
      setLogoRemove(false);
      setNotice({ text: "Стандартный логотип восстановлен." });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  const groups: Record<SettingGroup, string> = { appearance: "Внешний вид", content: "Контент", categories: "Рубрики", storage: "Хранилище", data: "Данные", other: "Дополнительно" };
  return <div className="page ops-stack">
    <OperationsHeading title="Настройки" description="Оформление, рубрики, правила публикации и управление данными студии." />
    <div className="ops-toolbar ops-tabs" aria-label="Разделы настроек">
      {Object.entries(groups).map(([key, label]) => <button key={key} className="btn" type="button" aria-pressed={key === group} onClick={() => setGroupTab(key as SettingGroup)}>{label}</button>)}
    </div>
    {notice && !logoRemove && <OperationsNotice variant={notice.error ? "error" : undefined}>{notice.text}</OperationsNotice>}
    <form onSubmit={save} className="ops-stack">
      {group === "appearance" && <SettingPanel title="Оформление студии">
        <div className="ops-field-grid">
          <Field label="Название проекта"><input required maxLength={120} value={state.name} onChange={event => edit("name", event.target.value)} /></Field>
          <Field label="Акцент"><input type="color" value={state.accent} onChange={event => edit("accent", event.target.value)} /></Field>
          <Field label="Тема"><select value={state.theme} onChange={event => edit("theme", event.target.value as StudioSettings["theme"])}><option value="dark">Тёмная</option><option value="light">Светлая</option><option value="system">Системная</option></select></Field>
          <Field label="Плотность"><select value={state.density} onChange={event => edit("density", event.target.value as StudioSettings["density"])}><option value="comfortable">Обычная</option><option value="compact">Компактная</option></select></Field>
        </div>
        <div className="ops-row">
          <div className="ops-row-detail">
            <img className="ops-logo" alt="Текущий логотип" src={state.logo_media_id ? mediaUrl(state.logo_media_id, true) : "/brand/logo.webp"} />
            <div><strong>Логотип</strong><small className="muted">PNG, JPEG или WebP</small></div>
          </div>
          <div className="ops-toolbar">
            <input type="file" accept="image/png,image/jpeg,image/webp" ref={logoInput} hidden onChange={event => { const file = event.target.files?.[0]; if (file) void sendLogo(file); }} />
            <button className="btn" type="button" onClick={() => logoInput.current?.click()} disabled={progress !== null}><ImagePlus size={16} aria-hidden /> Загрузить логотип</button>
            {state.logo_media_id && <button className="btn danger" type="button" onClick={() => { setNotice(null); setLogoRemove(true); }} disabled={progress !== null}><Trash2 size={16} aria-hidden /> Сбросить</button>}
          </div>
        </div>
        {progress !== null && <progress className="ops-progress" max={1} value={progress} aria-label="Загрузка логотипа" />}
      </SettingPanel>}
      {group === "content" && <SettingPanel title="Правила публикации">
        <div className="ops-field-grid">
          <Field label="Лимит названия и описания" help="Символов, включая пробелы и переносы">
            <input type="number" min="1" max="100000" required value={state.text_limit} onChange={event => edit("text_limit", Number(event.target.value))} />
          </Field>
          <Field label="Сколько опубликованных выпусков хранить в рубрике" help="Для более старых выпусков студия предлагает очистку.">
            <input type="number" min="0" max="100000" required value={state.archive_limit} onChange={event => edit("archive_limit", Number(event.target.value))} />
          </Field>
        </div>
      </SettingPanel>}
      {group === "categories" && <SettingPanel title="Индикаторы готовности рубрик">
        <Field label="Что считать">
          <select value={state.indicator_basis} onChange={event => edit("indicator_basis", event.target.value as StudioSettings["indicator_basis"])}>
            <option value="ready">Готовые неопубликованные публикации</option>
            <option value="unpublished">Все неопубликованные публикации</option>
            <option value="all">Все публикации</option>
            <option value="published">Опубликованные публикации</option>
          </select>
        </Field>
        <div className="ops-field-grid">
          <Field label="Красный · до включительно"><input type="number" min="0" required value={state.red_max} onChange={event => edit("red_max", Number(event.target.value))} /></Field>
          <Field label="Жёлтый · до включительно"><input type="number" min="0" required value={state.yellow_max} onChange={event => edit("yellow_max", Number(event.target.value))} /></Field>
          <Field label="Зелёный · от включительно" help="На 1 больше жёлтого порога."><input type="number" min="0" required value={state.green_min} onChange={event => edit("green_min", Number(event.target.value))} /></Field>
          <Field label="Красный цвет"><input type="color" value={state.red_color} onChange={event => edit("red_color", event.target.value)} /></Field>
          <Field label="Жёлтый цвет"><input type="color" value={state.yellow_color} onChange={event => edit("yellow_color", event.target.value)} /></Field>
          <Field label="Зелёный цвет"><input type="color" value={state.green_color} onChange={event => edit("green_color", event.target.value)} /></Field>
        </div>
        <div className="ops-toolbar"><Link className="btn" to="/categories">Управление рубриками <ArrowUpRight size={15} aria-hidden /></Link></div>
      </SettingPanel>}
      {group === "storage" && <SettingPanel title="Лимиты и предупреждения">
        <div className="ops-field-grid">
          <Field label="Лимит хранилища, ГиБ">
            <input type="number" step="0.001" min="0.001" required value={Number((state.storage_limit / gib).toFixed(3))} onChange={event => edit("storage_limit", Math.round(Number(event.target.value) * gib))} />
          </Field>
          <Field label="Порог предупреждения, ГиБ">
            <input type="number" step="0.001" min="0.001" required value={Number((state.storage_warn / gib).toFixed(3))} onChange={event => edit("storage_warn", Math.round(Number(event.target.value) * gib))} />
          </Field>
        </div>
        {system.data && <p className="muted">Сейчас занято {prettyBytes(system.data.usage.originals + system.data.usage.previews)}.</p>}
        <div className="ops-toolbar"><Link to="/system" className="btn">Анализ занятого места <ArrowUpRight size={15} aria-hidden /></Link><Link to="/archive" className="btn">Очистка архива <ArrowUpRight size={15} aria-hidden /></Link></div>
      </SettingPanel>}
      {group === "data" && <SettingPanel title="Резервные копии и корзина">
        <Field label="Хранить в корзине, дней"><input type="number" min="1" max="3650" required value={state.trash_days} onChange={event => edit("trash_days", Number(event.target.value))} /></Field>
        <div className="ops-toolbar"><Link to="/backup" className="btn">Экспорт и восстановление <ArrowUpRight size={15} aria-hidden /></Link><Link to="/trash" className="btn">Открыть корзину <ArrowUpRight size={15} aria-hidden /></Link></div>
      </SettingPanel>}
      {group === "other" && <SettingPanel title="Время и техническая информация">
        <div className="ops-field-grid">
          <Field label="Часовой пояс" help="Идентификатор IANA, например Europe/Minsk">
            <input required list="ops-timezones" value={state.timezone} onChange={event => edit("timezone", event.target.value)} />
            <datalist id="ops-timezones">{["Europe/Minsk", "Europe/Warsaw", "Europe/Vilnius", "Europe/Moscow", "Europe/Paris", "Asia/Dubai", "America/New_York", "UTC"].map(item => <option value={item} key={item} />)}</datalist>
          </Field>
          <Field label="Формат даты">
            <select value={state.date_format} onChange={event => edit("date_format", event.target.value)}>
              <option value="dd.MM.yyyy">14.11.2026</option>
              <option value="yyyy-MM-dd">2026-11-14</option>
              <option value="d MMM yyyy">14 нояб. 2026</option>
            </select>
          </Field>
        </div>
        <div className="ops-toolbar"><Link to="/system" className="btn"><CircleHelp size={16} aria-hidden /> Версия и диагностика</Link></div>
      </SettingPanel>}
      <div className="ops-toolbar">
        <button className="btn primary" type="submit" disabled={!Object.keys(patch).length || pending}><Save size={16} aria-hidden /> {pending ? "Сохраняем…" : "Сохранить настройки"}</button>
        {!!Object.keys(patch).length && <button className="btn" type="button" onClick={() => setPatch({})}>Отменить изменения</button>}
      </div>
    </form>
    {group === "content" && <>
      {statuses.error ? <OperationsNotice variant="error">{errorText(statuses.error)}</OperationsNotice> : statuses.data ? <StatusEditor statuses={statuses.data} /> : <OperationsLoading />}
      <CustomFieldsEditor />
    </>}
    {group === "categories" && <SettingPanel title="Лимиты отдельных рубрик">
      <p className="muted">Лимит описания в конкретной рубрике можно изменить в её карточке.</p>
      {categories.data?.map(category => <div className="ops-row" key={category.id}><div><strong>{category.name}</strong><small style={{ color: category.indicator_color }}>{category.indicator_label}</small></div><Link className="btn" to={`/categories/${category.id}`}>Открыть</Link></div>)}
    </SettingPanel>}
    {logoRemove && <OperationsConfirm title="Сбросить логотип?" text="В приложении появится фирменный логотип студии. Пользовательский файл будет перенесён в корзину." label="Сбросить" pending={pending} error={notice?.error ? notice.text : undefined} onClose={() => { setLogoRemove(false); setNotice(null); }} onConfirm={removeLogo} />}
  </div>;
}
