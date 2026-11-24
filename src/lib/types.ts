export type MsgKind = 'text' | 'voice' | 'image' | 'file' | 'system'

export interface Group {
  id: string
  name: string
  owner_id: string
  invite_code: string
  created_at: string
}

export interface Member {
  id: string
  group_id: string
  user_id: string
  nickname: string
  role: 'owner' | 'member'
  joined_at: string
  last_seen_at: string
}

export interface Message {
  id: string
  group_id: string
  sender_id: string
  sender_name: string
  kind: MsgKind
  body: string | null
  recalled_at: string | null
  client_msg_id: string | null
  created_at: string
}

export interface Attachment {
  id: string
  group_id: string
  message_id: string | null
  uploader_id: string
  bucket: string
  path: string
  file_name: string
  mime: string | null
  size_bytes: number
  kind: MsgKind
  duration_ms: number | null
  created_at: string
  deleted_at: string | null
}

export interface StorageFile {
  id: string
  name: string
  size: number
  kind: string
  mime: string | null
  path: string
  bucket: string
  created_at: string
  message_id: string | null
  group_id: string
}

export interface StorageInfo {
  ok: boolean
  used: number
  quota: number
  ratio: number
  files: StorageFile[]
}

export interface LocalProfile {
  groupId: string
  groupName: string
  nickname: string
  userId: string
}

export type RpcResult<T = Record<string, unknown>> = { ok: boolean; error?: string } & T