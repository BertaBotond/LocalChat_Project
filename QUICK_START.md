# 🚀 Gyors Indítási Útmutató | Quick Start Guide

## ✅ Elvégzett Fejlesztések / Completed Improvements

### 🔒 Biztonsági Javítások / Security Fixes
1. **Munkamenet titkosítás** - Dynamic session secret (nem kódolt)
2. **Automatikus MySQL kapcsolódás** - Auto-discovery és fallback
3. **SQL injekció védelme** - Parameterized queries mindenhol
4. **Tranzakció biztonság** - Proper rollback és connection cleanup

### 🛠️ Funkcionális Javítások / Functional Fixes  
1. **Upload könyvtár** - Létrehozva és konfigurálva
2. **Adatbázis hibakezelés** - Robust error handling
3. **.env konfiguráció** - Optimális alapértelmezések

### 📊 Támogatott Diagnosztika / Available Diagnostics
```bash
npm run doctor           # 🏥 Teljes rendszerellenőrzés
npm run diag:db          # 💾 Adatbázis kapcsolat teszt
npm run diag:network     # 🌐 Hálózat konfiguráció teszt
npm run smoke            # 🧪 Startup smoke + recovery útvonal ellenőrzés
```

### 🧩 Uj Admin Es Multi-Gepes Fajlok
```bash
backend/.env.shared.example   # Kozos, tobble gepre masolhato minta
GET /admin                    # Kulon admin diagnosztikai frontend
GET /api/admin/diagnostics    # Vedett admin API (x-admin-token)
POST /api/admin/smoke-test    # Manualis smoke futtatas (x-admin-token)
```

---

## 🚀 Indítás Lépésről Lépésre / Step by Step

### ⚡ Egyparancsos backend indítás (ajánlott)
```bash
cd NodeJS-Template-2025/backend
npm run up
```

Mit csinal automatikusan:
- Letrehozza a `.env` fajlt `.env.example` alapjan, ha hianyzik.
- Telepiti a fuggosegeket, ha hianyzik a `node_modules`.
- Pre-run diagnosztika alapjan automatikusan modot valaszt (`direct` / `port-switch` / `tunnel`).
- Lefuttatja az adatbazis diagnosztikat.
- Kiirja a kliens URL-eket (localhost + LAN).
- Tunnel modban publikus `https://...` URL-t is kiir (`ngrok`, fallback `localtunnel`).
- Ha hiba van, pontos okot es javitasi tippet ad a terminalban.

### 1️⃣ Előfeltételek / Prerequisites
- ✅ Node.js (LTS verzió) telepítve
- ✅ XAMPP MySQL futtatva (127.0.0.1:3306)
- ✅ Legalabb egy elerheto HTTP port (pl. 3000 vagy 8080)

### 2️⃣ Projekt Beállítása / Project Setup
```bash
# Backend mappába menni
cd backend

# Függőségek telepítése (már megtörtént)
npm install

# Diagnosztika futtatása
npm run doctor
```

### 3️⃣ Szerver Indítása / Start Server
```bash
# Fejlesztési mód (auto-reload)
npm run dev

# Vagy normális mód
npm start
```

### 4️⃣ Kliens Csatlakozása / Connect Client
- Nyisd meg: a terminalban kiirt `http://127.0.0.1:<port>` URL-t
- Vagy: a terminalban kiirt `http://[LAN IP]:<port>` URL-t mas geprol
- Tunnel modban: a terminalban kiirt `https://...` URL-t
- Válassz felhasználónevet és szobát

---

## 🔧 Hibaelhárítás / Troubleshooting

### MySQL nem jól csatlakozik?
```bash
npm run diag:db
```
- Ellenőrizd a MySQL futás
- Nézd a próbálkozások listáját (attempts)

### Hálózat probléma?
```bash
npm run diag:network
```
- Megjeleníti az összes hálózati interfészt
- Ajánlott LAN IP-t mutat

### Szerver nem indul?
- Ellenőrizd: MySQL fut-e?
- Ellenőrizd: `npm install` megtörtént-e?
- Futtatsd: `npm run doctor`

---

## 📁 Fájl Szerkezet / File Structure

```
backend/
├── .env                 # ✅ Konfigurációs fájl (MySQL, PORT, stb)
├── .env.example         # Sablon
├── server.js            # 🔒 Javított: Session secret
├── package.json         # Függőségek
├── api/
│   └── api.js          # REST API endpoints
├── sql/
│   ├── database.js      # 🔒 Javított: Tranzakciók
│   └── schema.sql       # Adatbázis séma
├── config/
│   ├── runtime.js       # Futásidejű konfiguráció
│   └── network.js       # Hálózat detekció
├── discovery/
│   └── discovery.js     # Host discovery
├── security/
│   └── validation.js    # Input validáció
├── scripts/
│   ├── doctor.js        # 🏥 Teljes ellenőrzés
│   ├── diag:db.js       # 💾 DB teszt
│   └── network-diag.js  # 🌐 Hálózat teszt
└── uploads/             # ✅ Létrehozva: Képfeltöltések
```

---

## 📋 Konfiguráció / Configuration

### Alapértelmezett .env beállítások
```env
SERVER_HOST=0.0.0.0          # Összes interfészen hallgatózz
SERVER_PORT=3000              # Webszerver port
STRATEGY_PORT_CANDIDATES=8080,80,443  # Automata portvaltas sorrend
TUNNEL_PROVIDER=auto                 # auto | ngrok | localtunnel
NGROK_AUTHTOKEN=                     # Opcionális, ngrok-hoz javasolt
NGROK_REGION=eu                      # Opcionális (pl. eu)
LAN_ONLY=true                 # Csak LAN hozzáférés

DB_HOST=127.0.0.1             # MySQL szerver
DB_HOST_AUTO=true             # ✅ Auto-detekció
DB_PORT=3306                  # MySQL port
DB_USER=root                  # Felhasználó
DB_PASSWORD=                  # Jelszó (XAMPP: üres)
DB_NAME=localchat             # Adatbázis neve

DISCOVERY_AUTO_RANGE=true     # ✅ Auto IP tartomány detekció
DISCOVERY_MODE=fallback       # Host discovery mód
```

---

## 🎯 Teljesítmény & Biztonság

### Biztonsági Intézkedések
- ✅ SQL injection védelem (parameterized queries)
- ✅ CSRF token validáció
- ✅ Rate limiting (240 req/min)
- ✅ Socket rate limiting (30 msg/10s)
- ✅ Input validációs szűrők
- ✅ MIME type whitelisting

### Adatbázis Biztonság
- ✅ AUTO_INCREMENT ID-k
- ✅ Foreign key constraints
- ✅ Transaction support
- ✅ Cascade delete
- ✅ UTF-8 charset

---

## 🆘 Gyors Ellenőrzés / Quick Verification

Futtasd ezt az egész állomány indításakor:
```bash
npm run doctor
```

**Sikeres kimenet**:
```json
{
  "ready": true,
  "database": {
    "ok": true,
    "details": {
      "selectedHost": "127.0.0.1"
    }
  }
}
```

---

## 📞 Gyakori Hibák / Common Issues

| Hiba | Megoldás |
|------|----------|
| `connect ECONNREFUSED` | MySQL nem fut - XAMPP indítása |
| `ETIMEDOUT` | Firewall blokkolja - Check Windows Firewall |
| `ER_ACCESS_DENIED_ERROR` | Rossz DB_USER/PASSWORD - Check XAMPP beállítás |
| `npm not found` | Node.js nincs telepítve - Telepítsd |
| `Port already in use` | 3000 port foglalt - Megváltoztatás a .env-ben |

---

## ✨ Ready to Go!

```bash
cd backend
npm run dev
```

🎉 **Szerver indul be**
- http://127.0.0.1:3000

Csatlakozz bejövő LAN IP-ről:
- http://[your-lan-ip]:3000

---

### 📚 További Info / More Info
- [Teljes audit jelentés](FIXES_AND_IMPROVEMENTS.md)
- [README](readme.md)
- Diagnosztika: `npm run doctor`
