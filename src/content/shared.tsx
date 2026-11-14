import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Archive, Clapperboard, Film, Folder, ImageIcon, Lightbulb, Moon, MountainSnow, PackageOpen, Sparkles, TrainFront, X, Search, Trees, WandSparkles, MessageCircleQuestion, Camera, Clock3 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { mediaUrl } from '../api'

export type Category = {
  id: string
  parent_id: string | null
  name: string
  description: string
  cover_media_id: string | null
  icon: string
  color: string
  sort_order: number
  is_hidden: number | boolean
  is_archived: number | boolean
  description_limit: number | null
  version: number
  ready_count: number
  total_count: number
  published_count: number
  idea_count: number
  indicator_count: number
  indicator_color: string
  indicator_label: string
  path?: string[]
}

export type Media = {
  id: string
  attachment_id: string
  original_filename: string
  mime_type: string
  file_size: number
  format?: string
  sha256: string
  media_type: string
  width?: number
  height?: number
  duration?: number
  sort_order: number
  preview_storage_key?: string
}

export type Publication = {
  id: string
  title: string
  description: string
  category_id: string | null
  category_name?: string
  status_id: string
  hashtags: string
  cover_media_id: string | null
  is_favorite: boolean | number
  scenario: string
  notes: string
  scheduled_at: string | null
  published_at: string | null
  created_at: string
  updated_at: string
  tiktok_url: string | null
  version: number
  media?: Media[]
  custom_fields?: Record<string, string | number | boolean | null>
}

export type Idea = {
  id: string
  title: string
  description: string
  category_id: string | null
  category_name?: string
  status: string
  priority: string
  is_favorite: boolean | number
  scenario: string
  notes: string
  links?: string[]
  media?: Media[]
  publication_id?: string | null
  version: number
}

export type Status = {id: string; name: string; color: string; sort_order: number}
export type Settings = {
  name: string
  logo_media_id: string | null
  text_limit: number
  theme: string
  density: string
  accent: string
  timezone: string
  date_format: string
}
export type CustomField = {id: string; name: string; type: string; options: string[]}
export type ListResult<T> = {items: T[]; total: number; page: number; limit: number}
export const ideaStatuses = [['new', 'Новая'], ['developing', 'В разработке'], ['selected', 'Отобрана'], ['realized', 'Реализована'], ['archived', 'Архивирована']]
export const priorities = [['low', 'Низкий'], ['medium', 'Средний'], ['high', 'Высокий']]

const categoryIcons = {
  archive: Archive, files: Archive, sparkles: Sparkles, moon: Moon, train: TrainFront, globe: Trees,
  quotation: MessageCircleQuestion, shapes: PackageOpen, message: MessageCircleQuestion, wand: WandSparkles,
  clock: Clock3, lightbulb: Lightbulb, folder: Folder, camera: Camera, mountain: MountainSnow,
}
export const categoryIconOptions = Object.keys(categoryIcons)
export const metaStyle = (variable: string, value: string | undefined) => ({[variable]: value}) as CSSProperties

export function categoryName(category?: Category) {
  return category?.path?.join(' › ') || category?.name || 'Вне рубрики'
}

export function CategoryOptions({categories, empty = 'Без рубрики'}: {categories: Category[]; empty?: string}) {
  return <><option value="">{empty}</option>{categories.map(category => <option key={category.id} value={category.id}>{categoryName(category)}</option>)}</>
}

export function CategoryCover({category}: {category: Category}) {
  const Symbol = categoryIcons[category.icon as keyof typeof categoryIcons] || Folder
  return <div className={category.cover_media_id ? 'category-cover has-image' : 'category-cover'} style={metaStyle('--tile', category.color)}>
    {category.cover_media_id ? <img src={mediaUrl(category.cover_media_id, true)} alt="" loading="lazy" /> : <Symbol className="cover-symbol" size={38} strokeWidth={1.25} aria-hidden />}
    <strong>{category.name}</strong>
  </div>
}

export function CategoryCard({category}: {category: Category}) {
  return <Link to={'/categories/'+category.id} className="category-card" aria-label={category.name}>
    <CategoryCover category={category} />
    <div className="category-card-body">
      <p>{category.description || 'Описание пока не добавлено'}</p>
      <div className="category-card-meta">
        <span title={category.indicator_label} className="badge" style={metaStyle('--badge-color', category.indicator_color)}><span className="dot" />{category.indicator_label || 'Остаток'} · {category.indicator_count ?? 0}</span>
        <small>{category.ready_count ?? 0} готово</small>
        <small>{category.total_count ?? 0} всего</small>
        <small>{category.published_count ?? 0} опубликовано</small>
        <small>{category.idea_count ?? 0} идей</small>
      </div>
    </div>
  </Link>
}
export function StatusBadge({status, fallback}: {status?: Status; fallback?: string}) {
  return <span className="badge" style={metaStyle('--badge-color', status?.color)}><span className="dot"/>{status?.name || fallback || 'Статус не указан'}</span>
}

export function Empty({title, description, children, icon = 'image'}: {title: string; description?: string; children?: ReactNode; icon?: 'image'|'idea'|'video'|'folder'}) {
  const Icon = {image: ImageIcon, idea: Lightbulb, video: Clapperboard, folder: Folder}[icon]
  return <div className="panel empty"><span className="empty-icon"><Icon size={20} aria-hidden /></span><h3>{title}</h3>{description && <p>{description}</p>}{children}</div>
}
export function LoadState({pending, error}: {pending?: boolean; error?: unknown}) {
  return pending ? <div className="panel skeleton" role="status" aria-label="Загрузка" /> : error ? <div className="error-box" role="alert">{errorMessage(error)}</div> : null
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Произошла ошибка. Повторите попытку.')
}

export function PageHeading({title, description, actions}: {title: string; description?: string; actions?: ReactNode}) {
  return <header className="page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="actions">{actions}</div>}</header>
}
export function SearchField({value, change, label = 'Поиск', placeholder = 'Поиск…', autofocus = false}: {value: string; change: (value: string) => void; label?: string; placeholder?: string; autofocus?: boolean}) {
  return <label className="search-input filter-field"><Search size={16} aria-hidden /><input aria-label={label} value={value} onChange={event => change(event.target.value)} placeholder={placeholder} autoFocus={autofocus} /></label>
}

export function Modal({title, close, children, wide = false}: {title: string; close: () => void; children: ReactNode; wide?: boolean}) {
  const label = useId()
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close)
  useEffect(() => {closeRef.current = close}, [close])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const first = ref.current?.querySelector<HTMLElement>('input:not([type=hidden]),button,select,textarea,a[href]')
    first?.focus()
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {event.preventDefault(); closeRef.current()}
      if (event.key !== 'Tab') return
      const controls = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])]
      if (!controls.length) return
      const start = controls[0]
      const end = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === start) {event.preventDefault(); end.focus()}
      else if (!event.shiftKey && document.activeElement === end) {event.preventDefault(); start.focus()}
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [])
  return <div className="dialog-backdrop" onMouseDown={event => {if (event.currentTarget === event.target) close()}}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={label} className={wide ? 'dialog wide' : 'dialog'}>
      <header className="dialog-header"><h2 id={label}>{title}</h2><button className="btn icon ghost" type="button" aria-label="Закрыть" onClick={close}><X size={18} /></button></header>
      {children}
    </div>
  </div>
}

export function Pagination<T>({result, change}: {result?: ListResult<T>; change: (page: number) => void}) {
  if (!result || !result.total || result.total <= result.limit) return null
  const pages = Math.ceil(result.total / result.limit)
  return <div className="pagination actions"><button className="btn ghost" disabled={result.page <= 1} onClick={() => change(result.page - 1)}>Назад</button><span>{result.page} из {pages} · {result.total}</span><button className="btn ghost" disabled={result.page >= pages} onClick={() => change(result.page + 1)}>Далее</button></div>
}
export function toLocalDate(value: string | null | undefined, zone: string) {
  if (!value) return ''
  return new Intl.DateTimeFormat('sv-SE', {timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(new Date(value)).replace(' ', 'T')
}
export function fromLocalDate(value: string, zone: string) {
  if (!value) return null
  const target = Date.parse(value+'Z')
  let date = target
  for (let retry = 0; retry < 3; retry++) {
    const offset = target - Date.parse(toLocalDate(new Date(date).toISOString(), zone)+'Z')
    if (offset === 0) break
    date += offset
  }
  if (toLocalDate(new Date(date).toISOString(), zone) !== value) throw new Error('Это локальное время недоступно в выбранном часовом поясе.')
  return new Date(date).toISOString()
}
export function dateText(value: string | undefined | null, zone = 'Europe/Minsk', format?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (format === 'yyyy-MM-dd') return toLocalDate(value, zone).replace('T', ' ')
  if (format === 'dd/MM/yyyy') return new Intl.DateTimeFormat('ru-RU', {timeZone: zone, dateStyle:'short', timeStyle:'short'}).format(date).replace(/\./g, '/')
  return new Intl.DateTimeFormat('ru-RU', {timeZone: zone, dateStyle:'short', timeStyle:'short'}).format(date)
}
export function ItemArt({cover, video = false}: {cover?: string | null; video?: boolean}) {
  const [failedCover, setFailedCover] = useState<string | null>(null)
  return <div className="item-art" aria-hidden>{cover && failedCover !== cover ? <img loading="lazy" src={mediaUrl(cover, true)} alt="" onError={() => setFailedCover(cover)} /> : video ? <Film size={31} /> : <ImageIcon size={29} />}</div>
}
