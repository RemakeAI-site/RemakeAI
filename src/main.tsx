import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const mount = document.getElementById('root')
if (!mount) throw new Error('Не найден контейнер приложения')
createRoot(mount).render(<StrictMode><App/></StrictMode>)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {navigator.serviceWorker.register('/sw.js').catch(console.error)})
}
