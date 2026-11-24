import { useEffect, useMemo, useRef, useState } from 'react'
import { deleteAttachment, signUrl, storageUsage } from '../lib/api'
import { formatSize } from '../lib/format'
import { fileIcon } from '../lib/media'
import type { StorageFile, StorageInfo } from '../lib/types'
import { toast } from './Toast'

interface Props {
  info: StorageInfo | null
  onClose: () => void
  onRefresh: () => Promise<void>
}

export default function StorageSheet({ info, onClose, onRefresh }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'file' | 'image' | 'voice'>('all')

  const files = useMemo(() => {
    if (!info?.files) return []
    const list = filter === 'all' ? info.files : info.files.filter((f) => f.kind === filter)
    return list.slice().sort((a, b) => b.size - a.size)
  }, [info, filter])

  const used = info?.used ?? 0
  const quota = info?.quota ?? 1073741824
  const pct = Math.min(100, Math.round((used / quota) * 100))

  async function removeOne(f: StorageFile) {
    setBusyId(f.id)
    try {
      const res = await deleteAttachment(f.id, f.path)
      if (res.ok) {
        toast(`已删除，释放 ${formatSize(res.freed)}`, 'success')
        setConfirmId(null)
        await onRefresh()
      } else {
        toast('删除失败', 'error')
      }
    } catch (e) {
      toast((e as Error).message, 'error')
      setConfirmId(null)
    } finally {
      setBusyId(null)
    }
  }

  async function saveThenRemove(f: StorageFile) {
    setBusyId(f.id)
    try {
      const url = await signUrl(f.path, f.name)
      if (!url) throw new Error('无法生成下载链接')
      const resp = await fetch(url)
      if (!resp.ok) throw new Error('下载失败')
      const blob = await resp.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = f.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000)
      const res = await deleteAttachment(f.id, f.path)
      if (res.ok) {
        toast(`已保存到本地并删除云端，释放 ${formatSize(res.freed)}`, 'success')
        await onRefresh()
      }
    } catch (e) {
      toast(`未删除：${(e as Error).message}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const kindLabel: Record<string, string> = { image: '图片', voice: '语音', file: '文件', text: '文字', system: '系统' }

  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet sheet-tall" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h3>存储空间</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="storage-meter">
          <div className="storage-bar">
            <div className={`storage-bar-fill ${pct >= 85 ? 'warn' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="storage-numbers">
            <span>
              已用 <b>{formatSize(used)}</b> / {formatSize(quota)}
            </span>
            <span className={pct >= 85 ? 'warn-text' : 'muted'}>{pct}%</span>
          </div>
        </div>

        <div className="seg-row">
          {(
            [
              ['all', '全部'],
              ['image', '图片'],
              ['voice', '语音'],
              ['file', '文件'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} className={`seg ${filter === key ? 'seg-on' : ''}`} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>

        <div className="sheet-body">
          {files.length === 0 && <p className="hint">暂无文件，空间很充足。</p>}
          {files.map((f) => (
            <div key={f.id} className="file-row">
              <div className="file-row-icon">{fileIcon(f.name, f.mime)}</div>
              <div className="file-row-main">
                <div className="file-row-name">{f.name}</div>
                <div className="file-row-meta">
                  {kindLabel[f.kind] || f.kind} · {formatSize(f.size)} · {new Date(f.created_at).toLocaleDateString('zh-CN')}
                </div>
              </div>
              <div className="file-row-actions">
                {confirmId === f.id ? (
                  <>
                    <button className="mini-btn danger" disabled={busyId === f.id} onClick={() => void removeOne(f)}>
                      确认删除
                    </button>
                    <button className="mini-btn" onClick={() => setConfirmId(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button className="mini-btn ghost" disabled={busyId === f.id} onClick={() => void saveThenRemove(f)}>
                      保存并删
                    </button>
                    <button className="mini-btn" disabled={busyId === f.id} onClick={() => setConfirmId(f.id)}>
                      删除
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="sheet-tip">按文件从大到小排列。「保存并删」会先下载到本机，确认落地后再删除云端文件。</p>
      </div>
    </div>
  )
}

export async function loadStorage(): Promise<StorageInfo | null> {
  return await storageUsage()
}