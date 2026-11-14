import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, CalendarDays, ChevronDown, Clapperboard, Columns3, Copy, ExternalLink, Grid2X2, LayoutList, ListFilter, Plus, Star, Trash2 } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, copyText, uploadOriginal, useStudio } from '../api'
import { useToast } from './feedback'
import { DownloadMaterials, MediaGallery } from './MediaGallery'
import { CategoryOptions, Empty, ItemArt, LoadState, Modal, PageHeading, Pagination, SearchField, StatusBadge, categoryName, dateText, errorMessage, fromLocalDate, toLocalDate, type Category, type CustomField, type ListResult, type Publication, type Settings, type Status } from './shared'

type View = 'gallery'|'list'|'board'
const modes = [['gallery','Галерея',Grid2X2],['list','Список',LayoutList],['board','Доска',Columns3]] as const
const rangeFields = [['created_from','Создано с','date'],['created_to','Создано до','date'],['scheduled_from','Запланировано с','date'],['scheduled_to','Запланировано до','date'],['photo_min','Фото от','number'],['photo_max','Фото до','number']] as const

export function PublicationCard({item,status,selected,toggle,favorite,dateZone,dateFormat}: {item:Publication;status?:Status;selected?:boolean;toggle?:()=>void;favorite?:()=>void;dateZone?:string;dateFormat?:string}) {
  return <article className="panel item-card">
    {toggle && <label className="item-select"><input aria-label={'Выбрать '+item.title} checked={Boolean(selected)} type="checkbox" onChange={toggle}/></label>}
    {favorite && <button className="item-favorite" type="button" aria-label={item.is_favorite?'Убрать из избранного':'В избранное'} title={item.is_favorite?'Убрать из избранного':'В избранное'} aria-pressed={Boolean(item.is_favorite)} onClick={favorite}><Star size={16} fill={item.is_favorite?'currentColor':'none'}/></button>}
    <Link to={'/publications/'+item.id} aria-label={item.title}><ItemArt cover={item.cover_media_id}/></Link>
    <div className="item-body"><StatusBadge status={status}/><h3><Link to={'/publications/'+item.id}>{item.title}</Link></h3>
      {item.description && <p>{item.description}</p>}
      {item.category_name && <small className="muted">{item.category_name}</small>}
      {item.scheduled_at && <small className="muted"><CalendarDays size={13}/> {dateText(item.scheduled_at,dateZone,dateFormat)}</small>}
    </div>
  </article>
}
export function PublicationsPage({ready=false}: {ready?:boolean}) {
  const [params, setParams] = useSearchParams()
  const [q,setQ] = useState(params.get('q') || '')
  const [view,setView] = useState<View>('gallery')
  const [expand,setExpand] = useState(false)
  const [select,setSelect] = useState(false)
  const [chosen,setChosen] = useState<string[]>([])
  const [bulk,setBulk] = useState(false)
  const [busy,setBusy] = useState(false)
  const [bulkAction,setBulkAction] = useState('status')
  const [destination,setDestination] = useState('')
  const categories = useStudio<Category[]>('/categories')
  const statuses = useStudio<Status[]>('/statuses')
  const settings = useStudio<Settings>('/settings')
  const notify = useToast()
  const query = new URLSearchParams(params)
  query.set('limit',view==='board'?'60':'24')
  if (ready) query.set('ready','1')
  const data = useStudio<ListResult<Publication>>('/publications?'+query.toString())
  useEffect(()=>{
    const timer = window.setTimeout(()=>{
      setParams(previous=>{
        if ((previous.get('q') || '')===q.trim()) return previous
        const next=new URLSearchParams(previous)
        if(q.trim()) next.set('q',q.trim());else next.delete('q')
        next.delete('page');return next
      },{replace:true})
    },260)
    return ()=>window.clearTimeout(timer)
  },[q,setParams])
  function filter(key:string,value:string) {
    setParams(previous=>{
      const next=new URLSearchParams(previous)
      if(value) next.set(key,value);else next.delete(key)
      if(key!=='page') next.delete('page')
      if(key==='category_id') next.delete('subcategory_id')
      return next
    },{replace:true})
  }
  function toggle(id:string) {setChosen(previous=>previous.includes(id)?previous.filter(value=>value!==id):[...previous,id])}
  async function favorite(item:Publication) {
    try {
      await api('/publications/'+item.id,{method:'PATCH',body:JSON.stringify({version:item.version,is_favorite:!item.is_favorite})})
      notify(item.is_favorite?'Удалено из избранного':'Добавлено в избранное')
    } catch(error) {notify(error,true)}
  }
  async function applyBulk() {
    if (!chosen.length) return
    const body:Record<string,unknown>={ids:chosen,action:bulkAction}
    if (bulkAction==='status') body.status_id=destination || statuses.data?.[0]?.id
    if (bulkAction==='move') body.category_id=destination || null
    setBusy(true)
    try {
      await api('/publications/bulk',{method:'POST',body:JSON.stringify(body)})
      setChosen([]);setBulk(false);notify('Публикации обновлены')
    } catch(error) {notify(error,true)} finally {setBusy(false)}
  }
  function card(item:Publication) {
    return <PublicationCard key={item.id} item={item} status={statuses.data?.find(row=>row.id===item.status_id)} selected={chosen.includes(item.id)} toggle={select?()=>toggle(item.id):undefined} favorite={()=>favorite(item)} dateZone={settings.data?.timezone} dateFormat={settings.data?.date_format}/>
  }
  const currentCategory=params.get('category_id')
  const categoryList=categories.data || []
  const possibleSubcategories=categoryList.filter(row=>{
    if (!row.parent_id) return false
    if (!currentCategory) return true
    const visited = new Set<string>()
    for(let id:string|null=row.parent_id;id && !visited.has(id);id=categoryList.find(cat=>cat.id===id)?.parent_id || null) {
      if(id===currentCategory) return true
      visited.add(id)
    }
    return false
  })
  return <div className="page">
    <PageHeading title={ready?'Готово к публикации':'Публикации'} description={ready?'Подготовленные выпуски для размещения в TikTok.':'Библиотека выпусков, исходников и текстов для TikTok.'} actions={<Link className="btn primary" to={'/publications/new'+(currentCategory?'?category_id='+currentCategory:'')}><Plus size={17}/>Новая публикация</Link>}/>
    <div className="toolbar">
      <SearchField value={q} change={setQ} placeholder="Название, описание или тег…"/>
      <label className="field"><span className="sr-only">Рубрика</span><select value={currentCategory || ''} onChange={e=>filter('category_id',e.target.value)}><CategoryOptions categories={categoryList} empty="Все рубрики"/></select></label>
      {!ready && <label className="field"><span className="sr-only">Статус</span><select value={params.get('status_id') || ''} onChange={e=>filter('status_id',e.target.value)}><option value="">Все статусы</option>{statuses.data?.map(status=><option key={status.id} value={status.id}>{status.name}</option>)}</select></label>}
      <div className="segment" aria-label="Вид библиотеки">{modes.map(([id,label,Icon])=><button className="btn icon small" aria-pressed={view===id} aria-label={label} title={label} key={id} onClick={()=>setView(id)}><Icon size={16}/></button>)}</div>
      <button className="btn ghost" aria-expanded={expand} onClick={()=>setExpand(!expand)}><ListFilter size={16}/>Фильтры <ChevronDown size={14}/></button>
    </div>
    {expand && <div className="panel filters">
      <label className="field"><span>Подрубрика</span><select value={params.get('subcategory_id') || ''} onChange={e=>filter('subcategory_id',e.target.value)}><CategoryOptions categories={possibleSubcategories} empty="Любая"/></select></label>
      <label className="field"><span>Сортировка</span><select value={params.get('sort') || 'updated'} onChange={e=>filter('sort',e.target.value)}><option value="updated">Недавно изменённые</option><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option><option value="title">По названию</option><option value="scheduled">По дате плана</option></select></label>
      {rangeFields.map(([id,label,type])=><label className="field" key={id}><span>{label}</span><input type={type} min={type==='number'?0:undefined} value={params.get(id) || ''} onChange={e=>filter(id,e.target.value)}/></label>)}
      {[['has_video','Видео'],['has_description','Описание']].map(([id,label])=><label className="field" key={id}><span>{label}</span><select value={params.get(id) || ''} onChange={e=>filter(id,e.target.value)}><option value="">Любой вариант</option><option value="1">Есть</option><option value="0">Нет</option></select></label>)}
      <label className="checkbox-line"><input type="checkbox" checked={params.get('favorite')==='1'} onChange={e=>filter('favorite',e.target.checked?'1':'')}/> Только избранное</label>
      <button className="btn ghost" type="button" onClick={()=>{setQ('');setParams({},{replace:true})}}>Сбросить фильтры</button>
    </div>}
    <div className="toolbar"><small className="muted">{data.data?.total ?? '—'} публикаций</small>
      <button className="btn ghost small" type="button" aria-pressed={select} onClick={()=>{setSelect(!select);if(select)setChosen([])}}>{select?'Снять выделение':'Выбрать несколько'}</button>
      {select && !!chosen.length && <button className="btn primary small" onClick={()=>setBulk(true)}>Действия · {chosen.length}</button>}
    </div>
    <LoadState pending={data.isPending} error={data.error}/>
    {data.data?.total===0 && <Empty title={ready?'Готовых выпусков пока нет':'Публикации не найдены'} description={ready?'Подготовьте выпуск и переведите его в статус «Готово».':'Создайте выпуск или измените фильтры библиотеки.'} icon="video"/>}
    {!!data.data?.items.length && (view==='board' ? <div className="board" aria-label="Доска по статусам">{statuses.data?.filter(status=>!ready || status.id==='ready').map(status=>{
      const items=data.data?.items.filter(item=>item.status_id===status.id) || []
      return <section className="panel board-column" key={status.id}><StatusBadge status={status}/><small className="muted">{items.length} на странице</small>{items.map(card)}</section>
    })}</div> : <div className={'grid collection-grid '+view}>{data.data.items.map(card)}</div>)}
    <Pagination result={data.data} change={page=>filter('page',String(page))}/>
    {bulk && <Modal title={'Действия с '+chosen.length+' публикациями'} close={()=>setBulk(false)}><div className="stack">
      <label className="field"><span>Действие</span><select value={bulkAction} onChange={event=>{setBulkAction(event.target.value);setDestination('')}}><option value="status">Изменить статус</option><option value="move">Переместить</option><option value="archive">Архивировать</option><option value="trash">Переместить в корзину</option></select></label>
      {bulkAction==='status' && <label className="field"><span>Новый статус</span><select value={destination || statuses.data?.[0]?.id || ''} onChange={event=>setDestination(event.target.value)}>{statuses.data?.map(status=><option key={status.id} value={status.id}>{status.name}</option>)}</select></label>}
      {bulkAction==='move' && <label className="field"><span>Куда переместить</span><select value={destination} onChange={event=>setDestination(event.target.value)}><CategoryOptions categories={categoryList}/></select></label>}
      {bulkAction==='trash' && <p className="notice">Выбранные публикации переместятся в корзину со всеми материалами.</p>}
      <button className={bulkAction==='trash'?'btn danger':'btn primary'} type="button" disabled={busy} onClick={()=>void applyBulk()}>Подтвердить</button>
    </div></Modal>}
  </div>
}

type FieldValue=string|number|boolean|null
type PublicationForm={title:string;description:string;category_id:string;status_id:string;hashtags:string;scenario:string;notes:string;scheduled_at:string;published_at:string;tiktok_url:string;custom_fields:Record<string,FieldValue>}
function CustomInput({definition,value,change}: {definition:CustomField;value:FieldValue;change:(value:FieldValue)=>void}) {
  if (definition.type==='boolean' || definition.type==='toggle') return <label className="checkbox-line"><input type="checkbox" checked={value===true} onChange={e=>change(e.target.checked)}/>{definition.name}</label>
  if (definition.type==='select') return <label className="field"><span>{definition.name}</span><select value={typeof value==='string'?value:''} onChange={e=>change(e.target.value || null)}><option value="">Не выбрано</option>{definition.options.map(option=><option value={option} key={option}>{option}</option>)}</select></label>
  const type=['url','date','number'].includes(definition.type)?definition.type:'text'
  return <label className="field"><span>{definition.name}</span><input type={type} step={type==='number'?'any':undefined} value={String(value ?? '')} onChange={e=>change(e.target.value===''?null:type==='number'?Number(e.target.value):e.target.value)}/></label>
}
const count = (text: string) => [...text].length
const emptyDates = {scheduled_at:'',published_at:''}
function initialForm(item:Publication|undefined, zone:string, category:string, scheduled:string):PublicationForm {
  const dates=item ? {scheduled_at:toLocalDate(item.scheduled_at,zone),published_at:toLocalDate(item.published_at,zone)} : {...emptyDates,scheduled_at:/^\d{4}-\d{2}-\d{2}$/.test(scheduled)?scheduled+'T12:00':scheduled}
  return {
    title:item?.title || '',description:item?.description || '',category_id:item?.category_id || category,
    status_id:item?.status_id || 'draft',hashtags:item?.hashtags || '',scenario:item?.scenario || '',notes:item?.notes || '',
    tiktok_url:item?.tiktok_url || '',custom_fields:item?.custom_fields || {},...dates,
  }
}
function PublicationFormPage({item,params,categories,statuses,settings,definitions}: {item?:Publication;params:URLSearchParams;categories:Category[];statuses:Status[];settings?:Settings;definitions:CustomField[]}) {
  const navigate = useNavigate()
  const notify = useToast()
  const [draft,setDraft]=useState<{version:number;values:PublicationForm}|null>(null)
  const [staged,setStaged]=useState<File[]>([])
  const [error,setError]=useState<unknown>(null)
  const [busy,setBusy]=useState(false)
  const [progress,setProgress]=useState<string>()
  const uploadAbort=useRef<AbortController|null>(null)
  const zone=settings?.timezone || 'Europe/Minsk'
  const version=draft?.version ?? item?.version ?? 0
  const stale=Boolean(item && draft && item.version!==version)
  const values=draft?.values || initialForm(item,zone,params.get('category_id') || '',params.get('date') || params.get('scheduled_at') || '')
  const byCategory=new Map(categories.map(row=>[row.id,row]))
  const cat=byCategory.get(values.category_id)
  let descriptionLimit: number | null = null
  const visited=new Set<string>()
  for(let node=cat;node && !visited.has(node.id);node=node.parent_id ? byCategory.get(node.parent_id) : undefined) {
    if(node.description_limit!==null && node.description_limit!==undefined) {descriptionLimit=node.description_limit;break}
    visited.add(node.id)
  }
  const limit=settings?.text_limit || 3800
  const joined=[values.title,values.description].filter(Boolean).join('\n')
  const excess=count(joined)-limit
  const descriptionExcess=descriptionLimit === null ? 0 : count(values.description)-descriptionLimit
  function patch<K extends keyof PublicationForm>(key:K,value:PublicationForm[K]) {
    setDraft({version,values:{...values,[key]:value}})
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true);setError(null)
    try {
      const body={...values,version,category_id:values.category_id || null,tiktok_url:values.tiktok_url || null,scheduled_at:fromLocalDate(values.scheduled_at,zone),published_at:fromLocalDate(values.published_at,zone)}
      const row=await api<Publication>(item?'/publications/'+item.id:'/publications',{method:item?'PATCH':'POST',body:JSON.stringify(body)})
      setDraft(null)
      notify(row.status_id==='ready'?'Публикация готова к размещению':'Публикация сохранена')
      if (staged.length) {
        const controller=new AbortController()
        uploadAbort.current=controller
        for (const file of staged) {
          if (controller.signal.aborted) break
          try {await uploadOriginal(file,{target_type:'publication',target_id:row.id},percentage=>setProgress(file.name+' · '+percentage+'%'),controller.signal)}
          catch (error) {if(!controller.signal.aborted)notify(file.name+' — '+errorMessage(error),true)}
        }
        uploadAbort.current=null
        setStaged([]);setProgress(undefined)
      }
      if (!item) navigate('/publications/'+row.id,{replace:true})
    } catch (cause) {setError(cause)} finally {setBusy(false)}
  }
  async function operation(type:'delete'|'duplicate'|'favorite') {
    if(!item) return
    setBusy(true);setError(null)
    try {
      if(type==='delete') {
        if(!window.confirm('Переместить публикацию «'+item.title+'» со всеми материалами в корзину?')) return
        await api('/publications/'+item.id,{method:'DELETE',body:JSON.stringify({version:item.version})})
        notify('Публикация в корзине. Её можно восстановить.');navigate('/publications')
      } else if(type==='duplicate') {
        const row=await api<Publication>('/publications/'+item.id+'/duplicate',{method:'POST'})
        notify('Копия публикации создана');navigate('/publications/'+row.id)
      } else {
        await api('/publications/'+item.id,{method:'PATCH',body:JSON.stringify({version:item.version,is_favorite:!item.is_favorite})})
        notify(item.is_favorite?'Удалено из избранного':'Публикация добавлена в избранное')
      }
    } catch(cause) {setError(cause)} finally {setBusy(false)}
  }
  async function copy(value:string) {
    try {await copyText(value);notify('Текст скопирован')} catch(error) {notify(error,true)}
  }
  return <div className="page">
    <nav className="breadcrumb"><Link to="/publications"><ArrowLeft size={15}/> Публикации</Link>{cat && <><span>›</span><Link to={'/categories/'+cat.id}>{categoryName(cat)}</Link></>}</nav>
    <PageHeading title={item?.title || 'Новая публикация'} actions={item && <>
      <StatusBadge status={statuses.find(status=>status.id===item.status_id)}/>
      <button className="btn icon ghost" type="button" aria-label={item.is_favorite?'Убрать из избранного':'Добавить в избранное'} aria-pressed={!!item.is_favorite} disabled={busy || !!draft} onClick={()=>operation('favorite')}><Star size={17} fill={item.is_favorite?'currentColor':'none'}/></button>
      <button className="btn ghost" type="button" disabled={busy || !!draft} onClick={()=>operation('duplicate')}><Copy size={16}/>Дублировать</button>
    </>}/>
    {stale && <p className="notice" role="status">Публикацию уже обновили на другом устройстве. Ваш текст остался в форме. Скопируйте нужные правки перед тем, как обновить карточку. <button className="link-action" onClick={()=>setDraft(null)}>Открыть текущую версию</button></p>}
    <LoadState error={error}/>
    <form className="grid editor-grid" onSubmit={save}>
      <div className="stack">
        <section className="panel stack">
          <h2>Текст для TikTok</h2>
          <label className="field"><span>Название TikTok</span><input value={values.title} onChange={e=>patch('title',e.target.value)} required/></label>
          <label className="field"><span>Описание TikTok</span><textarea rows={6} value={values.description} onChange={e=>patch('description',e.target.value)}/></label>
          <div className="editor-textbar"><small className={excess>0?'notice':'muted'}>{count(joined)} / {limit} символов вместе{excess>0?' · лишних '+excess:''}</small>
          {descriptionLimit!==null && <small className={descriptionExcess>0?'notice':'muted'}>{count(values.description)} / {descriptionLimit} в описании{descriptionExcess>0?' · лишних '+descriptionExcess:''}</small>}</div>
          <div className="actions">
            <button className="btn ghost small" type="button" disabled={!values.title} onClick={()=>copy(values.title)}><Copy size={15}/>Название</button>
            <button className="btn ghost small" type="button" disabled={!values.description} onClick={()=>copy(values.description)}><Copy size={15}/>Описание</button>
            <button className="btn ghost small" type="button" disabled={!joined} onClick={()=>copy(joined)}><Copy size={15}/>Название и описание</button>
          </div>
          <label className="field"><span>Хештеги</span><input placeholder="#remakeai #минск" value={values.hashtags} onChange={e=>patch('hashtags',e.target.value)}/></label>
        </section>
        <section className="panel stack"><h2>Сценарий и заметки</h2><label className="field"><span>Сценарий</span><textarea rows={4} value={values.scenario} onChange={e=>patch('scenario',e.target.value)}/></label><label className="field"><span>Внутренние заметки</span><textarea rows={3} value={values.notes} onChange={e=>patch('notes',e.target.value)}/></label></section>
      </div>
      <aside className="stack">
        <section className="panel stack">
          <h2>Публикация</h2>
          <label className="field"><span>Рубрика или подрубрика</span><select value={values.category_id} onChange={e=>patch('category_id',e.target.value)}><CategoryOptions categories={categories}/></select></label>
          <label className="field"><span>Статус</span><select value={values.status_id} onChange={e=>patch('status_id',e.target.value)}>{statuses.map(status=><option key={status.id} value={status.id}>{status.name}</option>)}</select></label>
          <label className="field"><span>Планируемая дата и время · {zone}</span><input type="datetime-local" value={values.scheduled_at} onChange={e=>patch('scheduled_at',e.target.value)}/></label>
          <label className="field"><span>Фактическая дата и время · {zone}</span><input type="datetime-local" value={values.published_at} onChange={e=>patch('published_at',e.target.value)}/></label>
          <label className="field"><span>Ссылка на TikTok</span><input type="url" placeholder="https://www.tiktok.com/…" value={values.tiktok_url} onChange={e=>patch('tiktok_url',e.target.value)}/></label>
          {item?.tiktok_url && /^https?:\/\//i.test(item.tiktok_url) && <a className="link-action" href={item.tiktok_url} target="_blank" rel="noreferrer">Открыть в TikTok<ExternalLink size={15}/></a>}
          {item && <p className="muted"><small>Создано {dateText(item.created_at,zone,settings?.date_format)} · обновлено {dateText(item.updated_at,zone,settings?.date_format)}</small></p>}
          <div className="actions"><button className="btn primary" type="submit" disabled={busy || stale}>{item?'Сохранить публикацию':'Создать публикацию'}</button>{item && <button className="btn danger" type="button" disabled={busy} onClick={()=>operation('delete')}><Trash2 size={16}/>Удалить</button>}</div>
          {progress && <div className="actions"><p className="muted">{progress}</p><button className="btn ghost small" type="button" onClick={()=>uploadAbort.current?.abort()}>Отменить загрузку</button></div>}
        </section>
        {!!definitions.length && <section className="panel stack"><h2>Дополнительные поля</h2>{definitions.map(definition=><CustomInput definition={definition} key={definition.id} value={values.custom_fields[definition.id] ?? null} change={value=>patch('custom_fields',{...values.custom_fields,[definition.id]:value})}/>)}</section>}
      </aside>
    </form>
    <div className="section stack">
      {item && !!item.media?.length && <DownloadMaterials id={item.id}/>}
      <MediaGallery type="publication" target={item?.id} media={item?.media || []} selectedCover={item?.cover_media_id} staged={staged} changeStaged={setStaged}/>
    </div>
  </div>
}
export function PublicationEditor() {
  const {id}=useParams()
  const [params]=useSearchParams()
  const item=useStudio<Publication>('/publications/'+id,!!id)
  const statuses=useStudio<Status[]>('/statuses')
  const categories=useStudio<Category[]>('/categories')
  const settings=useStudio<Settings>('/settings')
  const definitions=useStudio<CustomField[]>('/custom-fields')
  if(id && !item.data) return <div className="page"><Link className="btn ghost" to="/publications"><Clapperboard size={16}/>К публикациям</Link><LoadState pending={item.isPending} error={item.error}/></div>
  return <PublicationFormPage key={id ?? 'new'} item={item.data} params={params} statuses={statuses.data || []} categories={categories.data || []} settings={settings.data} definitions={definitions.data || []}/>
}
