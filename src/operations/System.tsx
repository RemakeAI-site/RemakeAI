import { useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpRight, Database, HardDrive, HeartPulse, Trash2, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { api, useStudio } from "../api";
import { restoreZip } from "../backup";
import { OperationsConfirm, OperationsEmpty, OperationsHeading, OperationsLoading, OperationsMetric, OperationsNotice, errorText, prettyBytes } from "./components";
import { formatDateTime } from "./dates";
import type { BackupRecord, DiagnosticsCheck, StudioSettings, SystemData } from "./types";

const zipLimit = 64 * 1024 * 1024;

function connectivity(value: SystemData["database"] | undefined) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return value ? "Доступна" : "Недоступна";
  if (typeof value === "string") {
    if (["ok", "healthy", "available", "connected"].includes(value.toLowerCase())) return "Доступна";
    if (["error", "failed", "unavailable", "disconnected"].includes(value.toLowerCase())) return "Недоступна";
    return value;
  }
  if (value.ok === undefined) return value.message ?? value.error ?? "—";
  return value.ok ? "Доступна" : value.message ?? value.error ?? "Недоступна";
}

const backupStatuses: Record<string, string> = {
  ready: "Готова",
  complete: "Готова",
  completed: "Готова",
  success: "Готова",
  failed: "Ошибка",
  error: "Ошибка",
  processing: "В процессе",
  running: "В процессе",
  restored: "Восстановлена",
  exported: "Создана",
  staged: "Подготовлена",
};

function backupStatus(value: string) {
  return backupStatuses[value.toLowerCase()] ?? value;
}

function CheckDetail({ check }: { check?: boolean | string | DiagnosticsCheck }) {
  return <span>{connectivity(check)}{typeof check === "object" && check.time !== undefined && ` · ${check.time} мс`}</span>;
}

export function SystemPage() {
  const system = useStudio<SystemData>("/system", true, 60_000);
  const settings = useStudio<StudioSettings>("/settings");
  const [result, setResult] = useState<{ database?: SystemData["database"]; storage?: SystemData["storage"] } | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [cleanPrompt, setCleanPrompt] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const timezone = settings.data?.timezone ?? "Europe/Minsk";
  const usage = system.data?.usage;
  const actual = (usage?.originals ?? 0) + (usage?.previews ?? 0);
  const quota = settings.data?.storage_limit ?? 0;
  const warn = settings.data?.storage_warn;
  const over = typeof warn === "number" && actual >= warn && actual > 0;
  async function diagnose() {
    setDiagnosing(true);
    setDiagnoseError("");
    setResult(null);
    try {
      setResult(await api("/system/diagnose", { method: "POST" }));
    } catch (cause) {
      setDiagnoseError(errorText(cause));
    } finally {
      setDiagnosing(false);
    }
  }
  async function cleanExpired() {
    setCleanupNotice(null);
    setCleaning(true);
    try {
      await api("/system/cleanup", { method: "POST", body: JSON.stringify({ confirm: true }) });
      setCleanPrompt(false);
      setCleanupNotice({ text: "Просроченные элементы корзины обработаны." });
    } catch (cause) {
      setCleanupNotice({ text: errorText(cause), error: true });
    } finally {
      setCleaning(false);
    }
  }
  return <div className="page ops-stack">
    <OperationsHeading title="Система" description="Состояние сервисов, занятое пространство и диагностика." actions={<button className="btn primary" type="button" onClick={diagnose} disabled={diagnosing}><HeartPulse size={17} aria-hidden /> {diagnosing ? "Проверяем…" : "Запустить диагностику"}</button>} />
    {system.isPending && <OperationsLoading />}
    {system.error && <OperationsNotice variant="error">{errorText(system.error)}</OperationsNotice>}
    {diagnoseError && <OperationsNotice variant="error">{diagnoseError}</OperationsNotice>}
    {result && <section className="panel ops-section ops-stack" aria-live="polite">
      <h2>Результат диагностики</h2>
      <div className="ops-row"><div className="ops-toolbar"><Database size={16} aria-hidden /> База данных</div><CheckDetail check={result.database} /></div>
      <div className="ops-row"><div className="ops-toolbar"><HardDrive size={16} aria-hidden /> Файловое хранилище</div><CheckDetail check={result.storage} /></div>
    </section>}
    {system.data && <>
      <div className="ops-card-grid">
        <OperationsMetric label="База данных">{connectivity(system.data.database)}</OperationsMetric>
        <OperationsMetric label="Объектное хранилище">{connectivity(system.data.storage)}</OperationsMetric>
        <OperationsMetric label="Объектов хранения">{new Intl.NumberFormat("ru").format(usage?.count ?? 0)}</OperationsMetric>
        <OperationsMetric label="Версия приложения">{system.data.version}</OperationsMetric>
      </div>
      <section className="panel ops-section ops-stack">
        <h2>Использование хранилища</h2>
        <p><strong>{prettyBytes(actual)}</strong> {quota > 0 && <span className="muted">из {prettyBytes(quota)}</span>}</p>
        {quota > 0 && <progress className="ops-progress" value={Math.min(actual, quota)} max={quota} aria-label="Заполненность хранилища" />}
        {over && <OperationsNotice variant="warning">{quota > 0 && actual >= quota ? "Достигнут лимит хранилища." : "Достигнут порог предупреждения."} Проверьте архив и корзину.</OperationsNotice>}
        <div className="ops-card-grid">
          <OperationsMetric label="Оригиналы">{prettyBytes(usage?.originals ?? 0)}</OperationsMetric>
          <OperationsMetric label="Превью">{prettyBytes(usage?.previews ?? 0)}</OperationsMetric>
          <OperationsMetric label="Фотографии">{prettyBytes(usage?.images ?? 0)}</OperationsMetric>
          <OperationsMetric label="Видео">{prettyBytes(usage?.videos ?? 0)}</OperationsMetric>
          <OperationsMetric label="В корзине">{prettyBytes(usage?.trash ?? 0)}</OperationsMetric>
        </div>
        <div className="ops-toolbar">
          <Link className="btn" to="/settings">Изменить лимиты <ArrowUpRight size={16} aria-hidden /></Link>
          <Link className="btn" to="/archive">Очистка архива <ArrowUpRight size={16} aria-hidden /></Link>
          <Link className="btn" to="/trash">Корзина <ArrowUpRight size={16} aria-hidden /></Link>
          <button type="button" className="btn" onClick={() => { setCleanupNotice(null); setCleanPrompt(true); }}><Trash2 size={16} aria-hidden /> Очистить просроченные</button>
        </div>
        {cleanupNotice && !cleanPrompt && <OperationsNotice variant={cleanupNotice.error ? "error" : undefined}>{cleanupNotice.text}</OperationsNotice>}
        <small>Данные отражают объём в студии. Сумму к оплате определяет поставщик облака.</small>
        <details>
          <summary>Оценка стоимости R2 Standard</summary>
          <p className="muted">При неизменном объёме за месяц ориентир за хранение — {new Intl.NumberFormat("ru", { style: "currency", currency: "USD" }).format(Math.max(0, Math.ceil(actual / 1_000_000_000) - 10) * 0.015)}. Оценка включает месячный бесплатный объём 10 ГБ при наличии доступной квоты аккаунта. Запросы, другие хранилища и налоги рассчитываются отдельно.</p>
          <a className="link-action" href="https://developers.cloudflare.com/r2/pricing/" target="_blank" rel="noopener noreferrer">Тарифы Cloudflare <ArrowUpRight size={15} aria-hidden /></a>
        </details>
      </section>
      <div className="ops-info-grid">
        <section className="panel ops-section">
          <h2>Размер по рубрикам</h2>
          {!system.data.categories.length && <OperationsEmpty>Медиа в рубриках появятся после загрузки.</OperationsEmpty>}
          {system.data.categories.map(entry => <div className="ops-row" key={entry.id}><div><Link to={`/categories/${entry.id}`}>{entry.name}</Link></div><strong>{prettyBytes(entry.bytes)}</strong></div>)}
        </section>
        <section className="panel ops-section">
          <h2>Самые тяжёлые публикации</h2>
          {!system.data.largest.length && <OperationsEmpty>В публикациях пока нет файлов.</OperationsEmpty>}
          {system.data.largest.map(entry => <div className="ops-row" key={entry.id}><div><Link to={`/publications/${entry.id}`}>{entry.title}</Link></div><strong>{prettyBytes(entry.bytes)}</strong></div>)}
        </section>
      </div>
      <div className="ops-info-grid">
        <section className="panel ops-section ops-stack">
          <h2>Последняя резервная копия</h2>
          {system.data.backup ? <div><strong>{backupStatus(system.data.backup.status)}</strong><p className="muted">{formatDateTime(system.data.backup.created_at, timezone, settings.data?.date_format)} · объектов {system.data.backup.object_count}</p></div>
            : <OperationsEmpty>История резервных копий пока пуста.</OperationsEmpty>}
          <div className="ops-toolbar"><Link className="btn" to="/backup">Резервные копии <ArrowUpRight size={16} aria-hidden /></Link></div>
        </section>
        <section className="panel ops-section">
          <h2>Последние ошибки</h2>
          {!system.data.errors.length && <OperationsEmpty>Записей об ошибках нет.</OperationsEmpty>}
          {system.data.errors.map((entry, index) => <div className="ops-row" key={typeof entry === "string" ? `${index}:${entry}` : entry.id ?? index}>
            <div>
              {typeof entry === "string" ? entry : entry.message ?? entry.error ?? entry.detail ?? "Ошибка операции"}
              {typeof entry !== "string" && entry.created_at && <div><small className="muted">{formatDateTime(entry.created_at, timezone, settings.data?.date_format)}</small></div>}
            </div>
          </div>)}
        </section>
      </div>
    </>}
    {cleanPrompt && <OperationsConfirm title="Очистить просроченные объекты?" text={`Объекты, пролежавшие в корзине больше ${settings.data?.trash_days ?? 30} дней, будут удалены окончательно. Связанные с действующими публикациями файлы сохранятся.`} label="Очистить" pending={cleaning} error={cleanupNotice?.error ? cleanupNotice.text : undefined} onClose={() => setCleanPrompt(false)} onConfirm={cleanExpired} />}
  </div>;
}

export function BackupPage() {
  const records = useStudio<BackupRecord[]>("/backups", true, 15_000);
  const settings = useStudio<StudioSettings>("/settings");
  const [source, setSource] = useState<File | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const timezone = settings.data?.timezone ?? "Europe/Minsk";
  async function exportData() {
    setNotice(null);
    setExporting(true);
    try {
      const response = await fetch("/api/export", { headers: { Accept: "application/zip" } });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(failure.error ?? "Не удалось создать резервную копию.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `remake-ai-studio-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice({ text: "Резервная копия подготовлена. Проверьте загрузки браузера." });
      void records.refetch();
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true });
    } finally {
      setExporting(false);
    }
  }
  async function restore() {
    if (!source) return;
    setNotice(null);
    setProgress(0);
    try {
      await restoreZip(source, setProgress);
      setConfirm(false);
      setSource(null);
      if (fileInput.current) fileInput.current.value = "";
      setNotice({ text: "Данные и оригиналы восстановлены." });
      void records.refetch();
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true });
    } finally {
      setProgress(null);
    }
  }
  return <div className="page ops-stack">
    <OperationsHeading title="Резервные копии" description="Скачайте переносимую копию базы данных и оригиналов либо восстановите студию из готового архива." actions={<Link className="btn" to="/system">Система <ArrowUpRight size={16} aria-hidden /></Link>} />
    {notice && !confirm && <OperationsNotice variant={notice.error ? "error" : undefined}>{notice.text}</OperationsNotice>}
    <div className="ops-info-grid">
      <section className="panel ops-section ops-stack">
        <h2>Экспорт</h2>
        <p className="muted">Браузер скачивает ZIP с настройками, рубриками, идеями, публикациями и файлами. Этот способ подходит для архива до 64 МиБ с 38 объектами или меньше.</p>
        <div className="ops-toolbar"><button className="btn primary" type="button" disabled={exporting || progress !== null} onClick={exportData}><ArrowDownToLine size={16} aria-hidden /> {exporting ? "Создаём архив…" : "Скачать ZIP"}</button></div>
      </section>
      <section className="panel ops-section ops-stack">
        <h2>Восстановление</h2>
        <p className="muted">Используйте ZIP до 64 МиБ. В чистой локальной установке восстановление доступно сразу. В облаке включите режим восстановления по инструкции BACKUP.md.</p>
        <label className="ops-field">Файл резервной копии
          <input ref={fileInput} type="file" accept=".zip,application/zip" disabled={progress !== null} onChange={event => {
            const file = event.target.files?.[0] ?? null;
            setNotice(null);
            if (file && file.size > zipLimit) {
              setNotice({ text: "Файл больше 64 МиБ. Используйте команду восстановления из документации.", error: true });
              event.target.value = "";
              setSource(null);
              return;
            }
            setSource(file);
          }} />
        </label>
        <div className="ops-toolbar"><button className="btn" type="button" disabled={!source || exporting || progress !== null} onClick={() => { setNotice(null); setConfirm(true); }}><Upload size={16} aria-hidden /> Восстановить из ZIP</button></div>
      </section>
    </div>
    <section className="panel ops-section ops-stack">
      <h2>Копирование больших библиотек</h2>
      <p className="muted">Команды экспортируют и восстанавливают файлы поэтапно. Подставьте действующий адрес студии и путь к отдельной папке. Инструкции по подготовке хранилища и проверке копии приложены в BACKUP.md.</p>
      <code className="ops-code">npm run backup -- export http://localhost:8787 ./studio-backup</code>
      <code className="ops-code">npm run backup -- restore http://localhost:8787 ./studio-backup</code>
    </section>
    <section className="panel ops-section ops-stack">
      <h2>История резервных копий</h2>
      {records.error && <OperationsNotice variant="error">{errorText(records.error)}</OperationsNotice>}
      {records.isPending && <OperationsLoading />}
      {records.data?.length === 0 && <OperationsEmpty>Здесь появятся результаты экспорта и восстановления.</OperationsEmpty>}
      {records.data?.map(record => <div className="ops-row" key={record.id}><div><strong>{formatDateTime(record.created_at, timezone, settings.data?.date_format)}</strong><small className="muted">{record.object_count} объектов{record.detail && ` · ${record.detail}`}</small></div><span className="badge">{backupStatus(record.status)}</span></div>)}
    </section>
    {confirm && <OperationsConfirm title="Восстановить студию?" text={progress === null
      ? `Архив «${source?.name}» развернётся в чистой установке. Встроенные рубрики будут заменены данными из копии.`
      : `Восстанавливаем данные и проверяем оригиналы · ${Math.round(progress * 100)}%.`}
      label="Восстановить" pending={progress !== null} error={notice?.error ? notice.text : undefined} onClose={() => { setConfirm(false); setNotice(null); }} onConfirm={restore} />}
  </div>;
}
