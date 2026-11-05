# Post-it Board

A live classroom post-it board. The teacher creates a board and shows the code or QR code. Students then post anonymous notes from any device. Notes wait for teacher approval before they appear on the board.

- **No database, no logins.** Everything is kept in memory.
- Boards are deleted when the teacher presses **Close board**, after **5 minutes** with the teacher's tab closed, or after **2 hours**, whichever comes first.
- Restarting the container wipes all boards.

| Page | URL (if installed at `/board/`) |
|---|---|
| Teacher | `https://yoursite.com/board/teacher` |
| Students | `https://yoursite.com/board/` (or scan the QR code) |

---

## Deploying (Ubuntu + Docker + Apache)

### 1. Copy the files to the server

Copy this folder to your VPS, e.g. into `/opt/postit-board`. You don't need `node_modules`.

```bash
# from your PC (Git Bash / WSL), or use WinSCP/FileZilla
rsync -av --exclude node_modules ./ user@your-vps:/opt/postit-board/
```

### 2. Set the teacher passphrase

```bash
cd /opt/postit-board
cp .env.example .env
nano .env            # change TEACHER_PASSPHRASE
chmod 600 .env
```

### 3. Start it

```bash
docker compose up -d --build
curl http://127.0.0.1:3000/healthz     # should print: ok
```

The container listens only on `127.0.0.1:3000`, so it can't be reached from the internet directly. It starts again on its own after a reboot.

### 4. Point Apache at it

Enable the proxy modules (one time):

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel
```

Pick **one** of the two options below.

#### Option A: a path on your existing site (easiest: no new DNS or certificate)

Edit your site's **HTTPS** vhost. With Let's Encrypt this is usually `/etc/apache2/sites-available/yoursite-le-ssl.conf`. Add these lines inside `<VirtualHost *:443>`:

```apache
    # --- Post-it Board ---
    RedirectMatch 301 ^/board$ /board/
    <Location /board/>
        ProxyPreserveHost On
        ProxyPass        http://127.0.0.1:3000/ upgrade=websocket
        ProxyPassReverse http://127.0.0.1:3000/
    </Location>
```

You can change `/board/` to any path you like. The app works under any path.

#### Option B: a subdomain, e.g. `board.yoursite.com`

1. Add a DNS **A record** for `board` pointing at your VPS.
2. Create `/etc/apache2/sites-available/postit-board.conf`:

   ```apache
   <VirtualHost *:80>
       ServerName board.yoursite.com
       ProxyPreserveHost On
       ProxyPass        / http://127.0.0.1:3000/ upgrade=websocket
       ProxyPassReverse / http://127.0.0.1:3000/
   </VirtualHost>
   ```

3. Enable it and get a certificate. Certbot creates the HTTPS version for you:

   ```bash
   sudo a2ensite postit-board
   sudo systemctl reload apache2
   sudo certbot --apache -d board.yoursite.com
   ```

#### Then test and reload

```bash
sudo apache2ctl configtest
sudo systemctl reload apache2
```

> **Ubuntu 20.04 or older?** (Apache below 2.4.47, check with `apache2 -v`.) `upgrade=websocket` isn't supported there. Use this instead, and also run `sudo a2enmod rewrite`:
>
> ```apache
>     RewriteEngine On
>     RewriteCond %{HTTP:Upgrade} =websocket [NC]
>     RewriteRule ^/board/ws$ ws://127.0.0.1:3000/ws [P,L]
>     RedirectMatch 301 ^/board$ /board/
>     ProxyPreserveHost On
>     ProxyPass        /board/ http://127.0.0.1:3000/
>     ProxyPassReverse /board/ http://127.0.0.1:3000/
> ```

### 5. Try it

Open `https://yoursite.com/board/teacher` on your PC and create a board. Then open the student link on your phone.

---

## Day-to-day

| Task | Command (in `/opt/postit-board`) |
|---|---|
| See logs | `docker compose logs -f` |
| Restart (wipes all boards) | `docker compose restart` |
| Update after changing files | `docker compose up -d --build` |
| Stop | `docker compose down` |
| Change passphrase | edit `.env`, then `docker compose up -d` |

## Settings (`.env`)

| Setting | Default | Meaning |
|---|---|---|
| `TEACHER_PASSPHRASE` | *(required)* | Needed to create a board. At least 8 characters. |
| `GRACE_MINUTES` | 5 | How long a board survives with no teacher connected |
| `BOARD_MAX_HOURS` | 2 | Hard limit on a board's life |
| `MAX_BOARDS` | 50 | Most boards open at once (server-wide) |
| `MAX_STUDENTS_PER_BOARD` | 40 | Most student devices per board |

## How it works

- `server.js` is a small Node.js server that serves the pages in `public/` and runs one WebSocket endpoint (`/ws`).
- Boards exist only in memory. Nothing is written to disk.
- Teachers prove they own a board with a random token. The token is kept in the browser's local storage, so a refresh or a reopened tab rejoins the board.
- **Safety measures:**
  - Notes are always shown as plain text.
  - Notes need approval before they appear.
  - Students are rate-limited (one note every 3 seconds, 15 notes each).
  - Wrong passphrase attempts are rate-limited.
  - Other websites can't connect to the WebSocket.
  - The pages send a strict Content-Security-Policy.
  - The container runs read-only, as a non-root user.
