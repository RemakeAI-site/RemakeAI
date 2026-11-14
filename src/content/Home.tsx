import { Archive, ArrowUpRight, CalendarDays, CheckCheck, CircleCheck, Clapperboard, Clock3, FolderPlus, Layers3, Lightbulb, Plus, ScanEye, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { mediaUrl, useStudio } from '../api'
import { CategoryCard, Empty, ItemArt, LoadState, StatusBadge, dateText, metaStyle, type Category, type ListResult, type Publication, type Settings, type Status } from './shared'

const metrics = [
  ['total','Всего публикаций',Clapperboard,'#8db7ef','/publications'],
  ['ready','Готово к публикации',CircleCheck,'#43dfca','/ready'],
  ['draft','В разработке',Clock3,'#f0be71','/publications?status_id=draft'],
  ['review','На проверке',ScanEye,'#b6a7f0','/publications?status_id=review'],
  ['published','Опубликовано',CheckCheck,'#64dfa7','/archive'],
  ['ideas','Всего идей',Lightbulb,'#e8ce77','/ideas'],
  ['categories','Количество рубрик',Layers3,'#7cb9f2','/categories'],
  ['scheduled','Запланировано',CalendarDays,'#dc9be0','/calendar'],
] as const

type StatKey = typeof metrics[number][0]
type Activity = {id:string; action:string; entity_type:string; entity_id:string; created_at:string}

export default function HomePage() {
  const settings = useStudio<Settings>('/settings')
  const statistics = useStudio<Record<StatKey,number>>('/stats')
  const categories = useStudio<Category[]>('/categories')
  const ready = useStudio<ListResult<Publication>>('/publications?ready=1&limit=6')
  const activity = useStudio<Activity[]>('/activity')
  const statuses = useStudio<Status[]>('/statuses')
  const next = useStudio<ListResult<Publication>>('/publications?status_id=scheduled&limit=6&sort=scheduled')
  const logo = settings.data?.logo_media_id
  const zone = settings.data?.timezone
  const dateFormat = settings.data?.date_format
  const categoryItems = categories.data?.filter(item => !item.parent_id && !item.is_hidden && !item.is_archived)
  return <div className="page">
    <section className="hero" aria-labelledby="dashboard-title">
      <div className="hero-content"><div className="eyebrow">Content Management System</div><h1 id="dashboard-title">Твоя студия контента</h1><p>Все идеи, публикации и материалы в одном месте.</p>
        <div className="actions"><Link className="btn primary" to="/publications/new"><Plus size={17}/>Новая публикация</Link><Link className="btn ghost hero-link" to="/publications">Библиотека <ArrowUpRight size={15}/></Link></div>
      </div>
      <div className="hero-art" aria-hidden><span className="hero-orbit"/><span className="star"/><span className="star right"/><img src={logo ? mediaUrl(logo,true) : '/brand/logo.webp'} alt="" /></div>
    </section>
    <nav className="shortcuts" aria-label="Быстрые действия">
      <Link className="btn ghost small" to="/categories/new"><FolderPlus size={15}/>Новая рубрика</Link>
      <Link className="btn ghost small" to="/ideas/new"><Lightbulb size={15}/>Новая идея</Link>
      <Link className="btn ghost small" to="/calendar"><CalendarDays size={15}/>Календарь</Link>
    </nav>
    <section className="grid metrics" aria-label="Статистика контента">
      {metrics.map(([key,label,Icon,color,route]) => <Link to={route} className="panel metric" key={key} style={metaStyle('--tone',color)}>
        <strong>{statistics.data?.[key] ?? '—'}</strong><span className="metric-icon"><Icon size={15} aria-hidden/></span><span>{label}</span>
      </Link>)}
    </section>
    <LoadState error={statistics.error}/>
    <section className="section">
      <header className="section-heading"><div><h2>Рубрики</h2><p className="muted">Готовые выпуски и идеи по каждой рубрике</p></div><Link className="link-action" to="/categories">Все рубрики <ArrowUpRight size={15}/></Link></header>
      <LoadState pending={categories.isPending} error={categories.error}/>
      {!!categoryItems?.length && <div className="grid category-grid">{categoryItems.map(category => <CategoryCard key={category.id} category={category}/>)}</div>}
      {categoryItems?.length === 0 && <Empty title="Пока нет рубрик" icon="folder"><Link to="/categories/new" className="btn primary">Создать рубрику</Link></Empty>}
    </section>
    <section className="section">
      <header className="section-heading"><h2>Готово к публикации</h2><Link className="link-action" to="/ready">Открыть подборку <ArrowUpRight size={15}/></Link></header>
      <LoadState pending={ready.isPending} error={ready.error}/>
      {ready.data?.items.length === 0 && <Empty icon="video" title="Готовых выпусков пока нет" description="Выпуски появятся здесь после смены статуса на «Готово»."/>}
      {!!ready.data?.items.length && <div className="grid collection-grid">{ready.data.items.map(item => <Link to={'/publications/'+item.id} key={item.id} className="panel item-card">
        <ItemArt cover={item.cover_media_id}/><div className="item-body"><StatusBadge status={statuses.data?.find(status => status.id===item.status_id)}/><h3>{item.title}</h3></div>
      </Link>)}</div>}
    </section>
    <div className="section grid dash-columns">
      <section className="panel"><div className="section-heading"><h2>Ближайшие публикации</h2><Link className="link-action" to="/calendar"><CalendarDays size={15}/>Календарь</Link></div>
        <LoadState pending={next.isPending} error={next.error}/>
        {next.data?.items.length===0 && <p className="muted">Нет запланированных выпусков.</p>}
        {next.data?.items.map(item => <Link className="dash-row" to={'/publications/'+item.id} key={item.id}><Sparkles size={14}/><span>{item.title}</span><small>{dateText(item.scheduled_at,zone,dateFormat)}</small></Link>)}
      </section>
      <section className="panel"><div className="section-heading"><h2>Последние изменения</h2></div>
        <LoadState pending={activity.isPending} error={activity.error}/>
        {activity.data?.length===0 && <p className="muted">Действий пока нет.</p>}
        {activity.data?.slice(0,8).map(item => <div className="dash-row" key={item.id}><Archive size={14}/><span>{item.action}</span><small>{dateText(item.created_at,zone,dateFormat)}</small></div>)}
      </section>
    </div>
  </div>
}
