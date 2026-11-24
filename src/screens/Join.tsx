import { useEffect, useState } from 'react'
import { claimOwner, createGroup, currentUserId, fetchOwnerState, joinGroup } from '../lib/api'
import { errText } from '../lib/errors'
import type { Group, LocalProfile } from '../lib/types'
import { toast } from '../components/Toast'

interface Props {
  groups: Group[]
  onJoined: (p: LocalProfile) => void
  onRefreshGroups: () => Promise<Group[]>
}

export default function JoinScreen({ groups, onJoined, onRefreshGroups }: Props) {
  const [mode, setMode] = useState<'join' | 'owner'>('join')
  const [code, setCode] = useState('')
  const [nickname, setNickname] = useState(() => localStorage.getItem('quanzi.nickname') || '')
  const [pass, setPass] = useState('')
  const [groupName, setGroupName] = useState('我的圈子')
  const [busy, setBusy] = useState(false)
  const [ownerState, setOwnerState] = useState<{ claimed: boolean; is_owner: boolean }>({ claimed: false, is_owner: false })
  const [myGroups, setMyGroups] = useState<Group[]>(groups)

  useEffect(() => {
    void fetchOwnerState().then(setOwnerState)
  }, [])

  useEffect(() => {
    setMyGroups(groups)
  }, [groups])

  async function doJoin() {
    const c = code.trim().toUpperCase()
    const n = nickname.trim()
    if (c.length < 4) {
      toast('请输入完整邀请码', 'error')
      return
    }
    if (!n) {
      toast('请输入昵称', 'error')
      return
    }
    setBusy(true)
    try {
      const res = await joinGroup(c, n)
      if (!res.ok) {
        toast(errText(res.error), 'error')
        return
      }
      localStorage.setItem('quanzi.nickname', n)
      const uid = await currentUserId()
      onJoined({ groupId: res.group_id, groupName: res.group_name, nickname: res.nickname, userId: uid })
      toast(`已加入「${res.group_name}」`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function doClaim() {
    if (!pass.trim()) {
      toast('请输入主控口令', 'error')
      return
    }
    setBusy(true)
    try {
      const res = await claimOwner(pass.trim())
      if (!res.ok) {
        toast(errText(res.error), 'error')
        return
      }
      setOwnerState({ claimed: true, is_owner: true })
      toast('已认领主控人身份', 'success')
      const list = await onRefreshGroups()
      setMyGroups(list)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function doCreate() {
    const name = groupName.trim()
    if (!name) {
      toast('请输入群名', 'error')
      return
    }
    setBusy(true)
    try {
      const res = await createGroup(name)
      if (!res.ok) {
        toast(errText(res.error), 'error')
        return
      }
      const uid = await currentUserId()
      localStorage.setItem('quanzi.nickname', '主控人')
      onJoined({ groupId: res.group_id, groupName: res.name, nickname: '主控人', userId: uid })
      toast(`圈子已创建，邀请码 ${res.invite_code}`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  function enterGroup(g: Group) {
    void (async () => {
      const uid = await currentUserId()
      const saved = localStorage.getItem('quanzi.nickname') || '主控人'
      onJoined({ groupId: g.id, groupName: g.name, nickname: saved, userId: uid })
    })()
  }

  return (
    <div className="screen join-screen">
      <div className="join-hero">
        <div className="join-logo">圈</div>
        <h1 className="join-title">圈子</h1>
        <p className="join-sub">10 人以内的私密聊天群 · 邀请码即入</p>
      </div>

      {mode === 'join' ? (
        <div className="card join-card">
          <label className="field">
            <span className="field-label">邀请码</span>
            <input
              className="input input-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="6 位邀请码"
              maxLength={8}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">昵称</span>
            <input
              className="input"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="群里显示的名字"
              maxLength={20}
            />
          </label>
          <button className="btn-primary" disabled={busy} onClick={doJoin}>
            {busy ? '正在进入…' : '进入圈子'}
          </button>
          <button className="link-btn" onClick={() => setMode('owner')}>
            我是主控人
          </button>
        </div>
      ) : (
        <div className="card join-card">
          <h2 className="card-title">主控人入口</h2>
          {!ownerState.is_owner && (
            <>
              <p className={ownerState.claimed ? 'hint warn' : 'hint'}>
                {ownerState.claimed
                  ? '这台设备当前不是主控人。输入主控口令即可把主控人身份更换到这台设备，原设备会立即失去管理权。'
                  : '输入主控口令完成认领，认领后这台设备就是圈子的主控人，可生成邀请码。'}
              </p>
              <label className="field">
                <span className="field-label">主控口令</span>
                <input
                  className="input"
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder="部署时设置的口令"
                />
              </label>
              <button className="btn-primary" disabled={busy} onClick={doClaim}>
                {busy ? '正在认领…' : ownerState.claimed ? '用口令更换主控人' : '认领主控人'}
              </button>
            </>
          )}

          {ownerState.is_owner && (
            <>
              {myGroups.length > 0 ? (
                <>
                  <p className="hint">选择要进入的圈子：</p>
                  <div className="group-pick">
                    {myGroups.map((g) => (
                      <button key={g.id} className="group-pick-item" onClick={() => enterGroup(g)}>
                        <span className="group-pick-name">{g.name}</span>
                        <span className="group-pick-code">{g.invite_code}</span>
                      </button>
                    ))}
                  </div>
                  <button className="link-btn" onClick={() => setMyGroups([])}>
                    新建一个圈子
                  </button>
                </>
              ) : (
                <>
                  <p className="hint">你还没有圈子，先创建一个，然后生成邀请码发给朋友。</p>
                  <label className="field">
                    <span className="field-label">群名</span>
                    <input className="input" value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={30} />
                  </label>
                  <button className="btn-primary" disabled={busy} onClick={doCreate}>
                    {busy ? '正在创建…' : '创建圈子'}
                  </button>
                </>
              )}
            </>
          )}

          <button className="link-btn" onClick={() => setMode('join')}>
            返回邀请码入群
          </button>
        </div>
      )}

      <div className="join-foot">文字 · 语音 · 图片 · 文件 · 撤回 · 已读 · 搜索</div>
    </div>
  )
}