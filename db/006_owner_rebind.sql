-- =========================================================
-- 006: 主控人可凭口令更换 / 重新认领（换手机不再需要改数据库）
--   1) 先把主控人身份置空，让用户当前手机可以立刻用口令认领
--   2) claim_owner：口令正确即可覆盖已有主控人，完成设备更换
-- =========================================================

-- 1) 清空主控人绑定，回到「未认领」状态
update public.app_config
   set owner_user_id = null,
       owner_claimed_at = null
 where id = true;

-- 2) 认领/更换：口令正确即接管，不再因为「已被认领」而拒绝
create or replace function public.claim_owner(p_pass text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg  public.app_config;
  prev uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTH');
  end if;

  select * into cfg from public.app_config where id;
  if cfg.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_INITIALIZED');
  end if;
  if cfg.owner_pass_hash is null
     or extensions.crypt(coalesce(p_pass, ''), cfg.owner_pass_hash) <> cfg.owner_pass_hash then
    return jsonb_build_object('ok', false, 'error', 'BAD_PASS');
  end if;

  prev := cfg.owner_user_id;

  update public.app_config
     set owner_user_id = auth.uid(),
         owner_claimed_at = coalesce(cfg.owner_claimed_at, now())
   where id;

  return jsonb_build_object(
    'ok', true,
    'owner_id', auth.uid(),
    'rebind', (prev is not null and prev <> auth.uid())
  );
end $$;

grant execute on function public.claim_owner(text) to authenticated;

select
  (select owner_user_id::text from public.app_config limit 1) as owner_uid,
  (select prosrc like '%rebind%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and proname = 'claim_owner') as rebind_ready;
