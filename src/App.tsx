import { lazy, Suspense, useEffect, useState, type ComponentType, type CSSProperties } from 'react'
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { Archive, ArrowRight, CalendarDays, ChartNoAxesCombined, Clapperboard, CloudUpload, Film, Folder, House, Layers3, Lightbulb, Menu, Plus, Search, Settings2, Sparkles, Trash2 } from 'lucide-react'
import { mediaUrl, studioClient, useStudio } from './api'
import HomePage from './content/Home'
import { Feedback } from './content/feedback'
import { Empty, LoadState, Modal, SearchField, type Category, type Idea, type Publication, type Settings } from './content/shared'

const CategoriesPage = lazy(() => import('./content/Categories').then(module => ({default: module.CategoriesPage})))
const CategoryEditor = lazy(() => import('./content/Categories').then(module => ({default: module.CategoryEditor})))
const PublicationsPage = lazy(() => import('./content/Publications').then(module => ({default: module.PublicationsPage})))
const PublicationEditor = lazy(() => import('./content/Publications').then(module => ({default: module.PublicationEditor})))
const IdeasPage = lazy(() => import('./content/Ideas').then(module => ({default: module.IdeasPage})))
const IdeaEditor = lazy(() => import('./content/Ideas').then(module => ({default: module.IdeaEditor})))
const operation = (name: 'CalendarPage'|'ArchivePage'|'TrashPage'|'SettingsPage'|'SystemPage'|'BackupPage') => lazy(() => import('./operations/Operations').then(module => ({default: module[name] as ComponentType})))
const CalendarPage = operation('CalendarPage')
const ArchivePage = operation('ArchivePage')
const TrashPage = operation('TrashPage')
const SettingsPage = operation('SettingsPage')
const SystemPage = operation('SystemPage')
const BackupPage = operation('BackupPage')

const mainLinks = [
  ['/', 'Главная', House], ['/categories', 'Рубрики', Layers3], ['/publications', 'Публикации', Clapperboard],
  ['/ideas', 'Идеи', Lightbulb], ['/calendar', 'Календарь', CalendarDays], ['/ready', 'Готово к публикации', Sparkles],
  ['/archive', 'Архив', Archive],
] as const
const serviceLinks = [
  ['/system', 'Система', ChartNoAxesCombined], ['/settings', 'Настройки', Settings2],
  ['/backup', 'Резервные копии', CloudUpload], ['/trash', 'Корзина', Trash2],
] as const

function Brand({settings}: {settings?: Settings}) {
  const name = settings?.name || 'REMAKE AI STUDIO'
  const custom = Boolean(settings?.logo_media_id)
  return <Link to="/" className="brand" aria-label={name + '. Главная'}>
    <img className="brand-mark" src={custom ? mediaUrl(settings?.logo_media_id ?? '', true) : '/brand/logo.webp'} alt="" width={43} height={43} />
    <span className="brand-text"><strong>{name === 'REMAKE AI STUDIO' ? 'REMAKE AI' : name}</strong><small>{name === 'REMAKE AI STUDIO' ? 'STUDIO' : 'CONTENT STUDIO'}</small></span>
  </Link>
}

type NavItem = (typeof mainLinks)[number] | (typeof serviceLinks)[number]
function Navigation({item, close}: {item: NavItem; close?: () => void}) {
  const [route, label, Icon] = item
  return <NavLink className="nav-link" end={route === '/'} to={route} onClick={close}><Icon size={17} strokeWidth={1.7} aria-hidden /><span>{label}</span></NavLink>
}

function GlobalSearch({close}: {close: () => void}) {
  const [text, setText] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => {const timer = window.setTimeout(() => setTerm(text.trim()), 240); return () => window.clearTimeout(timer)}, [text])
  const results = useStudio<{categories: Category[]; publications: Publication[]; ideas: Idea[]}>('/search?q='+encodeURIComponent(term), term.length > 0)
  const groups = results.data ? [
    ...results.data.categories.map(item => ({id:item.id, title:item.name, path:'/categories/', Icon:Folder})),
    ...results.data.publications.map(item => ({id:item.id, title:item.title, path:'/publications/', Icon:Film})),
    ...results.data.ideas.map(item => ({id:item.id, title:item.title, path:'/ideas/', Icon:Lightbulb})),
  ] : []
  return <Modal title="Поиск по студии" close={close}><div className="stack"><SearchField value={text} change={setText} label="Найти рубрику, публикацию или идею" autofocus />
    {term && <LoadState pending={results.isPending} error={results.error} />}
    <div className="dialog-search">{groups.map(({id,title,path,Icon}) => <Link className="search-result" key={path+id} to={path+id} onClick={close}><Icon size={17}/>{title}<ArrowRight size={15} style={{marginLeft:'auto'}}/></Link>)}</div>
    {term && results.data && !groups.length && <p className="muted">По вашему запросу ничего не найдено.</p>}
  </div></Modal>
}

function Shell() {
  const [modal, setModal] = useState<'create'|'search'|'menu'|null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const {data: settings} = useStudio<Settings>('/settings')
  const {pathname} = useLocation()
  const zone = settings?.timezone || 'Europe/Minsk'
  const date = new Intl.DateTimeFormat('ru-RU', {timeZone:zone, weekday:'long', day:'numeric', month:'long'}).format(Date.now())
  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    const hotkeys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {event.preventDefault(); setModal('search')}
    }
    window.addEventListener('online', updateOnline); window.addEventListener('offline', updateOnline)
    window.addEventListener('keydown', hotkeys)
    return () => {window.removeEventListener('online',updateOnline); window.removeEventListener('offline',updateOnline); window.removeEventListener('keydown',hotkeys)}
  }, [])
  useEffect(() => {window.scrollTo(0, 0)}, [pathname])
  useEffect(() => {
    const theme = matchMedia('(prefers-color-scheme: light)')
    function apply() {
      document.documentElement.dataset.theme = settings?.theme === 'system' ? (theme.matches ? 'light' : 'dark') : (settings?.theme || 'dark')
      document.documentElement.dataset.density = settings?.density || 'comfortable'
    }
    apply()
    theme.addEventListener('change',apply)
    return () => theme.removeEventListener('change',apply)
  }, [settings?.density,settings?.theme])
  const close = () => setModal(null)
  const accent = settings?.accent || '#29dcd1'
  const colors = /^#[a-f\d]{6}$/i.test(accent) ? accent.slice(1).match(/../g)?.map(component => parseInt(component,16)).join(', ') : undefined
  return <div className="app-shell" style={{'--accent':accent,'--accent-rgb':colors} as CSSProperties}>
    <a className="skip-link btn primary" href="#main">К содержанию</a>
    <aside className="sidebar" aria-label="Навигация">
      <Brand settings={settings}/>
      <nav className="sidebar-nav"><span className="nav-label">Студия</span>
        {mainLinks.map(item => <Navigation item={item} key={item[0]} />)}
        <span className="nav-label">Управление</span>
        {serviceLinks.map(item => <Navigation item={item} key={item[0]} />)}
      </nav>
      <div className="sidebar-foot"><div className="sidebar-profile"><span className="profile-icon"><Sparkles size={17}/></span><div><strong>@remake.ai.by</strong><small>Рабочее пространство</small></div></div></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="top-mobile-brand"><Brand settings={settings}/></div>
        <span className="top-date"><CalendarDays size={15} /><span style={{textTransform:'capitalize'}}>{date}</span></span>
        <div className="topbar-controls">
          <button className="top-search" type="button" aria-label="Поиск по студии" onClick={() => setModal('search')}><Search size={16}/><span>Поиск по студии</span><kbd>Ctrl K</kbd></button>
          <button className="btn primary top-add" type="button" onClick={() => setModal('create')}><Plus size={17}/>Создать</button>
          <button className="btn ghost icon top-more" type="button" aria-label="Все разделы" onClick={() => setModal('menu')}><Menu size={18}/></button>
        </div>
      </header>
      {!online && <div className="online-banner" role="status">Нет подключения. Проверьте интернет, чтобы открыть материалы и сохранить изменения.</div>}
      <main id="main">
        <Suspense fallback={<div className="page"><LoadState pending /></div>}>
          <Routes>
            <Route index element={<HomePage/>}/>
            <Route path="categories" element={<CategoriesPage/>}/>
            <Route path="categories/new" element={<CategoryEditor key="new-category"/>}/>
            <Route path="categories/:id" element={<CategoryEditor/>}/>
            <Route path="publications" element={<PublicationsPage/>}/>
            <Route path="publications/new" element={<PublicationEditor key="new-publication"/>}/>
            <Route path="publications/:id" element={<PublicationEditor/>}/>
            <Route path="ready" element={<PublicationsPage ready/>}/>
            <Route path="ideas" element={<IdeasPage/>}/>
            <Route path="ideas/new" element={<IdeaEditor key="new-idea"/>}/>
            <Route path="ideas/:id" element={<IdeaEditor/>}/>
            <Route path="calendar" element={<CalendarPage/>}/>
            <Route path="archive" element={<ArchivePage/>}/>
            <Route path="trash" element={<TrashPage/>}/>
            <Route path="settings" element={<SettingsPage/>}/>
            <Route path="system" element={<SystemPage/>}/>
            <Route path="backup" element={<BackupPage/>}/>
            <Route path="*" element={<div className="page"><Empty title="Страница не найдена"><Link className="btn primary" to="/">На главную</Link></Empty></div>}/>
          </Routes>
        </Suspense>
      </main>
    </div>
    <nav className="mobile-nav" aria-label="Основная навигация">
      <Navigation item={mainLinks[0]}/><Navigation item={mainLinks[1]}/>
      <button className="mobile-add" type="button" onClick={() => setModal('create')}><span><Plus size={19}/></span>Добавить</button>
      <Navigation item={mainLinks[3]}/><Navigation item={serviceLinks[1]}/>
    </nav>
    {modal==='search' && <GlobalSearch close={close}/>}
    {modal==='menu' && <Modal title="Разделы студии" close={close}>
      <nav className="create-menu" aria-label="Все разделы">{[...mainLinks,...serviceLinks].map(item => <Navigation item={item} close={close} key={item[0]}/>)}</nav>
    </Modal>}
    {modal==='create' && <Modal title="Что добавить?" close={close}><div className="create-menu">
      <Link to="/publications/new" className="btn" onClick={close}><Clapperboard size={18}/>Новая публикация<ArrowRight size={16} style={{marginLeft:'auto'}}/></Link>
      <Link to="/categories/new" className="btn" onClick={close}><Folder size={18}/>Новая рубрика<ArrowRight size={16} style={{marginLeft:'auto'}}/></Link>
      <Link to="/ideas/new" className="btn" onClick={close}><Lightbulb size={18}/>Новая идея<ArrowRight size={16} style={{marginLeft:'auto'}}/></Link>
    </div></Modal>}
  </div>
}

export default function App() {
  return <QueryClientProvider client={studioClient}><BrowserRouter><Feedback><Shell/></Feedback></BrowserRouter></QueryClientProvider>
}
