export const RPC_ERRORS: Record<string, string> = {
  NO_AUTH: '会话已失效，请刷新页面重试',
  BAD_CODE: '邀请码不存在，请核对后重试',
  BAD_NICKNAME: '昵称需要 1-20 个字',
  GROUP_FULL: '这个圈子已满 10 人',
  NOT_OWNER: '只有主控人可以做这件事',
  BAD_PASS: '主控口令不正确',
  OWNER_TAKEN: '主控人已被另一台设备认领',
  NOT_INITIALIZED: '系统未初始化，请联系管理员',
  STORAGE_FULL: '圈子存储空间已满，请先清理',
  NOT_MEMBER: '你不在这个圈子里',
  BAD_KIND: '不支持的消息类型',
  RECALL_EXPIRED: '超过 2 分钟，无法撤回',
  RECALL_NOT_OWNER: '只能撤回自己发的消息',
  NOT_FOUND: '内容已不存在',
  BAD_NAME: '群名不能为空',
  NOT_GROUP_OWNER: '只有该群的群主可以操作',
}

export function errText(code?: string | null): string {
  if (!code) return '操作失败，请稍后重试'
  return RPC_ERRORS[code] || code
}