import { useRef, useState, type FormEvent } from 'react'
import { Archive, ArrowDown, ArrowUp, ChevronRight, Folder, Grid2X2, Grid3X3, ImagePlus, LayoutList, Plus, Trash2 } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, mediaUrl, useStudio, uploadOriginal } from '../api'
import { useToast } from './feedback'
import { CategoryCard, CategoryCover, CategoryOptions, type Category as CategoryType, Empty, LoadState, Modal, PageHeading, SearchField, categoryIconOptions, errorMessage } from './shared'

type Filters = {visibility:'active'|'all'|'hidden'|'archived'; sort:'manual'|'name'|'ready'|'total'; view:'tile'|'compact'|'list'}
const viewModes = [['tile','Плитка',Grid2X2],['compact','Компактно',Grid3X3],['list','Список',LayoutList]] as const

export function CategoriesPage() {
  const data = useStudio<CategoryType[]>('/categories')
  const [text,setText] = useState('')
  const [filters,setFilters] = useState<Filters>({visibility:'active',sort:'manual',view:'tile'})
  const count = (data.data || []).filter(category => !category.parent_id).length
  const term = text.trim().toLocaleLowerCase('ru')
  const categories = (data.data || []).filter(category => {
    const match = !term || [category.name,category.description,...(category.path || [])].some(value => value?.toLocaleLowerCase('ru').includes(term))
    if (!match) return false
    if (filters.visibility === 'hidden') return category.is_hidden
    if (filters.visibility === 'archived') return category.is_archived
    if (filters.visibility === 'all') return true
    return !category.is_hidden && !category.is_archived && (!category.parent_id || !!term)
  }).sort((left,right) => {
    if (filters.sort === 'name') return left.name.localeCompare(right.name,'ru')
    if (filters.sort === 'ready') return right.ready_count-left.ready_count
    if (filters.sort === 'total') return right.total_count-left.total_count
    return left.sort_order-right.sort_order
  })
  return <div className="page">
    <PageHeading title="Рубрики" description={data.data ? `Основных рубрик · ${count}` : undefined} actions={<Link className="btn primary" to="/categories/new"><Plus size={17}/>Новая рубрика</Link>}/>
    <div className="toolbar">
      <SearchField value={text} change={setText} label="Поиск рубрик" placeholder="Найти рубрику…"/>
      <label className="field"><span className="sr-only">Видимость</span><select value={filters.visibility} onChange={e => setFilters({...filters,visibility:e.target.value as Filters['visibility']})}><option value="active">Активные</option><option value="all">Все рубрики</option><option value="hidden">Скрытые</option><option value="archived">Архивные</option></select></label>
      <label className="field"><span className="sr-only">Сортировка</span><select value={filters.sort} onChange={e => setFilters({...filters,sort:e.target.value as Filters['sort']})}><option value="manual">Ручной порядок</option><option value="name">По названию</option><option value="ready">По готовым</option><option value="total">По публикациям</option></select></label>
      <div className="segment" aria-label="Вид рубрик">{viewModes.map(([id,label,Icon]) => <button className="btn icon small" aria-pressed={filters.view===id} aria-label={label} title={label} key={id} onClick={() => setFilters({...filters,view:id})}><Icon size={16}/></button>)}</div>
    </div>
    <LoadState pending={data.isPending} error={data.error}/>
    {!!categories.length && <div className={'grid category-grid '+filters.view}>{categories.map(category => <CategoryCard key={category.id} category={category}/>)}</div>}
    {data.data && !categories.length && <Empty title="Рубрики не найдены" description="Проверьте запрос или выберите другой фильтр." icon="folder"/>}
  </div>
}

type CategoryForm = {name:string; description:string; parent_id:string; color:string; icon:string; sort_order:number; is_hidden:boolean; is_archived:boolean; description_limit:string}
const iconNames: Record<string,string> = {archive:'Архив',files:'Документы',sparkles:'Искры',moon:'Луна',train:'Поезд',globe:'Природа',quotation:'Фраза',shapes:'Предметы',message:'Вопрос',wand:'Волшебная палочка',clock:'Время',lightbulb:'Идея',folder:'Папка',camera:'Камера',mountain:'Горы'}
const toForm = (item?: CategoryType, parent = ''): CategoryForm => ({
  name: item?.name || '', description:item?.description || '', parent_id:item?.parent_id || parent,
  color:item?.color || '#29dcd1', icon:item?.icon || 'folder', sort_order:item?.sort_order || 0,
  is_hidden:!!item?.is_hidden, is_archived:!!item?.is_archived, description_limit:String(item?.description_limit ?? ''),
})
function CategoryFormPage({item,categories,parent}: {item?:CategoryType; categories:CategoryType[]; parent:string}) {
  const navigate = useNavigate()
  const notify = useToast()
  const [draft, setDraft] = useState<{form:CategoryForm;version:number}|null>(null)
  const [working,setWorking] = useState(false)
  const [error,setError] = useState<unknown>(null)
  const [cover,setCover] = useState<File>()
  const [percent,setPercent] = useState<number>()
  const abort = useRef<AbortController|null>(null)
  const [deleteOpen,setDeleteOpen] = useState(false)
  const [deleteMode,setDeleteMode] = useState<'trash'|'move'|'archive'>('trash')
  const [destination,setDestination] = useState('')
  const values = draft?.form || toForm(item,parent)
  const version = draft?.version ?? item?.version ?? 0
  const isStale = Boolean(item && draft && draft.version !== item.version)
  const children = categories.filter(category => category.parent_id===item?.id)
  const byId = new Map(categories.map(category => [category.id,category]))
  const canParent = (category: CategoryType) => {
    for (let branch:CategoryType|undefined=category; branch; branch=branch.parent_id ? byId.get(branch.parent_id) : undefined) if (branch.id===item?.id) return false
    return true
  }
  const available = categories.filter(canParent)
  const parents:CategoryType[] = []
  for (let next = item?.parent_id; next;) {
    const parentItem = byId.get(next)
    if (!parentItem) break
    parents.unshift(parentItem)
    next = parentItem.parent_id
  }
  function set<K extends keyof CategoryForm>(key:K,value:CategoryForm[K]) {
    setDraft({form:{...values,[key]:value},version})
  }
  async function changeCover(file:File,id:string) {
    const controller = new AbortController()
    abort.current = controller
    setPercent(0)
    try {
      await uploadOriginal(file,{target_type:'category',target_id:id},setPercent,controller.signal)
      setCover(undefined)
      notify('Обложка сохранена')
    } finally {
      abort.current = null
      setPercent(undefined)
    }
  }
  async function save(event:FormEvent) {
    event.preventDefault()
    setWorking(true)
    setError(null)
    try {
      const body = {...values, parent_id:values.parent_id || null, description_limit:values.description_limit ? Number(values.description_limit):null, version}
      const result = await api<CategoryType>(item ? '/categories/'+item.id : '/categories',{method:item?'PATCH':'POST',body:JSON.stringify(body)})
      setDraft(null)
      if (!item) {
        navigate('/categories/'+result.id,{replace:true})
        notify('Рубрика создана')
        if (cover) { try {await changeCover(cover,result.id)} catch (cause) {notify('Рубрика сохранена. '+errorMessage(cause), true)} }
      } else {
        notify('Рубрика сохранена')
        if (cover) await changeCover(cover,result.id)
      }
    } catch (cause) {setError(cause)} finally {setWorking(false)}
  }
  async function perform(action: () => Promise<unknown>, success: string) {
    setWorking(true); setError(null)
    try {await action(); notify(success)} catch(cause) {setError(cause); notify(cause,true)} finally {setWorking(false)}
  }
  const listPath = (type: string) => `/${type}?category_id=${encodeURIComponent(item?.id || '')}`
  return <div className="page">
    <nav className="breadcrumb" aria-label="Путь рубрики"><Link to="/categories">Рубрики</Link>{parents.map(ancestor => <span key={ancestor.id}><ChevronRight size={14}/> <Link to={'/categories/'+ancestor.id}>{ancestor.name}</Link></span>)}{item && <span><ChevronRight size={14}/> {item.name}</span>}</nav>
    <PageHeading title={item?.name || 'Новая рубрика'} actions={item && <>
      <Link className="btn primary" to={'/publications/new?category_id='+item.id}><Plus size={17}/>Публикация</Link>
      <Link className="btn ghost" to={'/categories/new?parent_id='+item.id}><Plus size={17}/>Подрубрика</Link>
    </>}/>
    {isStale && <p className="notice" role="status">Рубрику изменили в другом окне. Ваши правки остались в форме. <button className="link-action" onClick={() => setDraft(null)}>Открыть текущую версию</button></p>}
    <LoadState error={error}/>
    <form className="grid editor-grid" onSubmit={save}>
      <section className="panel stack">
        <h2>Параметры рубрики</h2>
        <div className="form-grid">
          <label className="field full"><span>Название рубрики</span><input value={values.name} onChange={event => set('name',event.target.value)} required maxLength={180}/></label>
          <label className="field full"><span>Описание рубрики</span><textarea value={values.description} onChange={event => set('description',event.target.value)} rows={4} /></label>
          <label className="field full"><span>Родительская рубрика</span><select value={values.parent_id} onChange={event => set('parent_id',event.target.value)}><CategoryOptions categories={available} empty="Верхний уровень"/></select></label>
          <label className="field"><span>Цвет обложки</span><input type="color" value={values.color} onChange={event => set('color',event.target.value)}/></label>
          <label className="field"><span>Иконка</span><select value={values.icon} onChange={event => set('icon',event.target.value)}>{!categoryIconOptions.includes(values.icon) && <option value={values.icon}>Фирменная иконка</option>}{categoryIconOptions.map(icon => <option value={icon} key={icon}>{iconNames[icon] || icon}</option>)}</select></label>
          <label className="field"><span>Порядок</span><input type="number" step="1" value={values.sort_order} onChange={event => set('sort_order',Number(event.target.value))}/></label>
          <label className="field"><span>Лимит описания TikTok</span><input type="number" min="1" placeholder="Общий лимит" value={values.description_limit} onChange={event => set('description_limit',event.target.value)}/></label>
          <label className="checkbox-line"><input type="checkbox" checked={values.is_hidden} onChange={event => set('is_hidden',event.target.checked)}/> Скрыть рубрику</label>
          <label className="checkbox-line"><input type="checkbox" checked={values.is_archived} onChange={event => set('is_archived',event.target.checked)}/> Архивировать рубрику</label>
        </div>
        <div className="actions">
          <button className="btn primary" type="submit" disabled={working || isStale}>{item?'Сохранить рубрику':'Создать рубрику'}</button>
          {item && <button className="btn danger" type="button" disabled={working} onClick={() => setDeleteOpen(true)}><Trash2 size={16}/>Удалить</button>}
        </div>
      </section>
      <aside className="panel stack">
        <h2>Обложка</h2>
        {item?.cover_media_id ? <img className="cover-thumb" src={mediaUrl(item.cover_media_id,true)} alt="Обложка рубрики"/> : item && <CategoryCover category={item}/>}
        <label className="field"><span><ImagePlus size={16}/> {item?.cover_media_id?'Заменить обложку':'Выбрать обложку'}</span><input type="file" accept="image/*,.heic,.heif" disabled={working} onChange={event => {setCover(event.target.files?.[0]); event.target.value=''}}/></label>
        {cover && <p className="muted" style={{overflowWrap:'anywhere'}}>{cover.name}</p>}
        {percent!==undefined && <div className="actions"><progress max="100" value={percent} aria-label="Загрузка обложки"/><button type="button" className="btn ghost small" onClick={() => abort.current?.abort()}>Отменить</button></div>}
        {cover && item && <button className="btn" type="button" disabled={working} onClick={() => perform(() => changeCover(cover,item.id),'Файл загружен')}>Загрузить обложку</button>}
        {item?.cover_media_id && <button className="btn danger" type="button" disabled={working} onClick={() => {
          if (window.confirm('Переместить обложку рубрики в корзину?')) void perform(() => api('/media/cover',{method:'PATCH',body:JSON.stringify({target_type:'category',target_id:item.id,media_id:null})}),'Обложка в корзине')
        }}>Удалить обложку</button>}
        {item && <div className="actions"><button className="btn icon ghost" type="button" aria-label="Выше в списке" disabled={working} onClick={() => set('sort_order',values.sort_order-1)}><ArrowUp size={16}/></button><button className="btn icon ghost" type="button" aria-label="Ниже в списке" disabled={working} onClick={() => set('sort_order',values.sort_order+1)}><ArrowDown size={16}/></button></div>}
      </aside>
    </form>
    {item && <>
      <section className="section panel"><div className="section-heading"><h2>Материалы рубрики</h2><div className="actions"><Link className="btn ghost" to={listPath('publications')}>Публикации · {item.total_count ?? 0}</Link><Link className="btn ghost" to={listPath('ideas')}>Идеи · {item.idea_count ?? 0}</Link><Link className="btn ghost" to={'/ideas/new?category_id='+item.id}><Plus size={15}/>Идея</Link></div></div><p className="muted">{item.ready_count ?? 0} готово · {item.published_count ?? 0} опубликовано</p></section>
      <section className="section"><header className="section-heading"><h2>Подрубрики</h2><Link to={'/categories/new?parent_id='+item.id} className="link-action"><Plus size={16}/>Добавить</Link></header>
        {children.length ? <div className="grid category-grid">{children.map(child => <CategoryCard category={child} key={child.id}/>)}</div> : <Empty title="Подрубрик пока нет" icon="folder"/>}
      </section>
    </>}
    {deleteOpen && item && <Modal title="Как поступить с материалами?" close={() => setDeleteOpen(false)}><div className="stack">
      <p className="muted">Действие относится к рубрике «{item.name}», её дочерним разделам, публикациям и идеям.</p>
      <label className="field"><span>Действие</span><select value={deleteMode} onChange={event => setDeleteMode(event.target.value as typeof deleteMode)}><option value="trash">Переместить всю структуру в корзину</option><option value="move">Переместить содержимое</option><option value="archive">Архивировать всё содержимое</option></select></label>
      {deleteMode==='move' && <label className="field"><span>Куда переместить</span><select value={destination} onChange={event => setDestination(event.target.value)}><CategoryOptions categories={available} empty="Верхний уровень / вне рубрики"/></select></label>}
      <div className="actions"><button className="btn danger" disabled={working} onClick={() => perform(async () => {
        await api('/categories/'+item.id,{method:'DELETE',body:JSON.stringify({version:item.version,mode:deleteMode,target_id:destination || null})})
        navigate('/categories')
      },deleteMode==='archive'?'Рубрика архивирована':'Действие выполнено')}>{deleteMode==='archive'?<Archive size={16}/>:<Trash2 size={16}/>}Подтвердить</button><button className="btn ghost" onClick={() => setDeleteOpen(false)}>Отмена</button></div>
    </div></Modal>}
  </div>
}
export function CategoryEditor() {
  const {id} = useParams()
  const [params] = useSearchParams()
  const categories = useStudio<CategoryType[]>('/categories')
  const query = useStudio<CategoryType>('/categories/'+id,Boolean(id))
  if (id && !query.data) return <div className="page"><Link className="btn ghost" to="/categories"><Folder size={15}/>К рубрикам</Link><LoadState pending={query.isPending} error={query.error}/></div>
  const item = query.data ? {...categories.data?.find(row => row.id===id),...query.data} : undefined
  return <CategoryFormPage key={id ?? 'new'} item={item} categories={categories.data || []} parent={params.get('parent_id') || ''}/>
}
