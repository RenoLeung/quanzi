import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  currentUserId,
  fetchAttachments,
  fetchMessages,
  fetchReads,
  leaveGroup,
  listMembers,
  markReads,
  recallMessage,
  resetInviteCode,
  sendAttachment,
  sendText,
  signUrl,
  storageMeter,
  storageUsage,
  touchMember,
  uploadMedia,
} from '../lib/api'
import { errText } from '../lib/errors'
import { avatarColor, formatDay, formatDuration, formatSize, initial, uid } from '../lib/format'
import { compressImage, extFromName, fileIcon, isImageMime, pickAudioMime } from '../lib/media'
import { toast } from '../components/Toast'
import StorageSheet from '../components/StorageSheet'
import SearchSheet from './SearchSheet'
import type { Attachment, Group, LocalProfile, Member, Message, MsgKind, StorageInfo } from '../lib/types'

interface Props {
  profile: LocalProfile
  groups: Group[]
  isOwner: boolean
  onJoinedRefresh: () => Promise<Group[]>
  onSwitchGroup: (groupId: string) => Promise<void>
  onOwnerChange: (v: boolean) => void
  onCreateGroup: (name: string) => Promise<{ groupId: string; name: string; inviteCode: string } | null>
  onExitToJoin: () => void
  onResetIdentity: () => Promise<void>
}

const RECALL_WINDOW_MS = 2 * 60 * 1000

export default function ChatScreen({
  profile,
  groups,
  isOwner,
  onSwitchGroup,
  onCreateGroup,
  onExitToJoin,
  onResetIdentity,
}: Props) {
  const me = profile.userId
  const gid = profile.groupId
  const group = groups.find((g) => g.id === gid)

  const [messages, setMessages] = useState<Message[]>([])
  const [attByMsg, setAttByMsg] = useState<Record<string, Attachment>>({})
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [members, setMembers] = useState<Member[]>([])
  const [reads, setReads] = useState<Record<string, string[]>>({})
  const [onlineIds, setOnlineIds] = useState<string[]>([])
  const [typingMap, setTypingMap] = useState<Record<string, number>>({})
  const [conn, setConn] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [draft, setDraft] = useState('')
  const [uploading, setUploading] = useState<string | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showStorage, setShowStorage] = useState(false)
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<Message | null>(null)
  const [inviteCode, setInviteCode] = useState(group?.invite_code || '')
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [creating, setCreating] = useState(false)
  const [confirmKind, setConfirmKind] = useState<null | 'leave' | 'reset'>(null)
  const [, forceTick] = useState(0)

  const listRef = useRef<HTMLDivElement | null>(null)
  const urlsRef = useRef<Record<string, string>>({})
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const typingSentRef = useRef(0)
  const imgInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recMimeRef = useRef<{ mime: string; ext: string }>({ mime: '', ext: 'webm' })
  const recTimerRef = useRef<number | null>(null)
  const recSecsRef = useRef(0)
  const recCancelRef = useRef(false)

  useEffect(() => {
    setInviteCode(group?.invite_code || '')
  }, [group?.invite_code])

  const scrollToBottom = useCallback((smooth = true) => {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const nearBottom = useCallback(() => {
    const el = listRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 140
  }, [])

  const hydrateUrls = useCallback(async (atts: Attachment[]) => {
    const need = atts.filter((a) => !a.deleted_at && a.path && !urlsRef.current[a.path]).slice(0, 24)
    if (!need.length) return
    const results = await Promise.all(
      need.map(async (a) => ({ path: a.path, url: await signUrl(a.path) })),
    )
    let changed = false
    for (const r of results) {
      if (r.url) {
        urlsRef.current[r.path] = r.url
        changed = true
      }
    }
    if (changed) setUrls({ ...urlsRef.current })
  }, [])

  const upsertMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      const idx = prev.findIndex(
        (m) => m.id === msg.id || (msg.client_msg_id != null && m.client_msg_id === msg.client_msg_id),
      )
      if (idx >= 0) {
        const copy = prev.slice()
        copy[idx] = msg
        return copy
      }
      return [...prev, msg]
    })
  }, [])

  const loadInitial = useCallback(async () => {
    const [mList, msgs] = await Promise.all([listMembers(gid), fetchMessages(gid)])
    setMembers(mList)
    setMessages(msgs)
    const ids = msgs.map((m) => m.id)
    const [atts, rds] = await Promise.all([fetchAttachments(gid, ids), fetchReads(gid, ids)])
    const map: Record<string, Attachment> = {}
    atts.forEach((a) => {
      if (a.message_id) map[a.message_id] = a
    })
    setAttByMsg(map)
    const readMap: Record<string, string[]> = {}
    rds.forEach((r) => {
      readMap[r.message_id] = [...(readMap[r.message_id] || []), r.user_id]
    })
    setReads(readMap)
    void hydrateUrls(atts)
    setLoading(false)
    requestAnimationFrame(() => scrollToBottom(false))
  }, [gid, hydrateUrls, scrollToBottom])

  useEffect(() => {
    setLoading(true)
    setHasMore(true)
    void loadInitial()
  }, [loadInitial])

  // 实时：WebSocket 订阅（消息 / 已读 / 成员 / 附件 / 在线 / 输入中）
  useEffect(() => {
    const channel = supabase.channel(`grp:${gid}`, { config: { presence: { key: me } } })
    channelRef.current = channel

    channel
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `group_id=eq.${gid}` }, (p) => {
        const msg = p.new as Message
        upsertMessage(msg)
        if (nearBottom()) requestAnimationFrame(() => scrollToBottom())
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `group_id=eq.${gid}` }, (p) => {
        upsertMessage(p.new as Message)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reads', filter: `group_id=eq.${gid}` }, (p) => {
        const r = p.new as { message_id: string; user_id: string }
        setReads((prev) => {
          const cur = prev[r.message_id] || []
          if (cur.includes(r.user_id)) return prev
          return { ...prev, [r.message_id]: [...cur, r.user_id] }
        })
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'members', filter: `group_id=eq.${gid}` }, () => {
        void listMembers(gid).then(setMembers)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attachments', filter: `group_id=eq.${gid}` }, (p) => {
        const a = p.new as Attachment
        if (!a.message_id) return
        setAttByMsg((prev) => ({ ...prev, [a.message_id as string]: a }))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'attachments', filter: `group_id=eq.${gid}` }, (p) => {
        const a = p.new as Attachment
        if (a.message_id) setAttByMsg((prev) => ({ ...prev, [a.message_id as string]: a }))
        if (!a.deleted_at) void hydrateUrls([a])
        else setAttByMsg((prev) => ({ ...prev }))
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState() as Record<string, unknown[]>
        setOnlineIds(Object.keys(state))
      })
      .on('broadcast', { event: 'typing' }, ({ payload }: { payload?: { userId?: string } }) => {
        if (!payload?.userId || payload.userId === me) return
        setTypingMap((prev) => ({ ...prev, [payload.userId as string]: Date.now() }))
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setConn('online')
          void channel.track({ nickname: profile.nickname })
          void touchMember(gid)
          // 断线重连后补拉一次，避免漏消息
          void loadInitial()
        } else if (status === 'CLOSED') {
          setConn('offline')
        } else {
          setConn('connecting')
        }
      })

    const tick = window.setInterval(() => forceTick((t) => t + 1), 3000)

    return () => {
      window.clearInterval(tick)
      channelRef.current = null
      void supabase.removeChannel(channel)
    }
  }, [gid, me, profile.nickname, upsertMessage, nearBottom, scrollToBottom, hydrateUrls, loadInitial])

  // 已读回执：看到别人消息就上报
  useEffect(() => {
    if (loading) return
    const pending = messages
      .filter((m) => m.sender_id !== me && !m.recalled_at && m.kind !== 'system' && !(reads[m.id] || []).includes(me))
      .map((m) => m.id)
    if (!pending.length) return
    const t = window.setTimeout(() => {
      void markReads(gid, pending.slice(-40))
    }, 800)
    return () => window.clearTimeout(t)
  }, [messages, reads, loading, me, gid])

  const loadOlder = useCallback(async () => {
    if (loadingMore || !messages.length || !hasMore) return
    setLoadingMore(true)
    const el = listRef.current
    const prevHeight = el?.scrollHeight || 0
    try {
      const older = await fetchMessages(gid, messages[0].created_at)
      if (!older.length) {
        setHasMore(false)
        return
      }
      const ids = older.map((m) => m.id)
      const [atts, rds] = await Promise.all([fetchAttachments(gid, ids), fetchReads(gid, ids)])
      const addMap: Record<string, Attachment> = {}
      atts.forEach((a) => {
        if (a.message_id) addMap[a.message_id] = a
      })
      setAttByMsg((prev) => ({ ...addMap, ...prev }))
      setReads((prev) => {
        const next = { ...prev }
        rds.forEach((r) => {
          const cur = next[r.message_id] || []
          if (!cur.includes(r.user_id)) next[r.message_id] = [...cur, r.user_id]
        })
        return next
      })
      void hydrateUrls(atts)
      setMessages((prev) => [...older, ...prev])
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight
      })
    } finally {
      setLoadingMore(false)
    }
  }, [gid, hasMore, loadingMore, messages, hydrateUrls])

  function onScroll() {
    const el = listRef.current
    if (!el) return
    if (el.scrollTop < 80) void loadOlder()
  }

  async function doSendText() {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const cid = uid()
    const optimistic: Message = {
      id: `tmp-${cid}`,
      group_id: gid,
      sender_id: me,
      sender_name: profile.nickname,
      kind: 'text',
      body: text,
      recalled_at: null,
      client_msg_id: cid,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])
    requestAnimationFrame(() => scrollToBottom())
    try {
      const real = await sendText(gid, profile.nickname, text, cid)
      upsertMessage(real)
      void touchMember(gid)
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
      toast(`发送失败：${(e as Error).message}`, 'error')
    }
  }

  async function sendMedia(kind: MsgKind, blob: Blob, name: string, mime: string, durationMs?: number | null) {
    const meter = await storageMeter()
    if (meter && meter.used + blob.size > meter.quota) {
      toast('圈子存储空间已满，请先清理', 'error')
      if (isOwner) await openStorage()
      return
    }
    setUploading(name)
    try {
      const ext = kind === 'image' ? 'jpg' : extFromName(name, kind === 'voice' ? 'webm' : 'bin')
      const { path, size } = await uploadMedia(gid, blob, ext)
      const res = await sendAttachment({
        groupId: gid,
        kind,
        path,
        name,
        mime,
        size,
        durationMs: durationMs ?? null,
        clientMsgId: uid(),
      })
      if (!res.ok) {
        toast(errText(res.error), 'error')
        return
      }
      upsertMessage(res.message)
      setAttByMsg((prev) => ({ ...prev, [res.message.id]: res.attachment }))
      void hydrateUrls([res.attachment])
      requestAnimationFrame(() => scrollToBottom())
      if (isOwner && meter && (meter.used + size) / meter.quota >= 0.85) {
        toast('存储已用超过 85%，建议清理大文件', 'info')
        await openStorage()
      }
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setUploading(null)
    }
  }

  async function onImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const { blob, ext } = await compressImage(file)
      await sendMedia('image', blob, file.name.replace(/\.[^.]+$/, '') + '.' + ext, 'image/jpeg')
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 50 * 1024 * 1024) {
      toast('单个文件不能超过 50MB（Supabase 免费版限制）', 'error')
      return
    }
    await sendMedia('file', file, file.name, file.type || 'application/octet-stream')
  }

  async function startRecording() {
    if (recording) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      const { mime, ext } = pickAudioMime()
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      recMimeRef.current = { mime: mime || rec.mimeType || 'audio/webm', ext }
      chunksRef.current = []
      recCancelRef.current = false
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        void finishRecording()
      }
      rec.start()
      recRef.current = rec
      recSecsRef.current = 0
      setRecSecs(0)
      setRecording(true)
      recTimerRef.current = window.setInterval(() => {
        recSecsRef.current += 1
        setRecSecs(recSecsRef.current)
        if (recSecsRef.current >= 60) stopRecording(false)
      }, 1000)
    } catch {
      toast('无法使用麦克风，请检查浏览器权限', 'error')
    }
  }

  function stopRecording(cancel: boolean) {
    recCancelRef.current = cancel
    if (recTimerRef.current) {
      window.clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
    setRecording(false)
    const rec = recRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    recRef.current = null
  }

  async function finishRecording() {
    const chunks = chunksRef.current
    chunksRef.current = []
    const secs = recSecsRef.current
    if (recCancelRef.current || !chunks.length || secs < 1) return
    const { mime, ext } = recMimeRef.current
    const blob = new Blob(chunks, { type: mime || 'audio/webm' })
    await sendMedia('voice', blob, `语音-${secs}s.${ext}`, mime || 'audio/webm', secs * 1000)
  }

  async function openStorage() {
    const info = await storageUsage()
    setStorageInfo(info)
    setShowStorage(true)
  }

  async function doRecall(m: Message) {
    setActionMsg(null)
    try {
      await recallMessage(m.id)
      toast('已撤回', 'success')
    } catch (e) {
      toast(errText((e as Error).message), 'error')
    }
  }

  async function doLeaveGroup() {
    setConfirmKind(null)
    try {
      await leaveGroup(gid)
      toast('已退出这个圈子', 'success')
      onExitToJoin()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  async function doCreateNewGroup() {
    const name = newGroupName.trim()
    if (!name) {
      toast('请输入群名', 'error')
      return
    }
    setCreating(true)
    try {
      const res = await onCreateGroup(name)
      if (res) {
        setShowNewGroup(false)
        setShowInfo(false)
        setNewGroupName('')
      }
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setCreating(false)
    }
  }

  async function doResetInvite() {
    try {
      const res = await resetInviteCode(gid)
      if (!res.ok) {
        toast(errText(res.error), 'error')
        return
      }
      setInviteCode(res.invite_code)
      toast('邀请码已更新', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const typingNames = useMemo(() => {
    const now = Date.now()
    return Object.entries(typingMap)
      .filter(([uidKey, ts]) => now - ts < 4000 && uidKey !== me)
      .map(([uidKey]) => members.find((m) => m.user_id === uidKey)?.nickname || '有人')
  }, [typingMap, members, me])

  const others = Math.max(0, members.length - 1)

  if (loading) {
    return (
      <div className="screen chat-screen">
        <div className="chat-loading">正在进入「{profile.groupName}」…</div>
      </div>
    )
  }

  return (
    <div className="screen chat-screen">
      <header className="chat-header">
        <div className="chat-title">
          <div className="chat-title-main">
            {profile.groupName}
            <span className="member-badge">{members.length}/10</span>
          </div>
          <div className="chat-sub">
            {conn === 'online' ? (
              typingNames.length ? (
                <span className="typing-hint">{typingNames.join('、')} 正在输入…</span>
              ) : (
                <span>{onlineIds.length} 人在线</span>
              )
            ) : conn === 'connecting' ? (
              <span className="reconnect">连接中…</span>
            ) : (
              <span className="reconnect">已断开，正在重连…</span>
            )}
          </div>
        </div>
        <button className="icon-btn" onClick={() => setShowSearch(true)} aria-label="搜索">
          🔍
        </button>
        <button className="icon-btn" onClick={() => setShowInfo(true)} aria-label="群信息与入口">
          ☰
        </button>
      </header>

      <div className="msg-list" ref={listRef} onScroll={onScroll}>
        {loadingMore && <div className="load-more">加载更早的消息…</div>}
        {!hasMore && <div className="load-more muted">没有更早的消息了</div>}

        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const showDay = !prev || formatDay(prev.created_at).slice(0, 6) !== formatDay(m.created_at).slice(0, 6)
          const mine = m.sender_id === me
          return (
            <div key={m.id}>
              {showDay && <div className="day-sep">{formatDay(m.created_at)}</div>}
              <MessageRow
                m={m}
                mine={mine}
                att={attByMsg[m.id]}
                url={attByMsg[m.id] ? urls[attByMsg[m.id]!.path] : undefined}
                readBy={reads[m.id] || []}
                others={others}
                onLongPress={() => setActionMsg(m)}
                onOpenImage={(u) => setViewerUrl(u)}
                onOpenStorage={() => void openStorage()}
              />
            </div>
          )
        })}

        {uploading && (
          <div className="uploading-row">
            <span className="spinner" /> 正在上传 {uploading}
          </div>
        )}
        <div className="list-tail" />
      </div>

      <div className="composer">
        <button className="comp-btn" onClick={() => void startRecording()} aria-label="语音">
          🎤
        </button>
        <button className="comp-btn" onClick={() => imgInputRef.current?.click()} aria-label="图片">
          🖼️
        </button>
        <button className="comp-btn" onClick={() => fileInputRef.current?.click()} aria-label="文件">
          📎
        </button>
        <textarea
          className="comp-input"
          rows={1}
          value={draft}
          placeholder="说点什么…"
          onChange={(e) => {
            setDraft(e.target.value)
            const now = Date.now()
            if (channelRef.current && now - typingSentRef.current > 1200) {
              typingSentRef.current = now
              void channelRef.current.send({
                type: 'broadcast',
                event: 'typing',
                payload: { userId: me, nickname: profile.nickname },
              })
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void doSendText()
            }
          }}
        />
        <button className="send-btn" disabled={!draft.trim()} onClick={() => void doSendText()}>
          发送
        </button>
        <input ref={imgInputRef} type="file" accept="image/*" hidden onChange={onImagePicked} />
        <input ref={fileInputRef} type="file" hidden onChange={onFilePicked} />
      </div>

      {recording && (
        <div className="rec-mask">
          <div className="rec-card">
            <div className="rec-dot" />
            <div className="rec-time">{formatDuration(recSecs * 1000)}</div>
            <div className="rec-hint">正在录音，最长 60 秒</div>
            <div className="rec-actions">
              <button className="btn-ghost" onClick={() => stopRecording(true)}>
                取消
              </button>
              <button className="btn-primary" onClick={() => stopRecording(false)}>
                发送
              </button>
            </div>
          </div>
        </div>
      )}

      {viewerUrl && (
        <div className="viewer" onClick={() => setViewerUrl(null)}>
          <img src={viewerUrl} alt="" />
          <button className="viewer-close" onClick={() => setViewerUrl(null)}>
            ✕
          </button>
        </div>
      )}

      {actionMsg && (
        <div className="sheet-mask" onClick={() => setActionMsg(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            {actionMsg.sender_id === me &&
              !actionMsg.recalled_at &&
              Date.now() - new Date(actionMsg.created_at).getTime() < RECALL_WINDOW_MS && (
                <button className="sheet-item danger" onClick={() => void doRecall(actionMsg)}>
                  撤回消息
                </button>
              )}
            {actionMsg.kind === 'text' && actionMsg.body && (
              <button
                className="sheet-item"
                onClick={() => {
                  void navigator.clipboard.writeText(actionMsg.body || '')
                  toast('已复制', 'success')
                  setActionMsg(null)
                }}
              >
                复制文字
              </button>
            )}
            <button className="sheet-item" onClick={() => setActionMsg(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {showInfo && (
        <div className="sheet-mask" onClick={() => setShowInfo(false)}>
          <div className="sheet sheet-tall" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-head">
              <h3>群信息</h3>
              <button className="icon-btn" onClick={() => setShowInfo(false)}>
                ✕
              </button>
            </div>
            <div className="sheet-body">
              <div className="info-block">
                <div className="info-label">群名称</div>
                <div className="info-value">{profile.groupName}</div>
              </div>

              <div className="info-block">
                <div className="info-label">我的圈子</div>
                <div className="nav-list">
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      className={`nav-row ${g.id === gid ? 'on' : ''}`}
                      onClick={() => {
                        if (g.id === gid) return
                        setShowInfo(false)
                        void onSwitchGroup(g.id)
                      }}
                    >
                      <span className="nav-row-name">{g.name}</span>
                      <span className="nav-row-tag">{g.id === gid ? '当前' : '进入'}</span>
                    </button>
                  ))}
                  {isOwner && (
                    <button
                      className="nav-row new"
                      onClick={() => {
                        setShowInfo(false)
                        setShowNewGroup(true)
                      }}
                    >
                      <span className="nav-row-name">＋ 新建圈子</span>
                      <span className="nav-row-tag">主控人</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="info-block">
                <div className="info-label">邀请码</div>
                {isOwner ? (
                  <>
                    <div className="invite-box">
                      <span className="invite-code">{inviteCode || '—'}</span>
                      <button
                        className="mini-btn"
                        onClick={() => {
                          void navigator.clipboard.writeText(inviteCode)
                          toast('邀请码已复制', 'success')
                        }}
                      >
                        复制
                      </button>
                    </div>
                    <div className="invite-actions">
                      <button className="mini-btn ghost" onClick={() => void doResetInvite()}>
                        重新生成邀请码
                      </button>
                    </div>
                    <p className="sheet-tip">只有主控人能生成邀请码，旧码立即失效。</p>
                  </>
                ) : (
                  <div className="info-value muted">邀请码由主控人生成，需要时找群主获取</div>
                )}
              </div>

              <div className="info-block">
                <div className="info-label">成员 {members.length}/10</div>
                <div className="member-list">
                  {members.map((m) => (
                    <div key={m.id} className="member-row">
                      <span className="avatar avatar-sm" style={{ background: avatarColor(m.user_id) }}>
                        {initial(m.nickname)}
                      </span>
                      <span className="member-name">
                        {m.nickname}
                        {m.role === 'owner' && <span className="role-tag">主控人</span>}
                        {m.user_id === me && <span className="role-tag me">我</span>}
                      </span>
                      <span className={`presence ${onlineIds.includes(m.user_id) ? 'on' : ''}`} />
                    </div>
                  ))}
                </div>
              </div>

              {isOwner && (
                <button className="sheet-item" onClick={() => void openStorage()}>
                  🗄️ 存储空间管理
                </button>
              )}

              <div className="info-block">
                <div className="info-label">本机</div>
                <div className="nav-list">
                  <button
                    className="nav-row"
                    onClick={() => {
                      setShowInfo(false)
                      onExitToJoin()
                    }}
                  >
                    <span className="nav-row-name">回到入口页</span>
                    <span className="nav-row-tag">换圈子 / 重新加入</span>
                  </button>
                  <button className="nav-row" onClick={() => setConfirmKind('leave')}>
                    <span className="nav-row-name">退出这个圈子</span>
                    <span className="nav-row-tag">历史消息保留</span>
                  </button>
                  <button className="nav-row danger" onClick={() => setConfirmKind('reset')}>
                    <span className="nav-row-name">重置本机身份</span>
                    <span className="nav-row-tag">清除本机登录</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showStorage && (
        <StorageSheet
          info={storageInfo}
          onClose={() => setShowStorage(false)}
          onRefresh={async () => setStorageInfo(await storageUsage())}
        />
      )}

      {showSearch && (
        <SearchSheet groupId={gid} onClose={() => setShowSearch(false)} onOpenImage={(u) => setViewerUrl(u)} />
      )}

      {showNewGroup && (
        <div className="sheet-mask" onClick={() => setShowNewGroup(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-head">
              <h3>新建圈子</h3>
              <button className="icon-btn" onClick={() => setShowNewGroup(false)}>
                ✕
              </button>
            </div>
            <label className="field">
              <span className="field-label">群名</span>
              <input
                className="input"
                value={newGroupName}
                maxLength={30}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="例如：老友记"
              />
            </label>
            <button className="btn-primary" disabled={creating} onClick={() => void doCreateNewGroup()}>
              {creating ? '正在创建…' : '创建并进入'}
            </button>
            <p className="sheet-tip">只有主控人能新建圈子，创建后会生成一个新的邀请码。</p>
          </div>
        </div>
      )}

      {confirmKind && (
        <div className="sheet-mask" onClick={() => setConfirmKind(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-head">
              <h3>{confirmKind === 'leave' ? '退出这个圈子？' : '重置本机身份？'}</h3>
              <button className="icon-btn" onClick={() => setConfirmKind(null)}>
                ✕
              </button>
            </div>
            <p className="sheet-tip">
              {confirmKind === 'leave'
                ? '退出后你不再是成员，群里的历史消息仍保留；重新用邀请码可以再加入。'
                : '会清除这台设备上的登录身份与当前圈子，下次进入需要用邀请码重新加入。'}
            </p>
            <div className="confirm-actions">
              <button className="btn-ghost" onClick={() => setConfirmKind(null)}>
                取消
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  if (confirmKind === 'leave') void doLeaveGroup()
                  else {
                    setConfirmKind(null)
                    void onResetIdentity()
                  }
                }}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface RowProps {
  m: Message
  mine: boolean
  att?: Attachment
  url?: string
  readBy: string[]
  others: number
  onLongPress: () => void
  onOpenImage: (url: string) => void
  onOpenStorage: () => void
}

function MessageRow({ m, mine, att, url, readBy, others, onLongPress, onOpenImage, onOpenStorage }: RowProps) {
  const pressTimer = useRef<number | null>(null)

  function startPress() {
    if (pressTimer.current) window.clearTimeout(pressTimer.current)
    pressTimer.current = window.setTimeout(onLongPress, 460)
  }
  function clearPress() {
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  if (m.kind === 'system') {
    return <div className="sys-msg">{m.body}</div>
  }

  const recalled = !!m.recalled_at

  return (
    <div
      className={`msg-row ${mine ? 'mine' : ''}`}
      onTouchStart={startPress}
      onTouchEnd={clearPress}
      onTouchMove={clearPress}
      onContextMenu={(e) => {
        e.preventDefault()
        onLongPress()
      }}
    >
      {!mine && (
        <span className="avatar" style={{ background: avatarColor(m.sender_id) }}>
          {initial(m.sender_name)}
        </span>
      )}
      <div className={`msg-col ${mine ? 'right' : ''}`}>
        {!mine && <div className="sender">{m.sender_name}</div>}
        <div className={`bubble ${mine ? 'bubble-mine' : ''} ${recalled ? 'bubble-recalled' : ''}`}>
          {recalled ? (
            <span className="recalled-text">{mine ? '你撤回了一条消息' : `${m.sender_name} 撤回了一条消息`}</span>
          ) : m.kind === 'text' ? (
            <span className="text">{m.body}</span>
          ) : m.kind === 'image' ? (
            att && att.deleted_at ? (
              <span className="cleared">图片已清理</span>
            ) : url ? (
              <img className="bubble-img" src={url} alt={m.body || '图片'} onClick={() => onOpenImage(url)} />
            ) : (
              <span className="cleared">图片加载中…</span>
            )
          ) : m.kind === 'voice' ? (
            att && att.deleted_at ? (
              <span className="cleared">语音已清理</span>
            ) : url ? (
              <VoicePlayer url={url} durationMs={att?.duration_ms || 0} mine={mine} />
            ) : (
              <span className="cleared">语音加载中…</span>
            )
          ) : att && att.deleted_at ? (
            <span className="cleared">文件已清理</span>
          ) : (
            <FileCard att={att} name={m.body || att?.file_name || '文件'} onCleaned={onOpenStorage} />
          )}
        </div>
        <div className="msg-meta">
          {formatDay(m.created_at)}
          {mine && !recalled && readBy.filter((u) => u !== m.sender_id).length > 0 && (
            <span className="read-tag">
              已读 {readBy.filter((u) => u !== m.sender_id).length}/{others}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function VoicePlayer({ url, durationMs, mine }: { url: string; durationMs: number; mine: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)

  return (
    <div className={`voice ${mine ? 'voice-mine' : ''}`}>
      <button
        className="voice-btn"
        onClick={() => {
          const el = audioRef.current
          if (!el) return
          if (playing) {
            el.pause()
          } else {
            void el.play()
          }
        }}
        aria-label={playing ? '暂停' : '播放'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="voice-wave">
        {Array.from({ length: 14 }).map((_, i) => (
          <span
            key={i}
            className="wave-bar"
            style={{
              height: `${6 + ((i * 7) % 16)}px`,
              opacity: progress * 14 > i ? 1 : 0.35,
            }}
          />
        ))}
      </div>
      <span className="voice-dur">{formatDuration(durationMs)}</span>
      <audio
        ref={audioRef}
        src={url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setProgress(0)
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget
          if (el.duration && Number.isFinite(el.duration)) setProgress(el.currentTime / el.duration)
        }}
      />
    </div>
  )
}

function FileCard({ att, name, onCleaned }: { att?: Attachment; name: string; onCleaned: () => void }) {
  const [busy, setBusy] = useState(false)

  async function download() {
    if (!att) return
    setBusy(true)
    try {
      const url = await signUrl(att.path, att.file_name)
      if (!url) {
        toast('文件已不可用', 'error')
        return
      }
      const resp = await fetch(url)
      const blob = await resp.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = att.file_name
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000)
    } catch {
      toast('下载失败，请稍后再试', 'error')
      onCleaned()
    } finally {
      setBusy(false)
    }
  }

  if (!att) {
    return (
      <div className="file-card">
        <div className="file-icon">{isImageMime('') ? '🖼️' : '📎'}</div>
        <div className="file-info">
          <div className="file-name">{name}</div>
          <div className="file-size">接收中…</div>
        </div>
      </div>
    )
  }

  return (
    <button className="file-card" onClick={() => void download()} disabled={busy}>
      <div className="file-icon">{fileIcon(att.file_name, att.mime)}</div>
      <div className="file-info">
        <div className="file-name">{att.file_name}</div>
        <div className="file-size">
          {formatSize(att.size_bytes)} · {busy ? '准备中…' : '点击下载'}
        </div>
      </div>
    </button>
  )
}

export async function whoAmI() {
  return await currentUserId()
}