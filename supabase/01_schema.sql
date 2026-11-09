-- =====================================================================
--  Super Photo POS  -  database (Supabase / PostgreSQL)
--  Stap 1 van 2: tabellen.  Plak dit in Supabase > SQL Editor > Run.
--  Alle tabellen staan in het schema "app", dat NIET via internet
--  bereikbaar is. Het programma praat alleen via de functies in
--  02_functions.sql, die elke keer de pincode-sessie controleren.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
revoke all on schema app from public;

-- ---------- instellingen & winkels ----------
create table if not exists app.settings (
  key   text primary key,
  value text
);

create table if not exists app.stores (
  code             text primary key check (code in ('MAH','IND')),
  name             text not null,
  address          text,
  phone            text,
  trans_prefix     int  not null,
  payment_methods  text[] not null,
  receipt_width_mm int  not null,
  shop_location    text not null,
  staff            text[] not null default '{}',
  pin_hash         text
);

insert into app.stores (code, name, address, phone, trans_prefix, payment_methods, receipt_width_mm, shop_location, staff)
values
  ('MAH','Super Photo Mahony','Mahonylaan 47','+597-421524',1, array['cash','pin'], 80, 'MAH',
     array['Grace','Selena','Damaris','Stephanie']),
  ('IND','Super Photo Indira','Indira Gandhiweg 175','+597 8972550',2, array['cash'], 58, 'IND',
     array['Mariska','Lucia','Varsha'])
on conflict (code) do nothing;

create table if not exists app.locations (
  code       text primary key,
  name       text not null,
  store_code text references app.stores(code)
);
insert into app.locations (code, name, store_code) values
  ('MAH','Winkel Mahony','MAH'),
  ('IND','Winkel Indira','IND'),
  ('MAG','Magazijn Mahony','MAH')
on conflict (code) do nothing;

create table if not exists app.counters (
  store_code text primary key references app.stores(code),
  last_seq   int not null default 0
);
insert into app.counters (store_code) values ('MAH'),('IND') on conflict do nothing;

-- ---------- sessies & mislukte pogingen ----------
create table if not exists app.sessions (
  token      uuid primary key default gen_random_uuid(),
  role       text not null check (role in ('terminal','admin')),
  store_code text references app.stores(code),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists app.login_failures (
  id  bigserial primary key,
  key text not null,
  at  timestamptz not null default now()
);
create index if not exists login_failures_key_at on app.login_failures(key, at);

-- ---------- artikelen & voorraad ----------
create table if not exists app.products (
  stock_no    text primary key,
  name        text not null,
  price       numeric(12,2) not null default 0 check (price >= 0),
  category    text not null default 'Overig',
  only_store  text references app.stores(code),          -- null = beide winkels
  track_stock boolean not null default false,              -- voorraad bijhouden
  sellable    boolean not null default true,               -- false = verbruiksartikel (papier e.d.)
  dnp_pasfoto boolean not null default false,              -- telt mee voor DNP-teller
  min_stock   int not null default 0,                      -- waarschuwen bij voorraad <= dit getal
  active      boolean not null default true,
  sort_order  int not null default 0,
  note        text,
  updated_at  timestamptz not null default now()
);

create table if not exists app.price_history (
  id         bigserial primary key,
  stock_no   text not null references app.products(stock_no),
  price      numeric(12,2) not null,
  valid_from timestamptz not null default now()
);
create index if not exists price_history_stock on app.price_history(stock_no, valid_from);

create table if not exists app.stock (
  location text not null references app.locations(code),
  stock_no text not null references app.products(stock_no),
  qty      int  not null default 0,
  primary key (location, stock_no)
);

create table if not exists app.stock_moves (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  location  text not null,
  stock_no  text not null,
  delta     int  not null,
  qty_after int,
  reason    text not null,   -- verkoop, vervallen, telling, ontvangst, verplaatsing, correctie
  ref       text,
  note      text
);
create index if not exists stock_moves_stock on app.stock_moves(stock_no, at);

-- ---------- klanten ----------
create table if not exists app.customers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  phone         text,
  created_store text,
  created_at    timestamptz not null default now()
);

-- ---------- transacties ----------
create table if not exists app.sales (
  id               bigserial primary key,
  trans_no         bigint not null unique,
  store_code       text not null references app.stores(code),
  client_id        uuid not null unique,                   -- voorkomt dubbel opslaan bij offline
  kind             text not null check (kind in ('sale','balance','cash_out')),
  sold_at          timestamptz not null,
  synced_at        timestamptz not null default now(),
  staff            text,
  customer_id      uuid references app.customers(id),
  customer_name    text,
  customer_phone   text,
  subtotal         numeric(12,2) not null default 0,
  discount         numeric(12,2) not null default 0,
  total            numeric(12,2) not null default 0,
  payment_method   text check (payment_method in ('cash','pin')),
  paid             numeric(12,2) not null default 0,
  cash_received    numeric(12,2),
  change_given     numeric(12,2),
  ref_sale_id      bigint references app.sales(id),
  pickup_at        timestamptz,
  route_van        text,
  route_door       text,
  route_afh        text,
  comment          text,
  picked_up        boolean not null default false,
  picked_up_at     timestamptz,
  discount_checked boolean not null default false,
  price_mismatch   boolean not null default false,
  mismatch_checked boolean not null default false,
  voided           boolean not null default false,
  voided_at        timestamptz,
  void_reason      text
);
create index if not exists sales_store_time on app.sales(store_code, sold_at);
create index if not exists sales_ref on app.sales(ref_sale_id);

create table if not exists app.sale_lines (
  id             bigserial primary key,
  sale_id        bigint not null references app.sales(id) on delete cascade,
  line_no        int not null,
  stock_no       text,
  name           text not null,
  unit_price     numeric(12,2) not null,
  qty            int not null check (qty > 0),
  line_total     numeric(12,2) not null,
  net_total      numeric(12,2) not null,      -- na verdeelde korting
  stock_location text,                         -- waar voorraad is afgeboekt
  dnp            boolean not null default false
);
create index if not exists sale_lines_sale on app.sale_lines(sale_id);

-- ---------- dagafsluiting ----------
create table if not exists app.day_closes (
  id                 bigserial primary key,
  store_code         text not null references app.stores(code),
  client_id          uuid not null unique,
  closed_at          timestamptz not null default now(),
  period_from        timestamptz,
  staff              text,
  counted_cash       numeric(12,2) not null,
  expected_cash      numeric(12,2) not null,
  cash_diff          numeric(12,2) not null,
  dnp_counter        bigint not null,
  dnp_prev_counter   bigint,
  dnp_prints         int,
  dnp_sold           int not null,
  dnp_diff           int,
  note               text,
  acknowledged       boolean not null default false
);

-- ---------- meldingen van personeel (voorraad) ----------
create table if not exists app.proposals (
  id          bigserial primary key,
  store_code  text not null references app.stores(code),
  created_at  timestamptz not null default now(),
  staff       text,
  kind        text not null check (kind in ('receive','transfer','new_item')),
  stock_no    text references app.products(stock_no),
  location    text references app.locations(code),
  qty         int not null check (qty >= 0),
  new_name    text,
  new_price   numeric(12,2),
  note        text,
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  handled_at  timestamptz,
  result_note text
);

-- Niemand behalve de functies mag bij deze tabellen.
revoke all on all tables    in schema app from public;
revoke all on all sequences in schema app from public;
