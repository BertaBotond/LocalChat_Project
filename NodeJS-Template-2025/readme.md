<h1 align="center">LocalChat - Hasznalat es Mukodes</h1>

## 1. Oldal hasznalati utmutato

Ez a resz kifejezetten a felhasznaloi oldalt irja le: hogyan nyisd meg az oldalt, hogyan hasznald a chatet, mit jelentenek a fo elemek.

### 1.1 Oldal megnyitasa

1. Inditsd el a backendet:

```bash
cd backend
npm run up
```

2. Nyisd meg bongeszoben a chat oldalt:

- ugyanazon gepen: `http://localhost:3000`
- masik geprol: `http://<szerver-lan-ip>:3000`

3. Admin diagnosztika oldal:

- `http://<szerver>:3000/admin`

### 1.2 Elso lepesek a chat feluleten

1. Add meg a felhasznaloneved (`legalabb 2 karakter`).
2. Valassz szobat a listabol.
3. Ird be az uzenetedet, majd kuldd el (`Kuldes` gomb vagy `Enter`).
4. Opcionisan valts uzenet tipust:
   - Text
   - Code
   - Emoji
   - Image

### 1.3 Fontos UI elemek

1. `Kliens csatlakozas` panel:
   - mutatja a hasznalhato URL-t masik gepekhez
   - egy kattintassal masolhato
2. `Host statuszok`:
   - online/offline/unknown gepek
3. `Chat csatlakozott userek`:
   - aktualisan kapcsolodott kliensek
4. `LAN backup terv`:
   - gyors hibakereso segedlet policy/firewall/VLAN helyzetekre
5. `Smart hint` es kuldes guard:
   - jelzi, ha pl. hianyzik a nev vagy private roomhoz kod kell

### 1.4 Szobakezeles

1. Uj szoba letrehozas:
   - add meg a nevet
   - opcionisan private room
2. Private room:
   - meghivott userek valasztasa
   - meghivokod alapu csatlakozas
3. Owner eszkozok private roomhoz:
   - invite kod masolas/forgatas
   - tagok kezelese

### 1.5 Uzenet kuldes tippek

1. Code modban kodblokk jelenik meg.
2. Emoji modban gyors reakcio kuldheto.
3. Image modban kep kuldheto (max meret env alapjan).
4. Uzenetek tartalma masolhato a UI-bol.
5. Az oldal draftot ment szobankent (localStorage), hogy ne vesszen el gepeles kozben.

### 1.6 Admin oldal hasznalata

1. Nyisd meg az `/admin` oldalt.
2. Add meg az `ADMIN_TOKEN` erteket.
3. `Frissites` gomb:
   - secure log status
   - recovery status
   - runtime/network allapot
   - startup smoke report
4. `Smoke futtat` gomb:
   - kezileg ujrafuttatja az integritasi smoke ellenorzest.

---

## 2. Mukodes (technikai leiras)

Ez a resz arrol szol, hogyan mukodik a rendszer a hatterben.

### 2.1 Rendszer attekintes

1. Backend: Express + Socket.IO + MySQL.
2. Frontend: statikus HTML/CSS/JS.
3. Discovery: LAN host status kovetes.
4. Security: input validacio, rate limit, security headerek.
5. Logging: titkositott szerver audit log.

### 2.2 Startup folyamat

A `npm run up` vagy `npm run dev` inditas utan a backend:

1. betolti a runtime configot,
2. inicializalja az adatbazist,
3. lefuttatja a startup smoke tesztet,
4. elinditja a HTTP + Socket szervert,
5. fallback portot hasznal, ha az alap port foglalt,
6. elinditja a discovery szolgaltatast,
7. periodikusan allapot snapshotot logol.

### 2.3 Adatbazis es recovery

1. A schema automatikusan letrejon (`rooms`, `messages`, `host_status`, `connections_log`, `room_members`).
2. Uj/gepfriss initnel a rendszer megprobal recovery-t a titkositott logbol.
3. Ha nincs log vagy nem olvashato, recovery statusban jelzi az okot.
4. Recovery allapot API-bol lekeroheto.

### 2.4 Titkositott logolas

1. Az audit log titkositott fajlba megy (`AES-GCM`).
2. Pufferelt, batch flush iras csokkenti a terhelest.
3. Log rotation vedi a diszkteruletet.
4. A kulcsot a `LOG_ENCRYPTION_KEY` adja.

Kritikus szabaly multi-gepes hasznalatnal:

- minden gepen ugyanaz legyen a `LOG_ENCRYPTION_KEY`, kulonben recovery inkompatibilis lesz.

### 2.5 Biztonsagi vedelem

1. HTTP rate limit (IP alapon).
2. Socket kuldesi limit + spam blokk.
3. Input normalizalas/validacio.
4. Security headerek (CSP, X-Frame-Options, nosniff, stb.).
5. Upload MIME + meret ellenorzes.
6. Admin endpoint tokenes vedelme:
   - `x-admin-token`
   - timing-safe compare
   - brute-force limiter

### 2.6 Fo API endpointok

Altalanos:

- GET `/api/config`
- GET `/api/network-diagnostics`
- GET `/api/rooms`
- POST `/api/rooms`
- GET `/api/rooms/:id/messages`
- GET `/api/rooms/:id/messages/search`
- POST `/api/rooms/:id/images`
- GET `/api/hosts`
- POST `/api/hosts/rescan`
- GET `/api/stats`

Log/recovery:

- GET `/api/log/status`
- GET `/api/log/recovery-status`

Admin (vedett):

- GET `/api/admin/diagnostics`
- POST `/api/admin/smoke-test`

### 2.7 Konfiguracio (.env)

A legfontosabb valtozok:

- `SERVER_HOST`, `SERVER_PORT`, `LAN_ONLY`
- `DB_HOST`, `DB_HOST_AUTO`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `LOG_ENCRYPTION_KEY`, `ADMIN_TOKEN`
- `SECURE_LOG_FLUSH_MS`, `SECURE_LOG_BATCH_SIZE`, `SECURE_LOG_ROTATE_MAX_BYTES`, `SECURE_LOG_ROTATE_FILES`
- `STARTUP_SMOKE_STRICT`, `AUTO_SNAPSHOT_INTERVAL_MS`

Javasolt minta tobb gephez:

- `backend/.env.shared.example`

### 2.8 Diagnosztikai parancsok

```bash
npm run doctor
npm run diag:db
npm run diag:network
npm run smoke
npm run verify:full
npm run verify:full:nostrict
```

Teljes ellenorzes futtatas:

1. `verify:full` strict modban fut, es hibakodot ad vissza ha barmelyik kotelezo check elhasal.
2. `verify:full:nostrict` riportot keszit akkor is, ha vannak hibak (pl. nincs epp futo szerver az API checkhez).
3. Elo backend szerver ellenorzeshez inditsd kulon terminalban: `npm run up`, majd futtasd a verify parancsot.

### 2.9 Gyors hibakereses

1. Smoke failed `LOG_ENCRYPTION_KEY` miatt:
   - allits be legalabb 32 karakteres erteket minden gepen azonosan.
2. Admin endpoint 401:
   - hibas vagy hianyzo `ADMIN_TOKEN`.
3. DB timeout:
   - ellenorizd MySQL futast, host/port beallitast, firewall szabalyokat.
4. Kliens nem csatlakozik LAN-on:
   - localhost helyett LAN IP-t hasznalj.

---

## 3. Gyors uzembe helyezes (osszefoglalo)

```bash
cd backend
npm install
copy .env.shared.example .env
npm run up
```

Ezutan:

1. Chat: `http://localhost:3000`
2. Admin: `http://localhost:3000/admin`
