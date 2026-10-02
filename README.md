# Ruang Kuis

Platform kuis interaktif berbahasa Indonesia. Frontend memakai Vue 3, TypeScript, dan Vite; API memakai Node.js, Hono, Zod, Supabase Auth, Drizzle ORM, dan PostgreSQL.

## Menjalankan

```sh
npm install
npm run dev
```

Jalankan API di terminal kedua dengan `npm run api:dev`. API berjalan pada port 8787. Untuk membuat build produksi frontend dan typecheck frontend/API: `npm run build`.

## Menyiapkan Supabase

Isi `.env` pada root proyek dengan Project URL dan publishable/anon key dari **Supabase → Project Settings → API**. Nama variabelnya `VITE_SUPABASE_URL` dan `VITE_SUPABASE_ANON_KEY`. Restart server Vite setelah mengubah `.env`. `src/lib/supabase.ts` mengekspor client Supabase saat kedua nilai tersedia.

Variabel dengan awalan `VITE_` dikirim ke browser, jadi hanya isi dengan key publik Supabase. Jangan taruh `service_role` atau secret key di berkas ini. Credential server harus disimpan di lingkungan backend tersendiri.

## Drizzle ORM (server-side)

`DATABASE_URL` adalah connection string PostgreSQL Supabase dan terpisah dari URL/key browser. Jangan menambahkan awalan `VITE_` ke variabel ini. Konfigurasi yang digunakan saat ini adalah transaction pooler; driver memakai `prepare: false`.

Schema ada di `server/db/schema.ts`; koneksi Drizzle ada di `server/db/index.ts`. Migrasi awal telah diterapkan ke proyek Supabase yang ditautkan. Untuk perubahan schema berikutnya, jalankan:

```sh
npm run db:generate  # tinjau SQL migrasi di server/db/migrations
npm run db:migrate   # terapkan migrasi ke Supabase
npm run db:studio    # buka Drizzle Studio
```

Tinjau SQL sebelum menerapkan migrasi. API tervalidasi ada di `server/index.ts`. Tabel database memakai RLS default-deny dan pencabutan akses langsung bagi `anon`/`authenticated`; akses game dilakukan melalui API.

## Alur yang tersedia

- Email/password sign-up dan sign-in Supabase Auth.
- Simpan draf, terbitkan snapshot kuis immutable, dan buat sesi live.
- PIN sesi, nama peserta unik per sesi, token peserta berbatas sesi, serta batas 100 peserta.
- Command sesi host dengan state version dan state event sequence; broadcast private melalui Supabase Realtime plus snapshot recovery.
- Jawaban divalidasi di server dengan deadline server-side, idempotency, dan skor deterministik dari aturan PRD.
- Snapshot terpisah untuk host/peserta, ringkasan hasil dan ekspor CSV.
- Responsif, fokus keyboard, dan dukungan `prefers-reduced-motion`.

## Integrasi layanan

Alur editor dan sesi demo lokal masih tersedia saat pengguna belum masuk. Pekerjaan PRD yang belum tercakup: upload/processing media Storage, assignments self-paced, co-host/tim, tipe soal P1/P2, analitik lanjutan, admin/moderasi, retention/ekspor data workspace, job terpisah, monitoring, dan load/security/UAT sesuai target. API live MVP sekarang dapat dipakai lintas perangkat, tetapi belum memenuhi bukti kapasitas 100 pemain atau target latency PRD sampai load test dan konfigurasi operasional dilakukan.
