import { useEffect, useRef, useState, type ReactNode } from "react";
import { mediaUrl } from "../api";

export function OperationsHeading({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="ops-heading">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="ops-toolbar">{actions}</div>}
    </header>
  );
}

export function OperationsNotice({ children, variant }: { children: ReactNode; variant?: "error" | "warning" }) {
  return <div className={`ops-notice ${variant ?? ""}`} role={variant === "error" ? "alert" : "status"}>{children}</div>;
}

export function OperationsEmpty({ children }: { children: ReactNode }) {
  return <div className="ops-placeholder muted">{children}</div>;
}

export function OperationsLoading() {
  return <div className="panel ops-section" aria-busy="true" role="status"><div className="skeleton ops-loading" /><span className="muted">Загружаем данные…</span></div>;
}

export function OperationsModal({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="ops-modal"
      aria-label={label}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

export function OperationsConfirm({ title, text, label, pending, error, onClose, onConfirm }: { title: string; text: string; label: string; pending?: boolean; error?: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <OperationsModal label={title} onClose={() => { if (!pending) onClose(); }}>
      <div className="ops-modal-form">
        <h2>{title}</h2>
        <p className="muted">{text}</p>
        {error && <OperationsNotice variant="error">{error}</OperationsNotice>}
        <div className="ops-toolbar">
          <button className="btn" type="button" onClick={onClose} disabled={pending} autoFocus>Отмена</button>
          <button className="btn danger" type="button" onClick={onConfirm} disabled={pending}>{pending ? "Подождите…" : label}</button>
        </div>
      </div>
    </OperationsModal>
  );
}

export function OperationsMetric({ label, children }: { label: string; children: ReactNode }) {
  return <div className="panel ops-metric"><span className="muted">{label}</span><output>{children}</output></div>;
}

export function OperationsCover({ id, className, fallback }: { id: string | null; className: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  return id && id !== failed
    ? <img src={mediaUrl(id, true)} alt="" className={className} loading="lazy" onError={() => setFailed(id)} />
    : <span className={`${className} ops-cover-fallback`} aria-hidden>{fallback}</span>;
}

export function errorText(error: unknown, fallback = "Не удалось выполнить действие. Повторите попытку.") {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function prettyBytes(value: number) {
  if (!Number.isFinite(value) || value < 1) return "0 Б";
  const units = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const number = new Intl.NumberFormat("ru", { maximumFractionDigits: unit === 0 ? 0 : 2 }).format(value / Math.pow(1024, unit));
  return `${number} ${units[unit]}`;
}
