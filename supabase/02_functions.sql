-- =====================================================================
--  Super Photo POS  -  database stap 2 van 2: functies
--  Plak dit na 01_schema.sql in Supabase > SQL Editor > Run.
--  Dit bestand mag je later opnieuw draaien bij een update.
-- =====================================================================

-- ===================== interne hulpfuncties =====================

create or replace function app.err(p_msg text) returns void
language plpgsql as $$ begin raise exception using message = p_msg, errcode = 'P0001'; end $$;

-- Controleert een sessie; geeft de winkelcode terug (null voor admin).
create or replace function app.check_session(p_token uuid, p_role text) returns text
language plpgsql security definer set search_path = app, public, extensions as $$
declare s app.sessions;
begin
  select * into s from app.sessions where token = p_token and role = p_role and expires_at > now();
  if not found then perform app.err('SESSIE_VERLOPEN'); end if;
  return s.store_code;
end $$;

create or replace function app.check_lockout(p_key text) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  if (select count(*) from app.login_failures where key = p_key and at > now() - interval '10 minutes') >= 5 then
    perform app.err('Te veel verkeerde pincodes. Probeer het over 10 minuten opnieuw.');
  end if;
end $$;

create or replace function app.valid_pin(p_pin text) returns boolean
language sql immutable as $$ select coalesce(p_pin ~ '^[0-9]{4,8}$', false) $$;

create or replace function app.next_trans_no(p_store text) returns bigint
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_seq int; v_prefix int;
begin
  update app.counters set last_seq = last_seq + 1 where store_code = p_store returning last_seq into v_seq;
  select trans_prefix into v_prefix from app.stores where code = p_store;
  return (v_prefix::text || lpad(v_seq::text, greatest(5, length(v_seq::text)), '0'))::bigint;
end $$;

create or replace function app.add_stock(p_location text, p_stock_no text, p_delta int, p_reason text, p_ref text, p_note text)
returns int
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_qty int;
begin
  insert into app.stock(location, stock_no, qty) values (p_location, p_stock_no, p_delta)
  on conflict (location, stock_no) do update set qty = app.stock.qty + excluded.qty
  returning qty into v_qty;
  insert into app.stock_moves(location, stock_no, delta, qty_after, reason, ref, note)
  values (p_location, p_stock_no, p_delta, v_qty, p_reason, p_ref, p_note);
  return v_qty;
end $$;

create or replace function app.set_stock(p_location text, p_stock_no text, p_qty int, p_reason text, p_note text)
returns void
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_old int;
begin
  select qty into v_old from app.stock where location = p_location and stock_no = p_stock_no for update;
  v_old := coalesce(v_old, 0);
  insert into app.stock(location, stock_no, qty) values (p_location, p_stock_no, p_qty)
  on conflict (location, stock_no) do update set qty = excluded.qty;
  insert into app.stock_moves(location, stock_no, delta, qty_after, reason, note)
  values (p_location, p_stock_no, p_qty - v_old, p_qty, p_reason, p_note);
end $$;

-- Openstaand bedrag van een order (totaal - aanbetaling - restbetalingen)
create or replace function app.outstanding(p_sale_id bigint) returns numeric
language sql stable security definer set search_path = app, public, extensions as $$
  select s.total - s.paid - coalesce((select sum(b.paid) from app.sales b
                                       where b.ref_sale_id = s.id and b.kind = 'balance' and not b.voided), 0)
  from app.sales s where s.id = p_sale_id
$$;

-- Prijs die gold op een bepaald moment
create or replace function app.price_at(p_stock_no text, p_at timestamptz) returns numeric
language sql stable security definer set search_path = app, public, extensions as $$
  select coalesce(
    (select price from app.price_history where stock_no = p_stock_no and valid_from <= p_at order by valid_from desc limit 1),
    (select price from app.products where stock_no = p_stock_no))
$$;

create or replace function app.clamp_time(p_at timestamptz) returns timestamptz
language sql stable as $$
  select case when p_at is null or p_at > now() + interval '5 minutes' or p_at < now() - interval '14 days'
              then now() else p_at end
$$;

create or replace function app.sale_json(p_id bigint) returns jsonb
language sql stable security definer set search_path = app, public, extensions as $$
  select jsonb_build_object(
    'trans_no', s.trans_no, 'store_code', s.store_code, 'kind', s.kind, 'sold_at', s.sold_at,
    'staff', s.staff, 'customer_name', s.customer_name, 'customer_phone', s.customer_phone,
    'subtotal', s.subtotal, 'discount', s.discount, 'total', s.total,
    'payment_method', s.payment_method, 'paid', s.paid, 'cash_received', s.cash_received, 'change_given', s.change_given,
    'ref_trans_no', (select r.trans_no from app.sales r where r.id = s.ref_sale_id),
    'pickup_at', s.pickup_at, 'route_van', s.route_van, 'route_door', s.route_door, 'route_afh', s.route_afh,
    'comment', s.comment, 'picked_up', s.picked_up, 'discount_checked', s.discount_checked,
    'price_mismatch', s.price_mismatch, 'voided', s.voided, 'voided_at', s.voided_at, 'void_reason', s.void_reason,
    'outstanding', case when s.kind = 'sale' then app.outstanding(s.id) else 0 end,
    'payments', case when s.kind = 'sale' then coalesce((select jsonb_agg(jsonb_build_object(
          'trans_no', b.trans_no, 'sold_at', b.sold_at, 'paid', b.paid, 'payment_method', b.payment_method, 'store_code', b.store_code)
          order by b.sold_at) from app.sales b where b.ref_sale_id = s.id and b.kind = 'balance' and not b.voided), '[]'::jsonb) else '[]'::jsonb end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
          'stock_no', l.stock_no, 'name', l.name, 'unit_price', l.unit_price, 'qty', l.qty,
          'line_total', l.line_total, 'net_total', l.net_total) order by l.line_no)
          from app.sale_lines l where l.sale_id = s.id), '[]'::jsonb))
  from app.sales s where s.id = p_id
$$;

-- ===================== openbaar: opstarten & inloggen =====================

create or replace function public.pos_status() returns jsonb
language sql stable security definer set search_path = app, public, extensions as $$
  select jsonb_build_object(
    'setup_needed', not exists (select 1 from app.settings where key = 'admin_pin_hash' and value is not null),
    'server_time', now(),
    'update_repo', (select value from app.settings where key = 'update_repo'),
    'stores', (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'address', address, 'phone', phone,
                       'payment_methods', payment_methods, 'receipt_width_mm', receipt_width_mm) order by trans_prefix)
               from app.stores))
$$;

create or replace function public.pos_setup(p_admin_pin text, p_mah_pin text, p_ind_pin text,
                                            p_mah_start bigint default 100001, p_ind_start bigint default 200001)
returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform pg_advisory_xact_lock(42);
  if exists (select 1 from app.settings where key = 'admin_pin_hash' and value is not null) then
    perform app.err('De pincodes zijn al ingesteld. Wijzigen kan via Beheer > Instellingen.');
  end if;
  if not (app.valid_pin(p_admin_pin) and app.valid_pin(p_mah_pin) and app.valid_pin(p_ind_pin)) then
    perform app.err('Een pincode moet uit 4 tot 8 cijfers bestaan.');
  end if;
  if p_admin_pin in (p_mah_pin, p_ind_pin) or p_mah_pin = p_ind_pin then
    perform app.err('Gebruik drie verschillende pincodes.');
  end if;
  if p_mah_start not between 100001 and 199999 or p_ind_start not between 200001 and 299999 then
    perform app.err('Startnummer Mahony moet tussen 100001 en 199999 liggen, Indira tussen 200001 en 299999.');
  end if;
  if exists (select 1 from app.sales) then
    perform app.err('Er zijn al transacties; startnummers kunnen niet meer worden gewijzigd.');
  end if;
  insert into app.settings(key, value) values ('admin_pin_hash', crypt(p_admin_pin, gen_salt('bf')))
  on conflict (key) do update set value = excluded.value;
  update app.stores set pin_hash = crypt(p_mah_pin, gen_salt('bf')) where code = 'MAH';
  update app.stores set pin_hash = crypt(p_ind_pin, gen_salt('bf')) where code = 'IND';
  update app.counters set last_seq = p_mah_start - 100000 - 1 where store_code = 'MAH';
  update app.counters set last_seq = p_ind_start - 200000 - 1 where store_code = 'IND';
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.pos_login(p_store text, p_pin text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare st app.stores; v_token uuid;
begin
  perform app.check_lockout('store:' || coalesce(p_store, ''));
  select * into st from app.stores where code = p_store;
  if not found or st.pin_hash is null or st.pin_hash <> crypt(coalesce(p_pin, ''), st.pin_hash) then
    insert into app.login_failures(key) values ('store:' || coalesce(p_store, ''));
    perform app.err('Verkeerde pincode.');
  end if;
  delete from app.sessions where expires_at < now() - interval '1 day';
  insert into app.sessions(role, store_code, expires_at) values ('terminal', st.code, now() + interval '16 hours')
  returning token into v_token;
  return jsonb_build_object('token', v_token, 'store', jsonb_build_object(
    'code', st.code, 'name', st.name, 'address', st.address, 'phone', st.phone,
    'payment_methods', st.payment_methods, 'receipt_width_mm', st.receipt_width_mm, 'staff', st.staff));
end $$;

create or replace function public.pos_admin_login(p_pin text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_hash text; v_token uuid;
begin
  perform app.check_lockout('admin');
  select value into v_hash from app.settings where key = 'admin_pin_hash';
  if v_hash is null or v_hash <> crypt(coalesce(p_pin, ''), v_hash) then
    insert into app.login_failures(key) values ('admin');
    perform app.err('Verkeerde beheerderspincode.');
  end if;
  insert into app.sessions(role, expires_at) values ('admin', now() + interval '60 minutes') returning token into v_token;
  return jsonb_build_object('token', v_token, 'expires_at', now() + interval '60 minutes');
end $$;

create or replace function public.pos_logout(p_token uuid) returns void
language sql security definer set search_path = app, public, extensions as $$
  delete from app.sessions where token = p_token
$$;

-- ===================== kassa =====================

create or replace function public.pos_catalog(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare v_store text := app.check_session(p_token, 'terminal');
begin
  return jsonb_build_object(
    'generated_at', now(),
    'store', (select jsonb_build_object('code', code, 'name', name, 'address', address, 'phone', phone,
                     'payment_methods', payment_methods, 'receipt_width_mm', receipt_width_mm, 'staff', staff)
              from app.stores where code = v_store),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'stock_no', p.stock_no, 'name', p.name, 'price', p.price, 'category', p.category,
        'track_stock', p.track_stock, 'sellable', p.sellable, 'dnp', p.dnp_pasfoto, 'min_stock', p.min_stock,
        'qty', (select qty from app.stock s where s.location = v_store and s.stock_no = p.stock_no),
        'qty_mag', (select qty from app.stock s where s.location = 'MAG' and s.stock_no = p.stock_no))
        order by p.sort_order, p.stock_no)
      from app.products p
      where p.active and (p.only_store is null or p.only_store = v_store)), '[]'::jsonb));
end $$;

create or replace function public.pos_customers(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'terminal');
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone) order by name)
                   from app.customers), '[]'::jsonb);
end $$;

create or replace function public.pos_add_customer(p_token uuid, p_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_store text := app.check_session(p_token, 'terminal'); c app.customers;
begin
  if coalesce(trim(p_name), '') = '' then perform app.err('Vul een naam in.'); end if;
  insert into app.customers(name, phone, created_store) values (left(trim(p_name), 100), left(trim(coalesce(p_phone, '')), 40), v_store)
  returning * into c;
  return jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone);
end $$;

-- Verkoop opslaan. Veilig om opnieuw te sturen (zelfde client_id = zelfde transactie).
create or replace function public.pos_submit_sale(p_token uuid, p_sale jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare
  v_store text := app.check_session(p_token, 'terminal');
  st app.stores;
  v_client uuid := (p_sale->>'client_id')::uuid;
  v_existing bigint;
  v_at timestamptz := app.clamp_time((p_sale->>'sold_at')::timestamptz);
  v_line jsonb; v_prod app.products; v_qty int; v_price numeric;
  v_subtotal numeric := 0; v_discount numeric; v_total numeric; v_paid numeric; v_received numeric;
  v_method text; v_mismatch boolean := false;
  v_sale_id bigint; v_trans bigint; v_customer uuid; v_cname text; v_cphone text;
  v_n int := 0; v_count int; v_alloc numeric := 0; v_net numeric; v_after int;
  v_warn jsonb := '[]'::jsonb; v_lines jsonb := '[]'::jsonb;
begin
  if v_client is null then perform app.err('client_id ontbreekt'); end if;
  select id into v_existing from app.sales where client_id = v_client;
  if v_existing is not null then
    return jsonb_build_object('duplicate', true, 'sale', app.sale_json(v_existing), 'warnings', '[]'::jsonb);
  end if;
  select * into st from app.stores where code = v_store;

  v_count := jsonb_array_length(coalesce(p_sale->'lines', '[]'::jsonb));
  if v_count = 0 then perform app.err('De bon is leeg.'); end if;

  -- regels controleren
  for v_line in select * from jsonb_array_elements(p_sale->'lines') loop
    select * into v_prod from app.products where stock_no = v_line->>'stock_no';
    if not found then perform app.err('Onbekend artikel: ' || coalesce(v_line->>'stock_no', '?')); end if;
    if v_prod.only_store is not null and v_prod.only_store <> v_store then
      perform app.err(v_prod.name || ' is niet te koop in deze winkel.');
    end if;
    v_qty := (v_line->>'qty')::int;
    if v_qty is null or v_qty <= 0 or v_qty > 10000 then perform app.err('Ongeldig aantal bij ' || v_prod.name); end if;
    v_price := round(coalesce((v_line->>'price')::numeric, v_prod.price), 2);
    if v_price < 0 then perform app.err('Ongeldige prijs bij ' || v_prod.name); end if;
    if v_price <> v_prod.price and v_price <> app.price_at(v_prod.stock_no, v_at) then v_mismatch := true; end if;
    v_subtotal := v_subtotal + v_price * v_qty;
    v_lines := v_lines || jsonb_build_object('p', to_jsonb(v_prod), 'qty', v_qty, 'price', v_price);
  end loop;

  v_discount := round(coalesce((p_sale->>'discount')::numeric, 0), 2);
  if v_discount < 0 or v_discount > v_subtotal then perform app.err('Ongeldige korting.'); end if;
  v_total := v_subtotal - v_discount;
  v_paid := round(coalesce((p_sale->>'paid')::numeric, v_total), 2);
  if v_paid < 0 or v_paid > v_total then perform app.err('Het betaalde bedrag klopt niet.'); end if;
  v_method := nullif(p_sale->>'payment_method', '');
  if v_paid > 0 and (v_method is null or not (v_method = any(st.payment_methods))) then
    perform app.err('Deze betaalwijze is niet toegestaan in deze winkel.');
  end if;
  if v_paid = 0 then v_method := null; end if;
  v_received := round((p_sale->>'cash_received')::numeric, 2);
  if v_method = 'cash' and v_received is not null and v_received < v_paid then
    perform app.err('Ontvangen contant is minder dan het te betalen bedrag.');
  end if;
  if v_method is distinct from 'cash' then v_received := null; end if;

  -- klant
  v_customer := nullif(p_sale->>'customer_id', '')::uuid;
  v_cname := nullif(trim(coalesce(p_sale->>'customer_name', '')), '');
  v_cphone := nullif(trim(coalesce(p_sale->>'customer_phone', '')), '');
  if v_customer is not null and not exists (select 1 from app.customers where id = v_customer) then v_customer := null; end if;
  if v_customer is null and v_cname is not null then
    select id into v_customer from app.customers
      where lower(name) = lower(v_cname) and coalesce(phone, '') = coalesce(v_cphone, '') limit 1;
    if v_customer is null then
      insert into app.customers(name, phone, created_store) values (left(v_cname, 100), left(coalesce(v_cphone, ''), 40), v_store)
      returning id into v_customer;
    end if;
  end if;
  if v_customer is not null then select name, phone into v_cname, v_cphone from app.customers where id = v_customer; end if;

  v_trans := app.next_trans_no(v_store);
  insert into app.sales(trans_no, store_code, client_id, kind, sold_at, staff, customer_id, customer_name, customer_phone,
                        subtotal, discount, total, payment_method, paid, cash_received, change_given,
                        pickup_at, route_van, route_door, route_afh, comment, price_mismatch)
  values (v_trans, v_store, v_client, 'sale', v_at, left(p_sale->>'staff', 50), v_customer, v_cname, v_cphone,
          v_subtotal, v_discount, v_total, v_method, v_paid, v_received,
          case when v_received is not null then v_received - v_paid end,
          (p_sale->>'pickup_at')::timestamptz,
          coalesce(nullif(p_sale->>'route_van', ''), v_store),
          coalesce(nullif(p_sale->>'route_door', ''), v_store),
          coalesce(nullif(p_sale->>'route_afh', ''), v_store),
          left(nullif(trim(coalesce(p_sale->>'comment', '')), ''), 500), v_mismatch)
  returning id into v_sale_id;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_n := v_n + 1;
    v_qty := (v_line->>'qty')::int; v_price := (v_line->>'price')::numeric;
    if v_n = v_count then v_net := v_total - v_alloc;
    else v_net := case when v_subtotal = 0 then 0 else round(v_price * v_qty * v_total / v_subtotal, 2) end;
         v_alloc := v_alloc + v_net; end if;
    insert into app.sale_lines(sale_id, line_no, stock_no, name, unit_price, qty, line_total, net_total, stock_location, dnp)
    values (v_sale_id, v_n, v_line->'p'->>'stock_no', v_line->'p'->>'name', v_price, v_qty, v_price * v_qty, v_net,
            case when (v_line->'p'->>'track_stock')::boolean then st.shop_location end,
            (v_line->'p'->>'dnp_pasfoto')::boolean);
    if (v_line->'p'->>'track_stock')::boolean then
      v_after := app.add_stock(st.shop_location, v_line->'p'->>'stock_no', -v_qty, 'verkoop', v_trans::text, null);
      if v_after <= (v_line->'p'->>'min_stock')::int then
        v_warn := v_warn || jsonb_build_object('stock_no', v_line->'p'->>'stock_no', 'name', v_line->'p'->>'name', 'qty', v_after);
      end if;
    end if;
  end loop;

  return jsonb_build_object('duplicate', false, 'sale', app.sale_json(v_sale_id), 'warnings', v_warn);
end $$;

-- Restbetaling (code 1060 Saldo) op een eerdere order. Alleen online.
create or replace function public.pos_pay_balance(p_token uuid, p_pay jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare
  v_store text := app.check_session(p_token, 'terminal'); st app.stores;
  v_client uuid := (p_pay->>'client_id')::uuid; v_existing bigint;
  o app.sales; v_open numeric; v_amount numeric; v_method text; v_received numeric;
  v_trans bigint; v_id bigint;
begin
  if v_client is null then perform app.err('client_id ontbreekt'); end if;
  select id into v_existing from app.sales where client_id = v_client;
  if v_existing is not null then return jsonb_build_object('duplicate', true, 'sale', app.sale_json(v_existing)); end if;
  select * into st from app.stores where code = v_store;
  select * into o from app.sales where trans_no = (p_pay->>'ref_trans_no')::bigint and kind = 'sale' for update;
  if not found then perform app.err('Order niet gevonden.'); end if;
  if o.voided then perform app.err('Deze order is vervallen verklaard.'); end if;
  v_open := app.outstanding(o.id);
  v_amount := round((p_pay->>'amount')::numeric, 2);
  if v_amount is null or v_amount <= 0 then perform app.err('Vul een bedrag in.'); end if;
  if v_amount > v_open then perform app.err('Het bedrag is hoger dan het openstaande saldo (SRD ' || v_open || ').'); end if;
  v_method := p_pay->>'payment_method';
  if v_method is null or not (v_method = any(st.payment_methods)) then perform app.err('Deze betaalwijze is niet toegestaan in deze winkel.'); end if;
  v_received := case when v_method = 'cash' then round((p_pay->>'cash_received')::numeric, 2) end;
  if v_received is not null and v_received < v_amount then perform app.err('Ontvangen contant is minder dan het bedrag.'); end if;

  v_trans := app.next_trans_no(v_store);
  insert into app.sales(trans_no, store_code, client_id, kind, sold_at, staff, customer_id, customer_name, customer_phone,
                        subtotal, total, payment_method, paid, cash_received, change_given, ref_sale_id,
                        route_van, route_door, route_afh)
  values (v_trans, v_store, v_client, 'balance', now(), left(p_pay->>'staff', 50), o.customer_id, o.customer_name, o.customer_phone,
          v_amount, v_amount, v_method, v_amount, v_received, case when v_received is not null then v_received - v_amount end, o.id,
          v_store, v_store, v_store)
  returning id into v_id;
  insert into app.sale_lines(sale_id, line_no, stock_no, name, unit_price, qty, line_total, net_total)
  values (v_id, 1, '1060', 'Saldo restbetaling trans. ' || o.trans_no, v_amount, 1, v_amount, v_amount);
  if coalesce((p_pay->>'mark_picked_up')::boolean, false) and app.outstanding(o.id) = 0 then
    update app.sales set picked_up = true, picked_up_at = now() where id = o.id;
  end if;
  return jsonb_build_object('duplicate', false, 'sale', app.sale_json(v_id), 'order', app.sale_json(o.id));
end $$;

-- Geld uit de kas (code 1646 Boodschappen). Mag offline worden ingevoerd.
create or replace function public.pos_cash_out(p_token uuid, p_out jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare
  v_store text := app.check_session(p_token, 'terminal');
  v_client uuid := (p_out->>'client_id')::uuid; v_existing bigint;
  v_amount numeric := round((p_out->>'amount')::numeric, 2);
  v_desc text := nullif(trim(coalesce(p_out->>'description', '')), '');
  v_trans bigint; v_id bigint;
begin
  if v_client is null then perform app.err('client_id ontbreekt'); end if;
  select id into v_existing from app.sales where client_id = v_client;
  if v_existing is not null then return jsonb_build_object('duplicate', true, 'sale', app.sale_json(v_existing)); end if;
  if v_amount is null or v_amount <= 0 then perform app.err('Vul een bedrag in.'); end if;
  if v_desc is null then perform app.err('Vul in waarvoor het geld is.'); end if;
  v_trans := app.next_trans_no(v_store);
  insert into app.sales(trans_no, store_code, client_id, kind, sold_at, staff, subtotal, total, payment_method, paid,
                        route_van, route_door, route_afh, comment)
  values (v_trans, v_store, v_client, 'cash_out', app.clamp_time((p_out->>'sold_at')::timestamptz), left(p_out->>'staff', 50),
          -v_amount, -v_amount, 'cash', -v_amount, v_store, v_store, v_store, left(v_desc, 300))
  returning id into v_id;
  insert into app.sale_lines(sale_id, line_no, stock_no, name, unit_price, qty, line_total, net_total)
  values (v_id, 1, '1646', 'Boodschappen: ' || left(v_desc, 200), -v_amount, 1, -v_amount, -v_amount);
  return jsonb_build_object('duplicate', false, 'sale', app.sale_json(v_id));
end $$;

create or replace function public.pos_sale(p_token uuid, p_trans_no bigint) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare v_id bigint;
begin
  perform app.check_session(p_token, 'terminal');
  select id into v_id from app.sales where trans_no = p_trans_no;
  if v_id is null then perform app.err('Transactie ' || p_trans_no || ' niet gevonden.'); end if;
  return app.sale_json(v_id);
end $$;

-- ===================== ophaalorders =====================

create or replace function app.open_orders() returns jsonb
language sql stable security definer set search_path = app, public, extensions as $$
  select coalesce(jsonb_agg(app.sale_json(s.id) order by coalesce(s.pickup_at, s.sold_at)), '[]'::jsonb)
  from app.sales s
  where s.kind = 'sale' and not s.voided
    and ( app.outstanding(s.id) > 0
       or (not s.picked_up and (s.pickup_at is not null or s.route_door <> s.route_van or s.route_afh <> s.route_van))
       or (s.discount > 0 and not s.discount_checked) )
$$;

create or replace function public.pos_open_orders(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'terminal');
  return app.open_orders();
end $$;

create or replace function public.pos_mark_picked_up(p_token uuid, p_trans_no bigint) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare o app.sales;
begin
  perform app.check_session(p_token, 'terminal');
  select * into o from app.sales where trans_no = p_trans_no and kind = 'sale' for update;
  if not found then perform app.err('Order niet gevonden.'); end if;
  if app.outstanding(o.id) > 0 then
    perform app.err('Er staat nog SRD ' || app.outstanding(o.id) || ' open. Laat de klant eerst het restant betalen.');
  end if;
  update app.sales set picked_up = true, picked_up_at = now() where id = o.id;
  return app.sale_json(o.id);
end $$;

-- ===================== dagafsluiting (code 2000) =====================

create or replace function public.pos_close_info(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare v_store text := app.check_session(p_token, 'terminal'); c app.day_closes;
begin
  select * into c from app.day_closes where store_code = v_store order by closed_at desc limit 1;
  return jsonb_build_object('last_closed_at', c.closed_at,
    'transactions', (select count(*) from app.sales where store_code = v_store and not voided
                      and sold_at > coalesce(c.closed_at, '-infinity')));
end $$;

create or replace function public.pos_close_day(p_token uuid, p_close jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare
  v_store text := app.check_session(p_token, 'terminal');
  v_client uuid := (p_close->>'client_id')::uuid;
  prev app.day_closes; v_from timestamptz; v_now timestamptz := now();
  v_expected numeric; v_sold int; v_counted numeric; v_counter bigint; v_prints int;
begin
  if v_client is null then perform app.err('client_id ontbreekt'); end if;
  if exists (select 1 from app.day_closes where client_id = v_client) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  perform pg_advisory_xact_lock(hashtext('close:' || v_store));
  v_counted := round((p_close->>'counted_cash')::numeric, 2);
  v_counter := (p_close->>'dnp_counter')::bigint;
  if v_counted is null or v_counted < 0 then perform app.err('Vul het getelde contante geld in.'); end if;
  if v_counter is null or v_counter < 0 then perform app.err('Vul de stand van de DNP-teller in.'); end if;
  select * into prev from app.day_closes where store_code = v_store order by closed_at desc limit 1;
  v_from := coalesce(prev.closed_at, '-infinity');
  select coalesce(sum(paid), 0) into v_expected from app.sales
    where store_code = v_store and not voided and payment_method = 'cash' and sold_at > v_from and sold_at <= v_now;
  select coalesce(sum(l.qty), 0) into v_sold from app.sale_lines l join app.sales s on s.id = l.sale_id
    where s.store_code = v_store and not s.voided and s.kind = 'sale' and l.dnp and s.sold_at > v_from and s.sold_at <= v_now;
  v_prints := case when prev.id is not null then v_counter - prev.dnp_counter end;
  insert into app.day_closes(store_code, client_id, closed_at, period_from, staff, counted_cash, expected_cash, cash_diff,
                             dnp_counter, dnp_prev_counter, dnp_prints, dnp_sold, dnp_diff, note)
  values (v_store, v_client, v_now, prev.closed_at, left(p_close->>'staff', 50), v_counted, v_expected, v_counted - v_expected,
          v_counter, prev.dnp_counter, v_prints, v_sold, case when v_prints is not null then v_prints - v_sold end,
          left(nullif(trim(coalesce(p_close->>'note', '')), ''), 500));
  return jsonb_build_object('ok', true, 'closed_at', v_now);
end $$;

-- ===================== voorraadmeldingen van personeel =====================

create or replace function public.pos_submit_proposals(p_token uuid, p_items jsonb, p_staff text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_store text := app.check_session(p_token, 'terminal'); it jsonb; v_kind text; v_n int := 0; v_loc text;
begin
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then perform app.err('Geen regels ingevuld.'); end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_kind := it->>'kind';
    v_loc := coalesce(nullif(it->>'location', ''), v_store);
    if v_kind not in ('receive','transfer','new_item') then perform app.err('Onbekend soort melding.'); end if;
    if v_kind = 'transfer' and v_loc = 'MAG' then perform app.err('Kies naar welke winkel het gaat.'); end if;
    if not exists (select 1 from app.locations where code = v_loc) then perform app.err('Onbekende locatie.'); end if;
    if v_kind in ('receive','transfer') then
      if not exists (select 1 from app.products where stock_no = it->>'stock_no') then
        perform app.err('Onbekend stocknummer: ' || coalesce(it->>'stock_no', '?'));
      end if;
      if coalesce((it->>'qty')::int, 0) <= 0 then perform app.err('Vul een aantal in.'); end if;
    else
      if coalesce(trim(it->>'new_name'), '') = '' then perform app.err('Vul de naam van het nieuwe artikel in.'); end if;
      if (it->>'new_price')::numeric is null or (it->>'new_price')::numeric < 0 then perform app.err('Vul een prijs in voor ' || (it->>'new_name')); end if;
    end if;
    insert into app.proposals(store_code, staff, kind, stock_no, location, qty, new_name, new_price, note)
    values (v_store, left(p_staff, 50), v_kind, case when v_kind <> 'new_item' then it->>'stock_no' end, v_loc,
            greatest(coalesce((it->>'qty')::int, 0), 0),
            case when v_kind = 'new_item' then left(trim(it->>'new_name'), 100) end,
            case when v_kind = 'new_item' then round((it->>'new_price')::numeric, 2) end,
            left(nullif(trim(coalesce(it->>'note', '')), ''), 500));
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'count', v_n);
end $$;

create or replace function app.proposals_json(p_where text) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare r jsonb;
begin
  execute 'select coalesce(jsonb_agg(jsonb_build_object(
      ''id'', p.id, ''store_code'', p.store_code, ''created_at'', p.created_at, ''staff'', p.staff, ''kind'', p.kind,
      ''stock_no'', p.stock_no, ''product_name'', pr.name, ''location'', p.location, ''qty'', p.qty,
      ''new_name'', p.new_name, ''new_price'', p.new_price, ''note'', p.note, ''status'', p.status,
      ''handled_at'', p.handled_at, ''result_note'', p.result_note) order by p.created_at desc), ''[]''::jsonb)
    from app.proposals p left join app.products pr on pr.stock_no = p.stock_no where ' || p_where into r;
  return r;
end $$;

create or replace function public.pos_my_proposals(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
declare v_store text := app.check_session(p_token, 'terminal');
begin
  return app.proposals_json(format('p.store_code = %L and p.created_at > now() - interval ''30 days''', v_store));
end $$;

-- ===================== beheer (alleen met beheerderspincode) =====================

create or replace function public.pos_admin_overview(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return jsonb_build_object(
    'low_stock', coalesce((select jsonb_agg(jsonb_build_object('stock_no', p.stock_no, 'name', p.name, 'location', l.code,
                    'location_name', l.name, 'qty', coalesce(s.qty, 0), 'min_stock', p.min_stock) order by l.code, p.stock_no)
                  from app.stock s join app.products p on p.stock_no = s.stock_no join app.locations l on l.code = s.location
                  where p.active and p.track_stock and s.qty <= p.min_stock), '[]'::jsonb),
    'close_issues', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'store_code', store_code, 'closed_at', closed_at,
                    'staff', staff, 'cash_diff', cash_diff, 'dnp_diff', dnp_diff, 'counted_cash', counted_cash,
                    'expected_cash', expected_cash, 'dnp_counter', dnp_counter, 'dnp_prints', dnp_prints, 'dnp_sold', dnp_sold, 'note', note) order by closed_at desc)
                  from app.day_closes where not acknowledged and (cash_diff <> 0 or coalesce(dnp_diff, 0) <> 0)), '[]'::jsonb),
    'pending_proposals', (select count(*) from app.proposals where status = 'pending'),
    'unchecked_discounts', coalesce((select jsonb_agg(app.sale_json(id) order by sold_at desc) from app.sales
                  where kind = 'sale' and not voided and discount > 0 and not discount_checked), '[]'::jsonb),
    'price_mismatches', coalesce((select jsonb_agg(app.sale_json(id) order by sold_at desc) from app.sales
                  where price_mismatch and not mismatch_checked and not voided), '[]'::jsonb));
end $$;

create or replace function public.pos_admin_ack(p_token uuid, p_kind text, p_id bigint) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  if p_kind = 'close' then update app.day_closes set acknowledged = true where id = p_id;
  elsif p_kind = 'discount' then update app.sales set discount_checked = true where trans_no = p_id;
  elsif p_kind = 'mismatch' then update app.sales set mismatch_checked = true where trans_no = p_id;
  else perform app.err('Onbekend'); end if;
end $$;

-- Korting goedkeuren vanaf de ophaalorders-pagina (beheerderspincode wordt direct gevraagd)
create or replace function public.pos_check_discount(p_token uuid, p_admin_pin text, p_trans_no bigint) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_hash text;
begin
  perform app.check_session(p_token, 'terminal');
  perform app.check_lockout('admin');
  select value into v_hash from app.settings where key = 'admin_pin_hash';
  if v_hash is null or v_hash <> crypt(coalesce(p_admin_pin, ''), v_hash) then
    insert into app.login_failures(key) values ('admin');
    perform app.err('Verkeerde beheerderspincode.');
  end if;
  update app.sales set discount_checked = true where trans_no = p_trans_no and kind = 'sale';
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.pos_admin_products(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'stock_no', p.stock_no, 'name', p.name, 'price', p.price, 'category', p.category, 'only_store', p.only_store,
      'track_stock', p.track_stock, 'sellable', p.sellable, 'dnp', p.dnp_pasfoto, 'min_stock', p.min_stock,
      'active', p.active, 'sort_order', p.sort_order, 'note', p.note,
      'qty_mah', (select qty from app.stock where location = 'MAH' and stock_no = p.stock_no),
      'qty_ind', (select qty from app.stock where location = 'IND' and stock_no = p.stock_no),
      'qty_mag', (select qty from app.stock where location = 'MAG' and stock_no = p.stock_no))
      order by p.sort_order, p.stock_no) from app.products p), '[]'::jsonb);
end $$;

create or replace function public.pos_admin_save_product(p_token uuid, p jsonb, p_is_new boolean) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_no text := trim(coalesce(p->>'stock_no', '')); old app.products; v_price numeric;
begin
  perform app.check_session(p_token, 'admin');
  if v_no = '' then perform app.err('Vul een stocknummer in.'); end if;
  if coalesce(trim(p->>'name'), '') = '' then perform app.err('Vul een naam in.'); end if;
  v_price := round((p->>'price')::numeric, 2);
  if v_price is null or v_price < 0 then perform app.err('Vul een geldige prijs in.'); end if;
  if nullif(p->>'only_store', '') is not null and p->>'only_store' not in ('MAH','IND') then perform app.err('Onbekende winkel.'); end if;
  select * into old from app.products where stock_no = v_no;
  if p_is_new and found then perform app.err('Stocknummer ' || v_no || ' bestaat al (' || old.name || ').'); end if;
  if not p_is_new and not found then perform app.err('Artikel niet gevonden.'); end if;
  insert into app.products(stock_no, name, price, category, only_store, track_stock, sellable, dnp_pasfoto, min_stock, active, sort_order, note, updated_at)
  values (v_no, left(trim(p->>'name'), 100), v_price, coalesce(nullif(trim(p->>'category'), ''), 'Overig'),
          nullif(p->>'only_store', ''), coalesce((p->>'track_stock')::boolean, false), coalesce((p->>'sellable')::boolean, true),
          coalesce((p->>'dnp')::boolean, false), coalesce((p->>'min_stock')::int, 0), coalesce((p->>'active')::boolean, true),
          coalesce((p->>'sort_order')::int, coalesce(old.sort_order, (select coalesce(max(sort_order), 0) + 1 from app.products))),
          nullif(trim(coalesce(p->>'note', '')), ''), now())
  on conflict (stock_no) do update set name = excluded.name, price = excluded.price, category = excluded.category,
    only_store = excluded.only_store, track_stock = excluded.track_stock, sellable = excluded.sellable,
    dnp_pasfoto = excluded.dnp_pasfoto, min_stock = excluded.min_stock, active = excluded.active,
    sort_order = excluded.sort_order, note = excluded.note, updated_at = now();
  if old.stock_no is null or old.price <> v_price then
    if old.stock_no is not null and not exists (select 1 from app.price_history where stock_no = v_no) then
      insert into app.price_history(stock_no, price, valid_from) values (v_no, old.price, '-infinity');
    end if;
    insert into app.price_history(stock_no, price) values (v_no, v_price);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Telling invoeren: zet de voorraad op het getelde aantal
create or replace function public.pos_admin_count(p_token uuid, p_location text, p_items jsonb, p_note text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare it jsonb; v_n int := 0;
begin
  perform app.check_session(p_token, 'admin');
  if not exists (select 1 from app.locations where code = p_location) then perform app.err('Onbekende locatie.'); end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if not exists (select 1 from app.products where stock_no = it->>'stock_no') then perform app.err('Onbekend stocknummer ' || (it->>'stock_no')); end if;
    if (it->>'qty')::int is null then continue; end if;
    perform app.set_stock(p_location, it->>'stock_no', (it->>'qty')::int, 'telling', p_note);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'count', v_n);
end $$;

-- Ontvangst (naar een locatie) of verplaatsing (van locatie naar locatie)
create or replace function public.pos_admin_move(p_token uuid, p_kind text, p_from text, p_to text, p_items jsonb, p_note text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare it jsonb; v_q int; v_n int := 0; v_ref text := 'beheer';
begin
  perform app.check_session(p_token, 'admin');
  if p_kind not in ('receive','transfer','correction') then perform app.err('Onbekende handeling.'); end if;
  if not exists (select 1 from app.locations where code = p_to) then perform app.err('Kies een locatie.'); end if;
  if p_kind = 'transfer' and (p_from is null or p_from = p_to or not exists (select 1 from app.locations where code = p_from)) then
    perform app.err('Kies twee verschillende locaties.');
  end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_q := (it->>'qty')::int;
    if v_q is null or v_q = 0 then continue; end if;
    if p_kind <> 'correction' and v_q < 0 then perform app.err('Aantal moet positief zijn.'); end if;
    if not exists (select 1 from app.products where stock_no = it->>'stock_no') then perform app.err('Onbekend stocknummer ' || (it->>'stock_no')); end if;
    if p_kind = 'transfer' then
      perform app.add_stock(p_from, it->>'stock_no', -v_q, 'verplaatsing', v_ref, p_note);
    end if;
    perform app.add_stock(p_to, it->>'stock_no', v_q,
      case p_kind when 'receive' then 'ontvangst' when 'transfer' then 'verplaatsing' else 'correctie' end, v_ref, p_note);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'count', v_n);
end $$;

create or replace function public.pos_admin_proposals(p_token uuid, p_status text) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  if p_status = 'pending' then return app.proposals_json('p.status = ''pending''');
  else return app.proposals_json('p.status <> ''pending'' and p.handled_at > now() - interval ''60 days''');
  end if;
end $$;

-- Melding goedkeuren of afwijzen. p_edit kan aantal/locatie/stocknummer/naam/prijs aanpassen.
create or replace function public.pos_admin_handle_proposal(p_token uuid, p_id bigint, p_approve boolean, p_edit jsonb) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare pr app.proposals; v_qty int; v_loc text; v_no text; v_ref text;
begin
  perform app.check_session(p_token, 'admin');
  select * into pr from app.proposals where id = p_id for update;
  if not found or pr.status <> 'pending' then perform app.err('Deze melding is al afgehandeld.'); end if;
  if not p_approve then
    update app.proposals set status = 'rejected', handled_at = now(), result_note = nullif(p_edit->>'result_note', '') where id = p_id;
    return jsonb_build_object('ok', true);
  end if;
  v_qty := coalesce((p_edit->>'qty')::int, pr.qty);
  v_loc := coalesce(nullif(p_edit->>'location', ''), pr.location);
  v_ref := 'melding ' || pr.id;
  if v_qty < 0 then perform app.err('Aantal kan niet negatief zijn.'); end if;
  if pr.kind = 'new_item' then
    v_no := trim(coalesce(p_edit->>'stock_no', ''));
    if v_no = '' then perform app.err('Geef het nieuwe artikel een stocknummer.'); end if;
    perform public.pos_admin_save_product(p_token, jsonb_build_object(
      'stock_no', v_no, 'name', coalesce(nullif(p_edit->>'name', ''), pr.new_name),
      'price', coalesce((p_edit->>'price')::numeric, pr.new_price),
      'category', coalesce(nullif(p_edit->>'category', ''), 'Overig'),
      'only_store', nullif(p_edit->>'only_store', ''),
      'track_stock', true, 'sellable', true, 'active', true), true);
    if v_qty > 0 then perform app.add_stock(v_loc, v_no, v_qty, 'ontvangst', v_ref, pr.note); end if;
    update app.proposals set stock_no = v_no where id = p_id;
  elsif pr.kind = 'receive' then
    if v_qty > 0 then perform app.add_stock(v_loc, pr.stock_no, v_qty, 'ontvangst', v_ref, pr.note); end if;
  else
    if v_loc = 'MAG' then perform app.err('Een verplaatsing gaat van het magazijn naar een winkel.'); end if;
    if v_qty > 0 then
      perform app.add_stock('MAG', pr.stock_no, -v_qty, 'verplaatsing', v_ref, pr.note);
      perform app.add_stock(v_loc, pr.stock_no, v_qty, 'verplaatsing', v_ref, pr.note);
    end if;
  end if;
  update app.proposals set status = 'approved', handled_at = now(), qty = v_qty, location = v_loc,
         result_note = nullif(p_edit->>'result_note', '') where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.pos_admin_sales(p_token uuid, p_from date, p_to date, p_store text) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return coalesce((select jsonb_agg(app.sale_json(s.id) order by s.sold_at desc)
    from app.sales s
    where (s.sold_at at time zone 'America/Paramaribo')::date between p_from and p_to
      and (p_store is null or p_store = '' or s.store_code = p_store)), '[]'::jsonb);
end $$;

-- Transactie vervallen verklaren. Voorraad gaat terug; restbetalingen op de order vervallen mee.
create or replace function public.pos_admin_void(p_token uuid, p_trans_no bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = app, public, extensions as $$
declare s app.sales; l app.sale_lines; v_ids bigint[]; v_id bigint; v_restored jsonb := '[]'::jsonb; v_voided jsonb := '[]'::jsonb;
begin
  perform app.check_session(p_token, 'admin');
  if coalesce(trim(p_reason), '') = '' then perform app.err('Vul een reden in.'); end if;
  select * into s from app.sales where trans_no = p_trans_no for update;
  if not found then perform app.err('Transactie ' || p_trans_no || ' niet gevonden.'); end if;
  if s.voided then perform app.err('Deze transactie is al vervallen.'); end if;
  v_ids := array[s.id] || coalesce((select array_agg(id) from app.sales where ref_sale_id = s.id and kind = 'balance' and not voided), '{}');
  foreach v_id in array v_ids loop
    update app.sales set voided = true, voided_at = now(), void_reason = left(trim(p_reason), 300) where id = v_id;
    v_voided := v_voided || to_jsonb((select trans_no from app.sales where id = v_id));
    for l in select * from app.sale_lines where sale_id = v_id and stock_location is not null loop
      perform app.add_stock(l.stock_location, l.stock_no, l.qty, 'vervallen',
                            (select trans_no from app.sales where id = v_id)::text, p_reason);
      v_restored := v_restored || jsonb_build_object('stock_no', l.stock_no, 'name', l.name, 'qty', l.qty, 'location', l.stock_location);
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'voided', v_voided, 'restored', v_restored);
end $$;

create or replace function public.pos_admin_report(p_token uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return (with s as (
      select * from app.sales
      where not voided and (sold_at at time zone 'America/Paramaribo')::date between p_from and p_to),
    l as (select l.*, s.store_code from app.sale_lines l join s on s.id = l.sale_id where s.kind = 'sale')
  select jsonb_build_object(
    'stores', (select jsonb_object_agg(st.code, jsonb_build_object(
        'revenue',      (select coalesce(sum(total), 0) from s where store_code = st.code and kind = 'sale'),
        'transactions', (select count(*) from s where store_code = st.code and kind = 'sale'),
        'discount',     (select coalesce(sum(discount), 0) from s where store_code = st.code and kind = 'sale'),
        'received_cash',(select coalesce(sum(paid), 0) from s where store_code = st.code and kind in ('sale','balance') and payment_method = 'cash'),
        'received_pin', (select coalesce(sum(paid), 0) from s where store_code = st.code and kind in ('sale','balance') and payment_method = 'pin'),
        'cash_out',     (select coalesce(-sum(paid), 0) from s where store_code = st.code and kind = 'cash_out'),
        'items', coalesce((select jsonb_agg(x order by x->>'stock_no') from (
                  select jsonb_build_object('stock_no', stock_no, 'name', max(name), 'qty', sum(qty), 'revenue', sum(net_total),
                                            'pasfoto', bool_or(name ilike '%pasfoto%'), 'dnp', bool_or(dnp)) x
                  from l where store_code = st.code group by stock_no) q), '[]'::jsonb),
        'days', coalesce((select jsonb_agg(d order by d->>'day') from (
                  select jsonb_build_object('day', (sold_at at time zone 'America/Paramaribo')::date,
                                            'revenue', sum(total), 'transactions', count(*)) d
                  from s where store_code = st.code and kind = 'sale'
                  group by (sold_at at time zone 'America/Paramaribo')::date) q), '[]'::jsonb),
        'cash_outs', coalesce((select jsonb_agg(jsonb_build_object('trans_no', trans_no, 'sold_at', sold_at, 'staff', staff,
                     'amount', -paid, 'description', comment) order by sold_at) from s where store_code = st.code and kind = 'cash_out'), '[]'::jsonb)
      )) from app.stores st),
    'closes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'store_code', store_code, 'closed_at', closed_at, 'staff', staff,
                'counted_cash', counted_cash, 'expected_cash', expected_cash, 'cash_diff', cash_diff,
                'dnp_counter', dnp_counter, 'dnp_prints', dnp_prints, 'dnp_sold', dnp_sold, 'dnp_diff', dnp_diff,
                'note', note, 'acknowledged', acknowledged) order by closed_at desc)
              from app.day_closes where (closed_at at time zone 'America/Paramaribo')::date between p_from and p_to), '[]'::jsonb)));
end $$;

create or replace function public.pos_admin_stock_moves(p_token uuid, p_stock_no text) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return coalesce((select jsonb_agg(jsonb_build_object('at', at, 'location', location, 'delta', delta, 'qty_after', qty_after,
                   'reason', reason, 'ref', ref, 'note', note) order by at desc)
                   from (select * from app.stock_moves where stock_no = p_stock_no order by at desc limit 200) m), '[]'::jsonb);
end $$;

create or replace function public.pos_admin_settings(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return (select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'staff', staff) order by trans_prefix) from app.stores);
end $$;

create or replace function public.pos_admin_set_staff(p_token uuid, p_store text, p_staff text[]) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  update app.stores set staff = (select coalesce(array_agg(distinct left(trim(n), 50)), '{}') from unnest(p_staff) n where trim(n) <> '')
  where code = p_store;
end $$;

create or replace function public.pos_admin_change_pin(p_token uuid, p_target text, p_new_pin text) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
declare v_others text[];
begin
  perform app.check_session(p_token, 'admin');
  if not app.valid_pin(p_new_pin) then perform app.err('Een pincode moet uit 4 tot 8 cijfers bestaan.'); end if;
  -- controleer dat de nieuwe pincode niet gelijk is aan een andere
  if p_target <> 'ADMIN' and (select value from app.settings where key = 'admin_pin_hash') = crypt(p_new_pin, (select value from app.settings where key = 'admin_pin_hash')) then
    perform app.err('Deze pincode is al in gebruik.');
  end if;
  if exists (select 1 from app.stores where code <> p_target and pin_hash is not null and pin_hash = crypt(p_new_pin, pin_hash)) then
    perform app.err('Deze pincode is al in gebruik.');
  end if;
  if p_target = 'ADMIN' then
    update app.settings set value = crypt(p_new_pin, gen_salt('bf')) where key = 'admin_pin_hash';
  elsif p_target in ('MAH','IND') then
    update app.stores set pin_hash = crypt(p_new_pin, gen_salt('bf')) where code = p_target;
    delete from app.sessions where role = 'terminal' and store_code = p_target;   -- kassa's moeten opnieuw inloggen
  else perform app.err('Onbekend'); end if;
end $$;

create or replace function public.pos_admin_set_update_repo(p_token uuid, p_repo text) returns void
language plpgsql security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  if coalesce(p_repo, '') <> '' and p_repo !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' then
    perform app.err('Vul in als eigenaar/repository, bijv. superphoto/superphoto-pos');
  end if;
  insert into app.settings(key, value) values ('update_repo', nullif(trim(p_repo), ''))
  on conflict (key) do update set value = excluded.value;
end $$;

-- Volledige back-up (zonder pincodes en sessies) als één JSON-bestand
create or replace function public.pos_admin_export(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = app, public, extensions as $$
begin
  perform app.check_session(p_token, 'admin');
  return jsonb_build_object(
    'exported_at', now(), 'format', 'superphoto-pos-backup-1',
    'stores', (select jsonb_agg(to_jsonb(s) - 'pin_hash') from app.stores s),
    'settings', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.settings x where key <> 'admin_pin_hash'),
    'counters', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.counters x),
    'products', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.products x),
    'price_history', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.price_history x),
    'stock', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.stock x),
    'stock_moves', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.stock_moves x),
    'customers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.customers x),
    'sales', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.sales x),
    'sale_lines', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.sale_lines x),
    'day_closes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.day_closes x),
    'proposals', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from app.proposals x));
end $$;

-- ===================== rechten =====================
-- Alleen de pos_* functies zijn van buitenaf aan te roepen; de tabellen niet.
revoke all on all functions in schema app from public;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'pos\_%' loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
