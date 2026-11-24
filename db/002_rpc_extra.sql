-- =========================================================
-- 002: 存储计量（所有成员可读用量）+ 附件消息一体发送
-- =========================================================

create or replace function public.storage_meter() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  used  bigint;
  quota bigint;
  ratio numeric;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTH');
  end if;
  select coalesce(sum((o.metadata->>'size')::bigint), 0) into used
    from storage.objects o where o.bucket_id = 'quanzi-media';
  select c.storage_quota_bytes, c.storage_warn_ratio into quota, ratio
    from public.app_config c where c.id;
  return jsonb_build_object('ok', true, 'used', used, 'quota', quota, 'ratio', ratio);
end $$;

create or replace function public.send_attachment(
  p_group     uuid,
  p_kind      public.msg_kind,
  p_path      text,
  p_name      text,
  p_mime      text,
  p_size      bigint,
  p_duration  integer default null,
  p_client_id text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m     public.members;
  msg   public.messages;
  att   public.attachments;
  used  bigint;
  quota bigint;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTH');
  end if;
  if p_kind not in ('voice', 'image', 'file') then
    return jsonb_build_object('ok', false, 'error', 'BAD_KIND');
  end if;

  select * into m from public.members where group_id = p_group and user_id = auth.uid();
  if m.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_MEMBER');
  end if;

  select coalesce(sum((o.metadata->>'size')::bigint), 0) into used
    from storage.objects o where o.bucket_id = 'quanzi-media';
  select c.storage_quota_bytes into quota from public.app_config c where c.id;

  if used + coalesce(p_size, 0) > quota then
    return jsonb_build_object('ok', false, 'error', 'STORAGE_FULL', 'used', used, 'quota', quota);
  end if;

  insert into public.attachments(group_id, uploader_id, path, file_name, mime, size_bytes, kind, duration_ms)
  values (p_group, auth.uid(), p_path, p_name, p_mime, coalesce(p_size, 0), p_kind, p_duration)
  returning * into att;

  insert into public.messages(group_id, sender_id, sender_name, kind, body, client_msg_id)
  values (p_group, auth.uid(), m.nickname, p_kind, p_name, p_client_id)
  returning * into msg;

  update public.attachments set message_id = msg.id where id = att.id;

  return jsonb_build_object('ok', true, 'message', to_jsonb(msg), 'attachment', to_jsonb(att));
end $$;

grant execute on function public.storage_meter() to authenticated;
grant execute on function public.send_attachment(uuid, public.msg_kind, text, text, text, bigint, integer, text) to authenticated;

select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('storage_meter','send_attachment')) as new_fns;