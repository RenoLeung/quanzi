import { useEffect, useState } from 'react'

type ToastKind = 'info' | 'error' | 'success'
interface ToastItem {
  id: number
  text: string
  kind: ToastKind
}

let seq = 0
let listeners: Array<(t: ToastItem) => void> = []

export function toast(text: string, kind: ToastKind = 'info') {
  const item = { id: ++seq, text, kind }
  listeners.forEach((fn) => fn(item))
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    const handler = (t: ToastItem) => {
      setItems((prev) => [...prev, t])
      window.setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== t.id))
      }, t.kind === 'error' ? 4200 : 2600)
    }
    listeners.push(handler)
    return () => {
      listeners = listeners.filter((x) => x !== handler)
    }
  }, [])

  if (!items.length) return null
  return (
    <div className="toast-host">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}