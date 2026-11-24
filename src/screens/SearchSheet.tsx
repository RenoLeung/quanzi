import { useEffect, useMemo, useState } from 'react'
import { fetchAttachments, searchAll, signUrl } from '../lib/api'
import { formatDay, formatSize } from '../lib/format'
import { fileIcon } from '../lib/media'
import type { Attachment, Message } from '../lib/types'
import { toast } from '../components/Toast'

interface Props {
  groupId: string
  onClose: () => void
  onOpenImage: (url: string) => void
}

export default function SearchSheet({ groupId, onClose, onOpenImage }: Props) {
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msgs, setMsgs] = useState<Message[]>([])
  const [atts, setAtts] = useState<Attachment[]>([])
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<'all' | 'text' | 'media'>('all')
  const [detail, setDetail] = useState<{ kind: 'msg' | 'att'; item: Message | Attachment } | null>(null)

  useEffect(() => {
    const kw = keyword.trim()
    if (!kw) {
      setMsgs([])
      setAtts([])
      return
    }
    const t = window.setTimeout(async () => {
      setBusy(true)
      try {
        const res = await searchAll(groupId, kw)
        setMsgs(res.messages)
        setAtts(res.attachments)
      } catch {
        toast('搜索失败，请重试', 'error')
      } finally {
        setBusy(false)
      }
    }, 320)
    return () => window.clearTimeout(t)
  }, [keyword, groupId])

  useEffect(() => {
    const need = atts.filter((a) => a.mime?.startsWith('image/') && !urls[a.path]).slice(0, 12)
    if (!need.length) return
    void (async () => {
      const pairs = await Promise.all(need.map(async (a) => ({ path: a.path, url: await signUrl(a.path) })))
      const next = { ...urls }
      pairs.forEach((p) => {
        if (p.url) next[p.path] = p.url
      })
      setUrls(next)
    })()
  }, [atts, urls])

  const showMsgs = useMemo(() => (tab === 'media' ? [] : msgs.filter((m) => m.kind === 'text')), [msgs, tab])
  const showAtts = useMemo(() => (tab === 'text' ? [] : atts), [atts, tab])
  const empty = !busy && keyword.trim() && showMsgs.length === 0 && showAtts.length === 0

  return (
    <div className="search-screen">
      <header className="search-header">
        <button className="icon-btn" onClick={onClose} aria-label="返回">
          ‹
        </button>
        <input
          className="search-input"
          autoFocus
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索聊天记录 / 文件名"
        />
        {keyword && (
          <button className="icon-btn" onClick={() => setKeyword('')}>
            ✕
          </button>
        )}
      </header>

      <div className="seg-row search-seg">
        {(
          [
            ['all', '全部'],
            ['text', '文字'],
            ['media', '图片/文件'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={`seg ${tab === key ? 'seg-on' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      <div className="search-body">
        {busy && <div className="search-hint">搜索中…</div>}
        {empty && <div className="search-hint">没有找到「{keyword}」相关的记录</div>}
        {!keyword && <div className="search-hint">输入关键词，可搜文字内容和文件名，中文按片段匹配</div>}

        {showMsgs.map((m) => (
          <button key={m.id} className="result-row" onClick={() => setDetail({ kind: 'msg', item: m })}>
            <div className="result-main">
              <div className="result-title">
                {m.sender_name}
                <span className="result-time">{formatDay(m.created_at)}</span>
              </div>
              <div className="result-text">{highlight(m.body || '', keyword)}</div>
            </div>
          </button>
        ))}

        {showAtts.map((a) => (
          <button key={a.id} className="result-row" onClick={() => setDetail({ kind: 'att', item: a })}>
            <div className="result-icon">
              {a.mime?.startsWith('image/') && urls[a.path] ? (
                <img src={urls[a.path]} alt="" />
              ) : (
                <span>{fileIcon(a.file_name, a.mime)}</span>
              )}
            </div>
            <div className="result-main">
              <div className="result-title">
                {highlight(a.file_name, keyword)}
                <span className="result-time">{formatDay(a.created_at)}</span>
              </div>
              <div className="result-text">
                {a.kind === 'voice' ? '语音' : a.kind === 'image' ? '图片' : '文件'} · {formatSize(a.size_bytes)}
              </div>
            </div>
          </button>
        ))}
      </div>

      {detail && (
        <div className="sheet-mask" onClick={() => setDetail(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="detail-body">
              {detail.kind === 'msg' ? (
                <>
                  <div className="detail-meta">
                    {(detail.item as Message).sender_name} · {formatDay((detail.item as Message).created_at)}
                  </div>
                  <div className="detail-text">{(detail.item as Message).body}</div>
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText((detail.item as Message).body || '')
                      toast('已复制', 'success')
                    }}
                  >
                    复制文字
                  </button>
                </>
              ) : (
                <>
                  <div className="detail-meta">
                    {formatDay((detail.item as Attachment).created_at)} · {formatSize((detail.item as Attachment).size_bytes)}
                  </div>
                  <div className="detail-text">{(detail.item as Attachment).file_name}</div>
                  <div className="detail-actions">
                    {(detail.item as Attachment).mime?.startsWith('image/') && (
                      <button
                        className="btn-ghost"
                        onClick={async () => {
                          const u = await signUrl((detail.item as Attachment).path)
                          if (u) {
                            setDetail(null)
                            onOpenImage(u)
                          }
                        }}
                      >
                        查看大图
                      </button>
                    )}
                    <button
                      className="btn-ghost"
                      onClick={async () => {
                        const a = detail.item as Attachment
                        const u = await signUrl(a.path, a.file_name)
                        if (!u) {
                          toast('文件已不可用', 'error')
                          return
                        }
                        const resp = await fetch(u)
                        const blob = await resp.blob()
                        const objectUrl = URL.createObjectURL(blob)
                        const link = document.createElement('a')
                        link.href = objectUrl
                        link.download = a.file_name
                        document.body.appendChild(link)
                        link.click()
                        link.remove()
                        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000)
                      }}
                    >
                      下载
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function highlight(text: string, kw: string) {
  const k = kw.trim()
  if (!k) return text
  const idx = text.toLowerCase().indexOf(k.toLowerCase())
  if (idx < 0) return text.slice(0, 80)
  const start = Math.max(0, idx - 18)
  const seg = text.slice(start, start + 90)
  return (
    <>
      {start > 0 && '…'}
      {seg.slice(0, idx - start)}
      <mark>{seg.slice(idx - start, idx - start + k.length)}</mark>
      {seg.slice(idx - start + k.length)}
      {start + 90 < text.length && '…'}
    </>
  )
}

export async function prefetchOne(groupId: string) {
  return await fetchAttachments(groupId, [])
}