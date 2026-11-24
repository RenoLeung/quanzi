import { supabase, MEDIA_BUCKET } from './supabase'
import type { Attachment, Group, Member, Message, MsgKind, RpcResult, StorageInfo } from './types'

export async function ensureSession() {
  const { data } = await supabase.auth.getSession()
  if (data.session) return data.session
  const { data: created, error } = await supabase.auth.signInAnonymously()
  if (error) throw new Error('创建会话失败：' + error.message)
  return created.session
}

export async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser()
  if (data.user?.id) return data.user.id
  const s = await ensureSession()
  return s!.user.id
}

export async function fetchOwnerState(): Promise<{ claimed: boolean; is_owner: boolean }> {
  const { data, error } = await supabase.rpc('owner_state')
  if (error) return { claimed: false, is_owner: false }
  return data as { claimed: boolean; is_owner: boolean }
}

export async function claimOwner(pass: string): Promise<RpcResult> {
  const { data, error } = await supabase.rpc('claim_owner', { p_pass: pass })
  if (error) throw new Error(error.message)
  return data as RpcResult
}

export async function joinGroup(code: string, nickname: string): Promise<RpcResult<{ group_id: string; group_name: string; nickname: string; invite_code?: string }>> {
  const { data, error } = await supabase.rpc('join_group', { p_code: code, p_nickname: nickname })
  if (error) throw new Error(error.message)
  return data as RpcResult<{ group_id: string; group_name: string; nickname: string; invite_code?: string }>
}

export async function createGroup(name: string): Promise<RpcResult<{ group_id: string; name: string; invite_code: string }>> {
  const { data, error } = await supabase.rpc('create_group', { p_name: name })
  if (error) throw new Error(error.message)
  return data as RpcResult<{ group_id: string; name: string; invite_code: string }>
}

export async function resetInviteCode(groupId: string): Promise<RpcResult<{ invite_code: string }>> {
  const { data, error } = await supabase.rpc('reset_invite_code', { p_group: groupId })
  if (error) throw new Error(error.message)
  return data as RpcResult<{ invite_code: string }>
}

export async function listGroups(): Promise<Group[]> {
  const { data, error } = await supabase
    .from('groups')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data || []) as Group[]
}

export async function listMembers(groupId: string): Promise<Member[]> {
  const { data, error } = await supabase
    .from('members')
    .select('id, group_id, user_id, nickname, role, joined_at, last_seen_at')
    .eq('group_id', groupId)
    .order('joined_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data || []) as Member[]
}

export async function fetchMessages(groupId: string, before?: string, limit = 60): Promise<Message[]> {
  let q = supabase
    .from('messages')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (before) q = q.lt('created_at', before)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return ((data || []) as Message[]).slice().reverse()
}

export async function fetchAttachments(groupId: string, messageIds: string[]): Promise<Attachment[]> {
  if (!messageIds.length) return []
  const { data, error } = await supabase
    .from('attachments')
    .select('*')
    .eq('group_id', groupId)
    .in('message_id', messageIds)
  if (error) return []
  return (data || []) as Attachment[]
}

export async function fetchReads(groupId: string, messageIds: string[]): Promise<{ message_id: string; user_id: string }[]> {
  if (!messageIds.length) return []
  const { data, error } = await supabase
    .from('message_reads')
    .select('message_id, user_id')
    .eq('group_id', groupId)
    .in('message_id', messageIds)
  if (error) return []
  return (data || []) as { message_id: string; user_id: string }[]
}

export async function sendText(groupId: string, nickname: string, body: string, clientMsgId: string): Promise<Message> {
  const uid = await currentUserId()
  const { data, error } = await supabase
    .from('messages')
    .insert({ group_id: groupId, sender_id: uid, sender_name: nickname, kind: 'text', body, client_msg_id: clientMsgId })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as Message
}

export async function uploadMedia(groupId: string, blob: Blob, ext: string): Promise<{ path: string; size: number }> {
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const path = `${groupId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, blob, {
    contentType: blob.type || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error('上传失败：' + error.message)
  return { path, size: blob.size }
}

export async function sendAttachment(params: {
  groupId: string
  kind: MsgKind
  path: string
  name: string
  mime: string
  size: number
  durationMs?: number | null
  clientMsgId: string
}): Promise<RpcResult<{ message: Message; attachment: Attachment }>> {
  const { data, error } = await supabase.rpc('send_attachment', {
    p_group: params.groupId,
    p_kind: params.kind,
    p_path: params.path,
    p_name: params.name,
    p_mime: params.mime,
    p_size: params.size,
    p_duration: params.durationMs ?? null,
    p_client_id: params.clientMsgId,
  })
  if (error) throw new Error(error.message)
  return data as RpcResult<{ message: Message; attachment: Attachment }>
}

export async function recallMessage(id: string): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update({ recalled_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function markReads(groupId: string, messageIds: string[]): Promise<void> {
  if (!messageIds.length) return
  const uid = await currentUserId()
  const rows = messageIds.map((id) => ({ message_id: id, user_id: uid, group_id: groupId }))
  const { error } = await supabase.from('message_reads').upsert(rows, {
    onConflict: 'message_id,user_id',
    ignoreDuplicates: true,
  })
  if (error) {
    // 已读回执失败不阻塞聊天
    console.warn('markReads', error.message)
  }
}

export async function searchAll(groupId: string, keyword: string): Promise<{ messages: Message[]; attachments: Attachment[] }> {
  const like = `%${keyword.replace(/[%_]/g, (m) => '\\' + m)}%`
  const [msgs, atts] = await Promise.all([
    supabase
      .from('messages')
      .select('*')
      .eq('group_id', groupId)
      .ilike('body', like)
      .order('created_at', { ascending: false })
      .limit(80),
    supabase
      .from('attachments')
      .select('*')
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .ilike('file_name', like)
      .order('created_at', { ascending: false })
      .limit(80),
  ])
  return {
    messages: ((msgs.data || []) as Message[]).filter((m) => !m.recalled_at),
    attachments: (atts.data || []) as Attachment[],
  }
}

export async function storageMeter(): Promise<{ used: number; quota: number; ratio: number } | null> {
  const { data, error } = await supabase.rpc('storage_meter')
  if (error || !data || !(data as { ok: boolean }).ok) return null
  const d = data as { used: number; quota: number; ratio: number }
  return d
}

export async function storageUsage(): Promise<StorageInfo | null> {
  const { data, error } = await supabase.rpc('storage_usage')
  if (error || !data) return null
  const d = data as StorageInfo
  return d.ok ? d : null
}

export async function deleteAttachment(id: string, path?: string): Promise<{ ok: boolean; freed: number }> {
  // Supabase 不允许直接删除 storage.objects，必须走 Storage API（RLS 仅放行主控人）
  if (path) {
    const { error: rmErr } = await supabase.storage.from(MEDIA_BUCKET).remove([path])
    if (rmErr) throw new Error(`删除云端文件失败：${rmErr.message}`)
  }
  const { data, error } = await supabase.rpc('delete_attachment', { p_id: id })
  if (error) throw new Error(error.message)
  return data as { ok: boolean; freed: number }
}

export async function signUrl(path: string, downloadAs?: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(path, 3600, downloadAs ? { download: downloadAs } : undefined)
  if (error) return null
  return data?.signedUrl ?? null
}

export async function leaveGroup(groupId: string): Promise<void> {
  const uid = await currentUserId()
  const { error } = await supabase.from('members').delete().eq('group_id', groupId).eq('user_id', uid)
  if (error) throw new Error(error.message)
}


export async function renameGroup(groupId: string, name: string): Promise<RpcResult<{ name: string }>> {
  const { data, error } = await supabase.rpc('rename_group', { p_group: groupId, p_name: name })
  if (error) throw new Error(error.message)
  return data as RpcResult<{ name: string }>
}

export async function renameSelf(groupId: string, nickname: string): Promise<RpcResult<{ nickname: string }>> {
  const { data, error } = await supabase.rpc('rename_self', { p_group: groupId, p_nick: nickname })
  if (error) throw new Error(error.message)
  return data as RpcResult<{ nickname: string }>
}

export async function adminRenameMember(
  groupId: string,
  userId: string,
  nickname: string,
): Promise<RpcResult<{ nickname: string; old: string }>> {
  const { data, error } = await supabase.rpc('admin_rename_member', {
    p_group: groupId,
    p_user: userId,
    p_nick: nickname,
  })
  if (error) throw new Error(error.message)
  return data as RpcResult<{ nickname: string; old: string }>
}

export async function kickMember(groupId: string, userId: string): Promise<RpcResult<{ nickname: string }>> {
  const { data, error } = await supabase.rpc('kick_member', { p_group: groupId, p_user: userId })
  if (error) throw new Error(error.message)
  return data as RpcResult<{ nickname: string }>
}

export async function deleteGroup(groupId: string): Promise<RpcResult> {
  // 先按官方 Storage API 清掉群内文件（RLS 只放行主控人），再删除群与关联记录
  const { data: atts } = await supabase.from('attachments').select('path').eq('group_id', groupId)
  const paths = ((atts || []) as { path: string }[]).map((a) => a.path).filter(Boolean)
  for (let i = 0; i < paths.length; i += 50) {
    const { error: rmErr } = await supabase.storage.from(MEDIA_BUCKET).remove(paths.slice(i, i + 50))
    if (rmErr) throw new Error(`清理群文件失败：${rmErr.message}`)
  }
  const { data, error } = await supabase.rpc('delete_group', { p_group: groupId })
  if (error) throw new Error(error.message)
  return data as RpcResult
}

export async function touchMember(groupId: string): Promise<void> {
  const uid = await currentUserId()
  await supabase.from('members').update({ last_seen_at: new Date().toISOString() }).eq('group_id', groupId).eq('user_id', uid)
}
