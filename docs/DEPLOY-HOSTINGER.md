# Panduan Hosting GNOSIA di Hostinger (Node.js Web Apps + MySQL)

GNOSIA menggunakan **Node.js (Fastify)** sebagai satu server terpadu yang melayani REST API (`/api/*`), WebSocket (`/ws/*`), dan tampilan antarmuka **React 19** (`frontend/dist`), dengan database **MySQL / MariaDB** bawaan Hostinger.

> **Syarat Paket Hostinger:** Fitur **Node.js Web Apps** tersedia di paket **Hostinger Business Web Hosting** dan **Hostinger Cloud Hosting** (Cloud Startup / Professional / Enterprise). Paket *Single / Premium Shared Hosting* biasa belum mendukung Node.js Web Apps.

---

## Langkah 1 — Buat Database MySQL di hPanel Hostinger

1. Login ke **hPanel Hostinger** → pilih menu **Websites** → klik **Dashboard / Manage** pada website atau akun hostingmu.
2. Di sidebar kiri, buka **Databases** → **Management**.
3. Di bagian **Create a New MySQL Database And Database User**, isi:
   - **MySQL Database Name**: misal `gnosia` *(Hostinger otomatis memberi prefix seperti `u123456789_gnosia`)*
   - **MySQL Username**: misal `gnosia_user` *(menjadi `u123456789_gnosia_user`)*
   - **Password**: buat password kuat dan **simpan catatannya**.
4. Klik **Create**. Catat 4 informasi ini:
   - **Database Name** (`u123456789_gnosia`)
   - **Username** (`u123456789_gnosia_user`)
   - **Password**
   - **MySQL Host** (biasanya `127.0.0.1` atau `localhost` — gunakan `127.0.0.1` agar koneksi TCP stabil di Node.js)

> **Catatan:** Kamu **tidak perlu** import file `.sql` lewat phpMyAdmin! Saat aplikasi GNOSIA pertama kali menyala, server otomatis membuat seluruh 22 tabel MySQL beserta kurikulum bawaan dan akun awal jika database masih kosong.

---

## Langkah 2 — Siapkan File Deploy (Pilih Cara A atau Cara B)

Ada **2 cara** upload aplikasi Node.js ke Hostinger. **Cara A (Upload `.zip`) sangat direkomendasikan** karena proses build React & TypeScript dilakukan di laptopmu, sehingga di server Hostinger prosesnya jauh lebih cepat dan hemat RAM.

### Cara A (Direkomendasikan): Buat & Upload `gnosia-hostinger.zip`

Jalankan perintah ini di terminal laptop dari folder `/home/qhumy/Documents/gnosia`:

```bash
npm run zip:hostinger
```

Perintah tersebut otomatis:
1. Mengompilasi frontend (`frontend/dist`)
2. Mengompilasi backend TypeScript (`backend-node/dist` + `schema.sql` + data kurikulum)
3. Membungkus semuanya ke file **`gnosia-hostinger.zip`** (±1–2 MB, ringan tanpa `node_modules`).

### Cara B (Alternatif): Deploy Otomatis dari GitHub Repository

1. Push kode hasil migrasi ini ke repositori GitHub milikmu:
   ```bash
   git add .
   git commit -m "feat: migrate database from PostgreSQL to MySQL for Hostinger"
   git push origin main
   ```
2. Nanti di hPanel kamu tinggal menghubungkan akun GitHub dan memilih repo tersebut.

---

## Langkah 3 — Buat Node.js Web App di hPanel Hostinger

1. Buka **hPanel** → **Websites** → klik **Add Website** → pilih **Node.js Apps** *(atau dari dashboard domain → **Node.js**)*.
2. Pilih sumber kode sesuai langkah sebelumnya:
   - Jika pakai **Cara A**: pilih **Upload your website files** → unggah file `gnosia-hostinger.zip`.
   - Jika pakai **Cara B**: pilih **Import Git Repository** → hubungkan GitHub dan pilih repo `gnosia`.
3. Pada halaman **Build / App Settings**, pastikan pengaturannya seperti berikut:

   | Pengaturan | Nilai |
   |---|---|
   | **Node.js Version** | **22.x** *(atau 24.x jika tersedia)* |
   | **Root Directory** | `/` *(biarkan default)* |
   | **Build Command** | `npm run build` |
   | **Start Command** | `npm start` |
   | **Entry File** *(jika diminta)* | `server.js` |

4. Klik **Environment Variables (Variabel Lingkungan)** dan tambahkan variabel berikut:

   | Nama Variabel | Isi / Contoh Nilai |
   |---|---|
   | `NODE_ENV` | `production` |
   | `GNOSIA_DB_HOST` | `127.0.0.1` |
   | `GNOSIA_DB_PORT` | `3306` |
   | `GNOSIA_DB_NAME` | `u123456789_gnosia` *(sesuai nama DB di Langkah 1)* |
   | `GNOSIA_DB_USER` | `u123456789_gnosia_user` *(sesuai user DB di Langkah 1)* |
   | `GNOSIA_DB_PASSWORD` | *password database dari Langkah 1* |
   | `GNOSIA_SECRET_KEY` | *string acak panjang minimal 40 karakter untuk tanda tangan JWT* |
   | `GNOSIA_DEMO_PASSWORD` | *password kuat pilihanmu untuk akun admin/mentor/demo awal* |
   | `GNOSIA_COOKIE_SECURE` | `true` |

   > **Tips:** Memakai `GNOSIA_DB_HOST`, `GNOSIA_DB_USER`, `GNOSIA_DB_PASSWORD`, dan `GNOSIA_DB_NAME` secara terpisah jauh lebih aman daripada merangkai `GNOSIA_DATABASE_URL=mysql://...` sendiri, karena karakter unik pada password Hostinger (seperti `@`, `#`, `/`, `?`) tidak akan merusak format URL! *(Kalau tetap ingin 1 baris URL, `GNOSIA_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/db` juga tetap didukung).*
   >
   > Variabel `PORT` **tidak perlu** diisi karena Hostinger mengisinya secara otomatis dan aplikasi otomatis bind ke `0.0.0.0:$PORT`.

5. Klik **Deploy** dan tunggu proses instalasi selesai (sekitar 15–60 detik untuk `.zip`, atau 1–3 menit untuk GitHub).
6. Hubungkan domain / subdomain kamu ke Node.js App tersebut di hPanel (**Connect Domain**). Sertifikat SSL (HTTPS) akan aktif otomatis.

---

## Langkah 4 — Cek & Uji Aplikasi Setelah Online

1. Cek endpoint kesehatan server: buka `https://domainkamu.com/api/health` → harus muncul `{"status":"ok"}`.
2. Buka `https://domainkamu.com/masuk` dan login menggunakan akun Administrator awal:
   - **Email Admin:** `sekar@smksig.sch.id`
   - **Email Mentor:** `dimas@smksig.sch.id`
   - **Password:** sesuai nilai `GNOSIA_DEMO_PASSWORD` yang kamu pasang di Environment Variables (atau `gnosia123` bila tidak diisi).
3. Masuk ke menu **Admin (`/admin/pengguna`)** untuk membuat akun guru/siswa baru atau mengelola kurikulum di **Builder (`/admin/bab`)**.
4. Coba buka salah satu bab atau **Playground (`/playground`)** lalu klik tombol **Jalankan** untuk memastikan sandbox eksekusi kode JavaScript berjalan lancar di container Hostinger.

---

## Troubleshooting Umum di Hostinger

| Gejala | Penyebab & Solusi |
|---|---|
| Error `ECONNREFUSED ::1:3306` atau `Access denied` | Pastikan `GNOSIA_DB_HOST` diisi `127.0.0.1` (bukan `localhost` yang kadang mengarah ke IPv6 `::1`), dan cek ulang prefix `u123456789_` pada `GNOSIA_DB_NAME` serta `GNOSIA_DB_USER`. |
| Login berhasil tapi langsung mental balik ke `/masuk` | Jika domain masih HTTP (SSL belum aktif), set sementara `GNOSIA_COOKIE_SECURE=false`. Setelah HTTPS aktif, kembalikan ke `true`. |
| Gagal build kehabisan memori saat import dari GitHub | Gunakan **Cara A (`npm run zip:hostinger`)** dari laptop lalu upload `gnosia-hostinger.zip` agar server Hostinger tidak perlu menjalankan kompilasi Vite & TypeScript. |
| Mengganti `GNOSIA_DEMO_PASSWORD` setelah deploy pertama tidak mengubah password | `GNOSIA_DEMO_PASSWORD` hanya dibaca saat tabel `users` masih kosong (start pertama). Untuk reset dari nol, kosongkan tabel lewat **phpMyAdmin** di hPanel lalu klik **Restart App**. |
