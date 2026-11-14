import { useState, type FormEvent } from 'react'
import { ArrowLeft, Copy, ExternalLink, Lightbulb, Plus, Sparkles, Star, Trash2 } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, uploadOriginal, useStudio } from '../api'
import { useToast } from './feedback'
import { MediaGallery } from './MediaGallery'
import { CategoryOptions, Empty, LoadState, Modal, PageHeading, Pagination, SearchField, StatusBadge, ideaStatuses, priorities, errorMessage, type Category, type Idea, type ListResult } from './shared'

const ideaColors:Record<string,string>={new:'#93b8f3',developing:'#f2c78b',selected:'#57d9cf',realized:'#71dca3',archived:'#a6a9bd'}
const ideaStatus=(id:string)=>({id,name:ideaStatuses.find(([key])=>key===id)?.[1] || id,color:ideaColors[id],sort_order:0})
const labelOfPriority=(id:string)=>priorities.find(([key])=>key===id)?.[1] || id

export function IdeasPage() {
  const [params,setParams]=useSearchParams()
  const [text,setText]=useState(params.get('q') || '')
  const category=params.get('category_id') || ''
  const page=params.get('page') || '1'
  const query=new URLSearchParams(params)
  query.set('page',page)
  query.set('limit','24')
  const categories=useStudio<Category[]>('/categories')
  const result=useStudio<ListResult<Idea>>('/ideas?'+query.toString())
  const notify=useToast()
  function filter(key:string,value:string) {
    const next=new URLSearchParams(params)
    if(value) next.set(key,value);else next.delete(key)
    if(key!=='page')next.delete('page')
    setParams(next,{replace:true})
  }
  async function favorite(item:Idea) {
    try {await api('/ideas/'+item.id,{method:'PATCH',body:JSON.stringify({version:item.version,is_favorite:!item.is_favorite})})
      notify(item.is_favorite?'Удалено из избранного':'Идея добавлена в избранное')
    } catch(error) {notify(error,true)}
  }
  return <div className="page">
    <PageHeading title="Идеи" description="Замыслы, референсы и сценарии будущих выпусков." actions={<Link className="btn primary" to={'/ideas/new'+(category?'?category_id='+category:'')}><Plus size={17}/>Новая идея</Link>}/>
    <form className="toolbar" onSubmit={event=>{event.preventDefault();filter('q',text.trim())}} role="search">
      <SearchField value={text} change={value=>{setText(value);if(!value)filter('q','')}} label="Поиск идей" placeholder="Найти идею…"/>
      <button className="btn ghost" type="submit">Найти</button>
      <label className="field"><span className="sr-only">Рубрика</span><select value={category} onChange={event=>filter('category_id',event.target.value)}><CategoryOptions categories={categories.data || []} empty="Все рубрики"/></select></label>
      <label className="field"><span className="sr-only">Статус идеи</span><select value={params.get('status') || ''} onChange={event=>filter('status',event.target.value)}><option value="">Все статусы</option>{ideaStatuses.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label className="field"><span className="sr-only">Приоритет</span><select value={params.get('priority') || ''} onChange={event=>filter('priority',event.target.value)}><option value="">Любой приоритет</option>{priorities.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label className="checkbox-line"><input type="checkbox" checked={params.get('favorite')==='1'} onChange={event=>filter('favorite',event.target.checked?'1':'')}/> Избранное</label>
    </form>
    <LoadState pending={result.isPending} error={result.error}/>
    {result.data?.items.length===0 && <Empty title="Идеи не найдены" description="Добавьте новую задумку или измените фильтр." icon="idea"/>}
    {!!result.data?.items.length && <div className="grid collection-grid">{result.data.items.map(item=><article className="panel idea-card" key={item.id}>
      <div className="actions"><StatusBadge status={ideaStatus(item.status)}/><small className="muted">{labelOfPriority(item.priority)} приоритет</small></div>
      <h3><Link to={'/ideas/'+item.id}>{item.title}</Link></h3>
      {item.description && <p>{item.description}</p>}
      {item.category_name && <small className="muted">{item.category_name}</small>}
      <div className="actions"><Link className="link-action" to={'/ideas/'+item.id}>Открыть идею</Link><button className="btn icon ghost small" type="button" aria-label={item.is_favorite?'Убрать из избранного':'Добавить в избранное'} aria-pressed={!!item.is_favorite} onClick={()=>favorite(item)}><Star size={15} fill={item.is_favorite?'currentColor':'none'}/></button></div>
    </article>)}</div>}
    <Pagination result={result.data} change={page=>filter('page',String(page))}/>
  </div>
}

type IdeaForm = {title:string;description:string;category_id:string;priority:string;status:string;scenario:string;notes:string;links:string}
const initialForm = (item:Idea|undefined, category:string):IdeaForm => ({
  title:item?.title || '',description:item?.description || '',category_id:item?.category_id || category,
  priority:item?.priority || 'medium',status:item?.status || 'new',scenario:item?.scenario || '',notes:item?.notes || '',
  links:Array.isArray(item?.links)?item.links.join('\n'):'',
})
function IdeaFormPage({item,categories,category}: {item?:Idea;categories:Category[];category:string}) {
  const [draft,setDraft]=useState<{data:IdeaForm;version:number}|null>(null)
  const [staged,setStaged]=useState<File[]>([])
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState<unknown>(null)
  const [progress,setProgress]=useState<string>()
  const [convertOpen,setConvertOpen]=useState(false)
  const [uploadController,setUploadController]=useState<AbortController>()
  const navigate=useNavigate()
  const notify=useToast()
  const version=draft?.version ?? item?.version ?? 0
  const stale=Boolean(item && draft && item.version!==version)
  const values=draft?.data || initialForm(item,category)
  function patch<K extends keyof IdeaForm>(key:K,value:IdeaForm[K]) {
    setDraft({version,data:{...values,[key]:value}})
  }
  const links=values.links.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)
  async function save(event:FormEvent) {
    event.preventDefault()
    setBusy(true);setError(null)
    try {
      const row=await api<Idea>(item?'/ideas/'+item.id:'/ideas',{method:item?'PATCH':'POST',body:JSON.stringify({...values,links,category_id:values.category_id || null,version})})
      setDraft(null)
      notify(item?'Идея сохранена':'Идея создана')
      if (staged.length) {
        const controller=new AbortController()
        setUploadController(controller)
        for(const file of staged) {
          if(controller.signal.aborted)break
          try {await uploadOriginal(file,{target_type:'idea',target_id:row.id},amount=>setProgress(file.name+' · '+amount+'%'),controller.signal)}
          catch (error) {if(!controller.signal.aborted)notify(file.name+' — '+errorMessage(error),true)}
        }
        setUploadController(undefined);setProgress(undefined);setStaged([])
      }
      if(!item)navigate('/ideas/'+row.id,{replace:true})
    } catch(error) {setError(error)} finally {setBusy(false)}
  }
  async function act(action:'convert'|'duplicate'|'delete'|'favorite') {
    if(!item)return
    setError(null);setBusy(true)
    try {
      if(action==='delete') {
        if(!window.confirm('Переместить идею «'+item.title+'» в корзину?')) return
        await api('/ideas/'+item.id,{method:'DELETE',body:JSON.stringify({version:item.version})})
        notify('Идея в корзине. Её можно восстановить.');navigate('/ideas')
      } else if(action==='favorite') {
        await api('/ideas/'+item.id,{method:'PATCH',body:JSON.stringify({version:item.version,is_favorite:!item.is_favorite})})
        notify(item.is_favorite?'Удалено из избранного':'Идея добавлена в избранное')
      } else {
        const result=await api<{id:string}>('/ideas/'+item.id+'/'+action,{method:'POST',body:JSON.stringify({version:item.version})})
        notify(action==='convert'?'Из идеи создана публикация':'Копия идеи создана')
        navigate((action==='convert'?'/publications/':'/ideas/')+result.id)
      }
    } catch(error) {setError(error);notify(error,true)} finally {setBusy(false);setConvertOpen(false)}
  }
  return <div className="page">
    <nav className="breadcrumb"><Link to="/ideas"><ArrowLeft size={15}/> Идеи</Link></nav>
    <PageHeading title={item?.title || 'Новая идея'} actions={item && <>
      <StatusBadge status={ideaStatus(item.status)}/>
      <button className="btn icon ghost" type="button" disabled={busy || !!draft} aria-label={item.is_favorite?'Убрать из избранного':'Добавить в избранное'} aria-pressed={!!item.is_favorite} onClick={()=>act('favorite')}><Star fill={item.is_favorite?'currentColor':'none'} size={17}/></button>
      <button className="btn ghost" type="button" disabled={busy || !!draft} onClick={()=>act('duplicate')}><Copy size={16}/>Дублировать</button>
      {item.publication_id ? <Link className="btn primary" to={'/publications/'+item.publication_id}>Открыть публикацию <ExternalLink size={15}/></Link> : <button className="btn primary" type="button" disabled={busy || !!draft} onClick={()=>setConvertOpen(true)}><Sparkles size={17}/>Превратить в публикацию</button>}
    </>}/>
    {stale && <p className="notice" role="status">Идею обновили на другом устройстве. Ваши правки остались в форме. <button className="link-action" onClick={()=>setDraft(null)}>Открыть текущую версию</button></p>}
    <LoadState error={error}/>
    <form className="grid editor-grid" onSubmit={save}>
      <section className="panel stack">
        <h2>Замысел</h2>
        <label className="field"><span>Название идеи</span><input value={values.title} onChange={e=>patch('title',e.target.value)} required /></label>
        <label className="field"><span>Описание идеи</span><textarea rows={5} value={values.description} onChange={e=>patch('description',e.target.value)} /></label>
        <label className="field"><span>Сценарий</span><textarea rows={4} value={values.scenario} onChange={e=>patch('scenario',e.target.value)} /></label>
        <label className="field"><span>Заметки</span><textarea rows={3} value={values.notes} onChange={e=>patch('notes',e.target.value)} /></label>
      </section>
      <aside className="panel stack">
        <h2>Организация</h2>
        <label className="field"><span>Рубрика или подрубрика</span><select value={values.category_id} onChange={e=>patch('category_id',e.target.value)}><CategoryOptions categories={categories}/></select></label>
        <label className="field"><span>Приоритет</span><select value={values.priority} onChange={e=>patch('priority',e.target.value)}>{priorities.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        <label className="field"><span>Статус идеи</span><select value={values.status} onChange={e=>patch('status',e.target.value)}>{ideaStatuses.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        <label className="field"><span>Ссылки и референсы</span><textarea rows={3} placeholder="По одной ссылке на строку" value={values.links} onChange={e=>patch('links',e.target.value)} /></label>
        {links.filter(link=>/^https?:\/\//i.test(link)).map((link,index)=><a key={link+index} href={link} className="link-action" style={{overflowWrap:'anywhere'}} target="_blank" rel="noreferrer">{link}<ExternalLink size={15}/></a>)}
        <div className="actions"><button className="btn primary" type="submit" disabled={busy || stale}>{item?'Сохранить идею':'Создать идею'}</button>{item && <button className="btn danger" type="button" disabled={busy} onClick={()=>act('delete')}><Trash2 size={16}/>Удалить</button>}</div>
        {progress && <div className="actions"><small className="muted">{progress}</small><button className="btn ghost small" onClick={()=>uploadController?.abort()} type="button">Отменить загрузку</button></div>}
      </aside>
    </form>
    <div className="section"><MediaGallery type="idea" target={item?.id} media={item?.media || []} staged={staged} changeStaged={setStaged}/></div>
    {convertOpen && <Modal title="Создать публикацию из идеи?" close={()=>setConvertOpen(false)}>
      <div className="stack"><p className="muted">Название, описание, сценарий, заметки и прикреплённые файлы перейдут в карточку публикации. Идея сохранится в разделе со статусом «Реализована».</p>
      <div className="actions"><button className="btn primary" disabled={busy} onClick={()=>act('convert')}>Создать публикацию</button><button className="btn ghost" onClick={()=>setConvertOpen(false)}>Отмена</button></div></div>
    </Modal>}
  </div>
}
export function IdeaEditor() {
  const {id}=useParams()
  const [params]=useSearchParams()
  const item=useStudio<Idea>('/ideas/'+id,!!id)
  const categories=useStudio<Category[]>('/categories')
  if(id && !item.data) return <div className="page"><Link className="btn ghost" to="/ideas"><Lightbulb size={16}/>К идеям</Link><LoadState pending={item.isPending} error={item.error}/></div>
  return <IdeaFormPage key={id ?? 'new'} item={item.data} categories={categories.data || []} category={params.get('category_id') || ''}/>
}
