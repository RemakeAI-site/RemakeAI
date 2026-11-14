import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CircleCheck, CircleAlert, X } from 'lucide-react'
import { errorMessage } from './shared'

type Notify = (message: unknown, failure?: boolean) => void
const ToastContext = createContext<Notify>(() => {})
export const useToast = () => useContext(ToastContext)

export function Feedback({children}: {children: ReactNode}) {
  const [items, setItems] = useState<{id: string; message: string; failure: boolean}[]>([])
  const dismiss = useCallback((id: string) => setItems(previous => previous.filter(item => item.id !== id)), [])
  const notify = useCallback<Notify>((message, failure = false) => {
    const id = crypto.randomUUID()
    setItems(previous => [...previous.slice(-3), {id, message: errorMessage(message), failure}])
    window.setTimeout(() => dismiss(id), failure ? 8500 : 4500)
  }, [dismiss])
  return <ToastContext.Provider value={notify}>{children}<div className="toast-list" aria-live="polite" aria-relevant="additions">
    {items.map(item => <div className={item.failure ? 'toast failure' : 'toast'} key={item.id}>
      {item.failure ? <CircleAlert size={17} /> : <CircleCheck size={17} />}
      <span>{item.message}</span>
      <button aria-label="Закрыть уведомление" type="button" onClick={() => dismiss(item.id)}><X size={16}/></button>
    </div>)}
  </div></ToastContext.Provider>
}
