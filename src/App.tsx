import { useCallback, useEffect, useState } from 'react'
import { ToastHost, toast } from './components/Toast'
import { currentUserId, ensureSession, fetchOwnerState, listGroups } from './lib/api'
import type { Group, LocalProfile } from './lib/types'
import JoinScreen from './screens/Join'
import ChatScreen from './screens/Chat'

const PROFILE_KEY = 'quanzi.profile.v1'

export default function App() {
  const [ready, setReady] = useState(false)
  const [profile, setProfile] = useState<LocalProfile | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)

  const boot = useCallback(async () => {
    try {
      await ensureSession()
      const uid = await currentUserId()
      const [groupList, ownerState] = await Promise.all([listGroups(), fetchOwnerState()])
      setGroups(groupList)
      setIsOwner(ownerState.is_owner)

      const raw = localStorage.getItem(PROFILE_KEY)
      if (raw) {
        try {
          const saved = JSON.parse(raw) as LocalProfile
          const hit = groupList.find((g) => g.id === saved.groupId)
          if (hit && saved.userId === uid) {
            setProfile({ ...saved, groupName: hit.name })
          } else {
            localStorage.removeItem(PROFILE_KEY)
          }
        } catch {
          localStorage.removeItem(PROFILE_KEY)
        }
      }
    } catch (e) {
      setFatal((e as Error).message)
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  const refreshGroups = useCallback(async () => {
    const list = await listGroups()
    setGroups(list)
    const ownerState = await fetchOwnerState()
    setIsOwner(ownerState.is_owner)
    return list
  }, [])

  const handleJoined = useCallback(
    (p: LocalProfile) => {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(p))
      setProfile(p)
      void refreshGroups()
    },
    [refreshGroups],
  )

  const handleSwitchGroup = useCallback(
    async (groupId: string) => {
      const list = await refreshGroups()
      const hit = list.find((g) => g.id === groupId)
      if (!hit) {
        toast('你不在这个圈子里', 'error')
        return
      }
      setProfile((prev) => {
        if (!prev) return prev
        const next = { ...prev, groupId: hit.id, groupName: hit.name }
        localStorage.setItem(PROFILE_KEY, JSON.stringify(next))
        return next
      })
    },
    [refreshGroups],
  )

  if (!ready) {
    return (
      <div className="splash">
        <div className="splash-logo">圈</div>
        <div className="splash-text">正在连接圈子…</div>
      </div>
    )
  }

  if (fatal) {
    return (
      <div className="splash">
        <div className="splash-text">连接失败：{fatal}</div>
        <button className="btn-ghost" onClick={() => window.location.reload()}>
          重试
        </button>
      </div>
    )
  }

  return (
    <>
      {profile ? (
        <ChatScreen
          profile={profile}
          groups={groups}
          isOwner={isOwner}
          onJoinedRefresh={refreshGroups}
          onSwitchGroup={handleSwitchGroup}
          onOwnerChange={setIsOwner}
        />
      ) : (
        <JoinScreen groups={groups} onJoined={handleJoined} onRefreshGroups={refreshGroups} />
      )}
      <ToastHost />
    </>
  )
}