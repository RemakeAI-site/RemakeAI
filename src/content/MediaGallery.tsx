import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Download, Film, GripVertical, ImageIcon, Link2, RefreshCw, Trash2, UploadCloud, ZoomIn, ZoomOut } from 'lucide-react'
import { api, copyText, formatBytes, mediaUrl, uploadOriginal } from '../api'
import { useToast } from './feedback'
import { errorMessage, Modal, type Media } from './shared'

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif,video/mp4,video/quicktime,video/webm,.png,.jpg,.jpeg,.webp,.gif,.avif,.heic,.heif,.mp4,.m4v,.mov,.webm'
const downloadUrl = (id: string) => mediaUrl(id) + '?download=1'
const isVideo = (asset: Media) => asset.media_type === 'video' || asset.mime_type.startsWith('video/')

export function MediaGallery({type,target,media,selectedCover,staged,changeStaged}: {type:'publication'|'idea';target?:string;media:Media[];selectedCover?:string|null;staged?:File[];changeStaged?:(files:File[])=>void}) {
  const notify=useToast()
  const [fileDrag,setFileDrag]=useState(false)
  const [selected,setSelected]=useState<Media>()
  const [zoom,setZoom]=useState(false)
  const [failed,setFailed]=useState<string[]>([])
  const [progress,setProgress]=useState<{name:string;amount:number;index:number;total:number}>()
  const [errors,setErrors]=useState<string[]>([])
  const [busy,setBusy]=useState(false)
  const controller=useRef<AbortController|null>(null)
  const dragging=useRef<string|null>(null)
  const ordered=[...media].sort((left,right)=>left.sort_order-right.sort_order)
  async function upload(files:File[],replace?:string) {
    if (!files.length || busy) return
    if (!target) {changeStaged?.([...(staged || []),...files]); return}
    const current=new AbortController()
    controller.current=current
    setBusy(true)
    setErrors([])
    const failure:string[]=[]
    try {
      for (const [index,file] of files.entries()) {
        if (current.signal.aborted) break
        const update=(amount:number)=>setProgress({name:file.name,amount,index:index+1,total:files.length})
        update(0)
        try {
          await uploadOriginal(file,{target_type:type,target_id:target,replace_for:replace},update,current.signal)
        } catch (error) {
          if (!current.signal.aborted) failure.push(file.name+' — '+errorMessage(error))
        }
      }
      if (current.signal.aborted) notify('Загрузка отменена')
      else if (!failure.length) notify(files.length===1?'Файл загружен':'Файлы загружены')
      setErrors(failure)
    } finally {controller.current=null;setProgress(undefined);setBusy(false)}
  }
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true)
    setErrors([])
    try {await action();notify(success)} catch (error) {setErrors([errorMessage(error)])} finally {setBusy(false)}
  }
  function reorder(from:string,to:string) {
    if (!target || busy || from===to) return
    const ids=ordered.map(asset=>asset.attachment_id)
    const first=ids.indexOf(from)
    const end=ids.indexOf(to)
    if (first<0 || end<0) return
    ids.splice(first,1)
    ids.splice(end,0,from)
    void run(()=>api('/media/order',{method:'PATCH',body:JSON.stringify({target_type:type,target_id:target,ids})}),'Порядок сохранён')
  }
  function failedAsset(id:string) {setFailed(prev=>prev.includes(id) ? prev : [...prev,id])}
  function preview(asset:Media) {setSelected(asset);setZoom(false)}
  return <section className="panel stack">
    <div className="section-heading"><h2>{type==='idea'?'Прикреплённые материалы':'Фотографии и видео'}</h2><small className="muted">{ordered.length + (staged?.length || 0)} файлов</small></div>
    <div className={fileDrag?'dropzone dragging':'dropzone'} onDragOver={event=>{if(event.dataTransfer.types.includes('Files')) {event.preventDefault();setFileDrag(true)}}} onDragLeave={()=>setFileDrag(false)} onDrop={event=>{
      event.preventDefault();setFileDrag(false)
      if(event.dataTransfer.files.length) void upload([...event.dataTransfer.files])
    }}>
      <UploadCloud size={25} />
      <label className="btn"><input type="file" multiple accept={ACCEPT} aria-label="Загрузить фотографии и видео" className="sr-only" disabled={busy} onChange={event=>{void upload([...event.target.files || []]);event.target.value=''}}/>Выбрать файлы</label>
      <small className="muted">Или перетащите сюда. Оригиналы сохраняются в исходном качестве.</small>
      {progress && <><span style={{overflowWrap:'anywhere'}}>{progress.index} / {progress.total} · {progress.name}</span><progress max="100" value={progress.amount} aria-label="Загрузка файла" /><button className="btn danger small" type="button" onClick={()=>controller.current?.abort()}>Отменить загрузку</button></>}
    </div>
    {!!errors.length && <div className="error-box" role="alert">{errors.map(error=><p key={error}>{error}</p>)}<p>Файл можно выбрать снова, чтобы повторить загрузку.</p></div>}
    {!!staged?.length && <div className="stack" aria-label="Ожидают сохранения">{staged.map((file,index)=><div className="dash-row" key={file.name+index}><ImageIcon size={17}/><span>{file.name}</span><small>{formatBytes(file.size)}</small><button className="btn ghost icon small" type="button" aria-label={'Убрать '+file.name} onClick={()=>changeStaged?.(staged.filter((_,i)=>i!==index))}><Trash2 size={14}/></button></div>)}<p className="muted">Загрузка начнётся после создания карточки.</p></div>}
    {!!ordered.length && <div className="media-grid">{ordered.map((asset,index)=>{
      const video=isVideo(asset)
      const noImage=failed.includes(asset.id) || (video && !asset.preview_storage_key)
      return <article className="media-card" key={asset.attachment_id} draggable={!busy} onDragStart={event=>{
        dragging.current=asset.attachment_id;event.dataTransfer.setData('text/plain',asset.attachment_id);event.dataTransfer.effectAllowed='move'
      }} onDragEnd={()=>{dragging.current=null}} onDragOver={event=>{if(dragging.current) event.preventDefault()}} onDrop={event=>{
        if(dragging.current) {event.preventDefault();reorder(dragging.current,asset.attachment_id);dragging.current=null}
      }}>
        <button className="media-preview" type="button" onClick={()=>preview(asset)} aria-label={'Открыть '+asset.original_filename}>
          {!noImage ? <img src={mediaUrl(asset.id,true)} alt="" loading="lazy" onError={()=>failedAsset(asset.id)}/> : video ? <Film size={28}/> : <ImageIcon size={27}/>}
        </button>
        <p><GripVertical size={14}/> <strong>{index+1}. {asset.original_filename}</strong></p>
        <p className="muted">{asset.format?.toUpperCase() || asset.mime_type} · {formatBytes(asset.file_size)}{asset.width && asset.height ? ' · '+asset.width+'×'+asset.height : ''}{asset.duration ? ' · '+Math.round(asset.duration)+' с' : ''}</p>
        <div className="actions">
          <button className="btn icon ghost small" type="button" disabled={busy || index===0} aria-label="Переместить кадр выше" onClick={()=>reorder(asset.attachment_id,ordered[index-1].attachment_id)}><ArrowUp size={14}/></button>
          <button className="btn icon ghost small" type="button" disabled={busy || index+1===ordered.length} aria-label="Переместить кадр ниже" onClick={()=>reorder(asset.attachment_id,ordered[index+1].attachment_id)}><ArrowDown size={14}/></button>
          <a className="btn icon ghost small" href={downloadUrl(asset.id)} aria-label={'Скачать '+asset.original_filename}><Download size={14}/></a>
          <button className="btn icon ghost small" type="button" aria-label="Скопировать ссылку на файл" onClick={async()=>{
            try {await copyText(location.origin+mediaUrl(asset.id));notify('Ссылка скопирована')} catch(error){notify(error,true)}
          }}><Link2 size={14}/></button>
          <label className="btn icon ghost small" title="Заменить файл"><input type="file" className="sr-only" accept={ACCEPT} disabled={busy} aria-label={'Заменить '+asset.original_filename} onChange={event=>{void upload([...event.target.files || []],asset.attachment_id);event.target.value=''}}/><RefreshCw size={14}/></label>
          <button className="btn icon danger small" aria-label={'Удалить '+asset.original_filename} type="button" disabled={busy} onClick={()=>{
            if(window.confirm('Переместить файл «'+asset.original_filename+'» в корзину?')) void run(()=>api('/attachments/'+asset.attachment_id+'?target_type='+type,{method:'DELETE'}),'Файл в корзине')
          }}><Trash2 size={14}/></button>
        </div>
        {type==='publication' && !video && <button className="btn ghost small" style={{width:'auto'}} type="button" disabled={busy || selectedCover===asset.id} onClick={()=>run(()=>api('/media/cover',{method:'PATCH',body:JSON.stringify({target_type:type,target_id:target,media_id:asset.id})}),'Обложка обновлена')}>{selectedCover===asset.id?<><Check size={14}/>Обложка</>:'Сделать обложкой'}</button>}
      </article>
    })}</div>}
    {selected && <Modal wide title={selected.original_filename} close={()=>setSelected(undefined)}>
      <div className="stack">
        <div className={zoom?'dialog-view zoomed':'dialog-view'}>
          {isVideo(selected) ? <video key={selected.id} controls preload="metadata" playsInline src={mediaUrl(selected.id)} onError={()=>failedAsset(selected.id)}/> : <img src={mediaUrl(selected.id)} alt={selected.original_filename} onError={()=>failedAsset(selected.id)}/>}
        </div>
        {failed.includes(selected.id) && <p className="notice">Предпросмотр может быть недоступен в этом браузере. Скачайте оригинал, чтобы открыть файл на устройстве.</p>}
        <p className="muted">{formatBytes(selected.file_size)}{selected.width && selected.height ? ' · '+selected.width+'×'+selected.height : ''}{selected.duration ? ' · '+Math.round(selected.duration)+' с' : ''}</p>
        <div className="actions">
          {!isVideo(selected) && <button className="btn ghost" type="button" aria-pressed={zoom} onClick={()=>setZoom(!zoom)}>{zoom?<ZoomOut size={17}/>:<ZoomIn size={17}/>} {zoom?'Вписать в экран':'Исходный размер'}</button>}
          <a className="btn primary" href={downloadUrl(selected.id)}><Download size={17}/>Скачать оригинал</a>
        </div>
      </div>
    </Modal>}
  </section>
}

export function DownloadMaterials({id}: {id:string}) {
  const notify=useToast()
  const [files,setFiles]=useState<{name:string;url:string}[]>()
  const [busy,setBusy]=useState(false)
  async function download(photos:boolean) {
    const url='/api/publications/'+id+'/download'+(photos?'?photos=1':'')
    setBusy(true)
    try {
      const response=await fetch(url,{method:'HEAD',cache:'no-store'})
      if(response.ok && response.headers.get('content-type')?.includes('zip')) {
        const link=document.createElement('a')
        link.href=url; link.download='';link.click()
        return
      }
      const result=await fetch(url,{cache:'no-store'})
      if(!result.ok) {
        const detail=await result.json().catch(()=>null) as {error?:string}|null
        throw new Error(detail?.error || 'Не удалось подготовить скачивание.')
      }
      if(result.headers.get('content-type')?.includes('json')) {
        const data=await result.json() as {files:{name:string;url:string}[]}
        setFiles(data.files)
      } else {
        await result.body?.cancel()
        const link=document.createElement('a')
        link.href=url;link.download='';link.click()
      }
    } catch(error) {notify(error,true)} finally {setBusy(false)}
  }
  return <>
    <div className="actions"><button className="btn" type="button" disabled={busy} onClick={()=>download(false)}><Download size={16}/>Скачать все материалы</button><button className="btn ghost" type="button" disabled={busy} onClick={()=>download(true)}>Только фотографии</button></div>
    {files && <Modal title="Скачать оригиналы по частям" close={()=>setFiles(undefined)}><div className="stack"><p className="muted">Подборка большая. Оригиналы доступны отдельными файлами.</p>{files.map(file=><a key={file.url+file.name} className="btn" href={file.url} download><Download size={16}/>{file.name}</a>)}</div></Modal>}
  </>
}
