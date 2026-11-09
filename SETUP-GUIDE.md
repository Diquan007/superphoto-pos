# Super Photo Kassa: setup guide

This guide takes you from nothing to two working registers. Plan about an hour, and do it on a day the shops are closed or quiet. Do steps 1 to 3 once. Repeat step 4 on every PC that should be able to work as a register.

**What's in this folder**

| File | What it is |
|---|---|
| `SuperPhotoKassa-Setup-1.0.0.exe` | The Windows installer for the register program |
| `01_schema.sql` | Database step 1: the tables |
| `02_functions.sql` | Database step 2: the rules (logins, sales, stock, end of day) |
| `03_products.sql` | Database step 3: your 319 products and prices from the stock list |
| `superphoto-pos-source.zip` | The program's source code, for GitHub (automatic updates) |
| `HANDLEIDING-KASSA.md` | Short guide for staff, in Dutch |

---

## 1. Create the database (Supabase)

1. Go to **supabase.com**, then **Start your project**. Sign up, for example with your GitHub account.
2. Click **New project**.
   - Name: `superphoto`
   - Database password: let it generate one and **save it somewhere safe**. You won't need it every day.
   - Region: **East US (North Virginia)** or **South America (São Paulo)**. Either is close to Suriname.
   - Plan: Free is fine to start (see "Backups" at the bottom).
3. Wait until the project is ready (1–2 minutes).
4. In the left menu, open **SQL Editor**, then **New query**.
5. Open `01_schema.sql` in Notepad, select all (Ctrl+A), copy, paste it into the SQL Editor and click **Run**. You should see "Success. No rows returned".
6. Do the same with `02_functions.sql`, then with `03_products.sql`. Always in this order.
7. Go to **Project Settings** (gear icon), then **API Keys**. Write down:
   - the **Project URL** (looks like `https://abcdefgh.supabase.co`). It's on the **Data API** page or the project's home page.
   - the **Publishable key** (starts with `sb_publishable_`). If you only see "anon public", that one works too.

   These two values are not secret passwords. The database only accepts actions with a valid register PIN or your admin PIN. **Never** share the `service_role`/secret key or the database password.

> Do step 2 straight after this. Until the PINs are set, the first person to open the program chooses them.

## 2. First start: choose your PINs

1. Install the program on your own PC first (see step 4).
2. On first start, paste the **Project URL** and **Publishable key** and click **Verbinden**.
3. The program asks for three PINs (4–8 digits, all different):
   - **Beheerderspincode**: only you. Needed to void sales, change prices, enter stock counts, approve staff reports and see the dashboard.
   - **Pincode kassa Mahony** and **Pincode kassa Indira**: the staff use these to open the register.
   - You can also choose the first transaction numbers. Mahony starts at 100001 and Indira at 200001 unless you change it. This can only be set before the first sale.

## 3. Automatic updates (GitHub)

Updates go through GitHub. When there's a new version, each register downloads it in the background and installs it the next time the program closes.

1. On github.com, click **New repository**. Name it **`superphoto-pos`**, set it to **Public**, and don't add a README.
   *Why public:* the registers download updates from it without a password. The code contains no passwords or keys. Your data lives in Supabase, not in GitHub.
2. Put the code in it. Either:
   - **easiest:** tell me in the chat that the repository exists, and I'll upload the code and start the first release; or
   - unzip `superphoto-pos-source.zip` and upload all files with **Add file → Upload files**. Make sure the `.github` folder comes along.
3. In GitHub, open **Actions → Release → Run workflow**. After about 10 minutes, a release with the installer appears under **Releases**.
4. In the register program, go to **Beheer → Instellingen → Automatische updates**. Fill in `your-github-name/superphoto-pos` and click **Opslaan**.

## 4. Install on each PC (both shops, and the backup PCs)

1. Copy `SuperPhotoKassa-Setup-1.0.0.exe` to the PC (USB stick, or download it from GitHub Releases) and double-click it.
2. Windows shows **"Windows protected your PC"** because the program isn't signed. Click **More info**, then **Run anyway**. This happens once per install.
3. Follow the installer. A **Super Photo Kassa** icon appears on the desktop.
4. On first start, paste the Project URL and key (step 1.7), choose the shop and enter that register's PIN.
5. **Printer:** first install the Windows driver for the receipt printer (from the printer's CD or the maker's website) and print a Windows test page. Then go to **Beheer → Instellingen → Bonprinter**, choose the printer, then **Testbon printen**, then **Opslaan**. Receipts are 80 mm at Mahony and 58 mm at Indira.

**When the register PC breaks:** open the program on another PC that has it installed, choose the shop and enter the register PIN. Transaction numbers come from the database, so there are never duplicates. Sales that were saved offline on the broken PC are sent once that PC is back online.

## 5. Going live

1. **Staff names:** check the list under **Beheer → Instellingen → Medewerkers** (taken over from the Gemini version).
2. **Fresh stock count:** in **Beheer → Voorraad → Telling invoeren**, count **Winkel Mahony**, **Winkel Indira** and **Magazijn Mahony** separately. Only fill in what's actually at that location. Leave everything else empty. Stock starts at 0, so until you count, every sale of a stock item shows a red warning.
3. **First end of day:** on the first evening, staff enter the DNP counter as usual. That first time there's nothing to compare with yet ("eerste keer"). From day 2, you'll see the difference.
4. Check the prices of a few items, especially the ones that had no price in column C and were skipped (see the last section).

## Daily use for you

- **Beheer → Overzicht** shows what needs attention: items at 0 or below, end-of-day differences (cash and DNP), staff reports to approve, and discounts to check.
- **Dashboard:** revenue per shop, cash and PIN received, passport photos, and items sold per stock number, for any period. It can be exported to Excel (CSV).
- **Transacties:** find a sale and mark it **Vervallen** (void). Stock items go back into stock, and any balance payments on that order are voided too.
- **Meldingen:** staff report goods received, items moved from the storeroom, or new items without a stock number. Nothing changes until you approve. For a new item, you give it a stock number when approving.

## Backups

On Supabase's **Free** plan there are **no automatic backups**, and a project pauses after 7 days without use. Daily use prevents the pause.

- Go to **Beheer → Instellingen → Back-up downloaden** **every week** and keep the file on a USB stick or in Google Drive. It contains all sales, stock, products and customers.
- Or upgrade to Supabase **Pro** (USD 25/month), which includes daily backups kept for 7 days and never pauses.

## What was not imported from the stock list

As agreed, these were skipped:
- Codes that are now built into the program: 1060 Saldo (balance payment), 1646 Boodschappen (Kas uit), 2000 End of day (Dagafsluiting), 1645 Overgeslagen bon, 1030 Retour, 1022 Mitsu counter.
- Items with old prices: batteries (1504–1516), white and black T-shirts (1757–1783), 1643 sharpener, 1644 pencils.
- Rows without a name or with `#REF!`.

You can add any of these back under **Beheer → Artikelen → + Nieuw artikel**.

The 20 paper rolls, cartridges and photo paper sheets are in the system as **verbruiksartikelen** (supplies). Their stock is tracked, but they can't be sold at the register.
