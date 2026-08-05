-- ============================================================================
-- URUOI 水分管理 — Supabase テーブル定義
-- わんにゃんメモリー／達人への道／IRON LOG と同じプロジェクトに相乗りするため、
-- 「authenticated に grant / anon から revoke / RLS＋ポリシー」を毎回明示する。
-- Supabase ダッシュボード → SQL Editor に貼って実行する。
-- 何度実行しても壊れないように書いてある。
--
-- ※ SQL Editor は必ずタブの「＋」で新しいクエリを作ってから貼ること
--   （既存の「無題のクエリ」を上書きしてしまわないように）。
-- ============================================================================

-- ── 0) updated_at をサーバー時刻で入れるための共通トリガ関数 ──
-- 端末の時計で updated_at を入れると、時計がずれた端末の行が
-- 「前回より新しい行だけ取る」差分同期の網から永久に漏れる。
-- サーバーの now() に統一することで、全端末が同じ時計を見る。
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── 1) 飲んだ記録（1杯=1行。追記のみ。消すときは deleted を立てる） ──
create table if not exists public.uruoi_entries (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         text        not null,               -- アプリが作る記録ID
  date       text        not null default '',    -- 'YYYY-MM-DD'（区切り時間を適用した集計日）
  t          bigint      not null default 0,     -- 飲んだ時刻（ミリ秒）
  ml         integer     not null default 0,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists uruoi_entries_user_updated_idx
  on public.uruoi_entries (user_id, updated_at asc);

drop trigger if exists uruoi_entries_touch on public.uruoi_entries;
create trigger uruoi_entries_touch before insert or update on public.uruoi_entries
  for each row execute function public.set_updated_at();

-- ── 2) 日ごとの目標（1日1行。last-write-wins） ──
create table if not exists public.uruoi_days (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  date       text        not null,               -- 'YYYY-MM-DD'
  target_ml  integer,                            -- null = 未設定
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

create index if not exists uruoi_days_user_updated_idx
  on public.uruoi_days (user_id, updated_at asc);

drop trigger if exists uruoi_days_touch on public.uruoi_days;
create trigger uruoi_days_touch before insert or update on public.uruoi_days
  for each row execute function public.set_updated_at();

-- ── 3) プロフィール・クイックボタン・区切り設定・水知識（1ユーザー1行） ──
-- 中身は項目ごとにマージする（丸ごと last-write-wins にはしない）。
-- 特に水知識は、両端末で別々に解禁が進むので和集合／最大値で合わせる必要がある。
create table if not exists public.uruoi_state (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  doc        jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists uruoi_state_touch on public.uruoi_state;
create trigger uruoi_state_touch before insert or update on public.uruoi_state
  for each row execute function public.set_updated_at();

-- ── RLS ──
alter table public.uruoi_entries enable row level security;
alter table public.uruoi_days    enable row level security;
alter table public.uruoi_state   enable row level security;

drop policy if exists uruoi_entries_own on public.uruoi_entries;
drop policy if exists uruoi_days_own    on public.uruoi_days;
drop policy if exists uruoi_state_own   on public.uruoi_state;

create policy uruoi_entries_own on public.uruoi_entries
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy uruoi_days_own on public.uruoi_days
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy uruoi_state_own on public.uruoi_state
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 権限（anon は完全に締め出す。自動設定に頼らず明示する） ──
revoke all on public.uruoi_entries from anon;
revoke all on public.uruoi_days    from anon;
revoke all on public.uruoi_state   from anon;

grant select, insert, update, delete on public.uruoi_entries to authenticated;
grant select, insert, update, delete on public.uruoi_days    to authenticated;
grant select, insert, update, delete on public.uruoi_state   to authenticated;

-- ── 確認用（anon で叩くと permission denied になるのが正しい） ──
-- select * from public.uruoi_entries limit 1;
