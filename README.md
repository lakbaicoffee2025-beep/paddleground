# 🏓 Paddle Ground Pickleball – Booking System

A full-featured 3-court booking system built for Netlify.

## Features

### Customer-Facing (`/`)
- Choose one of **3 courts** (Court 1, 2, 3), each with its own availability
- Monthly calendar view to select booking dates (several dates and courts in one checkout)
- Hourly time slots between the opening hours set in admin
- Real-time availability — booked, blocked and reserved slots shown as locked
- **10-minute checkout hold** — tapping **Book Now** reserves the selected slots for 10 minutes
  so nobody else can book them. A live countdown shows at the top of the checkout form;
  when it hits 00:00 the slots are released and the customer is asked to choose again
- Checkout: Details (name, contact number, optional email, notes) → Payment (GCash info + screenshot upload)
- Booking confirmation screen

### Admin Panel (`/admin/`)
- Password-protected login
- Dashboard with today's schedule + monthly/weekly stats
- Monthly calendar view with bookings per day (court shown on each booking)
- Full bookings list with search/filter
- **Edit / rebook bookings** — change date, court, time, name, phone, status
- **Walk-in bookings** on any court, with a 3-court availability grid
- **Block time** on one court or all courts
- **Export to CSV** — monthly or weekly reports (includes court and email)

---

## Deployment to Netlify

### 1. Install dependencies
```bash
npm install
```

### 2. Create a Netlify site
- Go to [netlify.com](https://netlify.com) and create a free account
- Create a new site

### 3. Set environment variables
In your Netlify dashboard → Site settings → Environment variables, add:

```
ADMIN_PASSWORD = your_secure_password_here
```

> The default password (if not set) is `paddleground2026admin` — **change this before going live!**

Optional — super admin (owner's commission report at `/super/`):

```
SUPER_ADMIN_PASSWORD = a_different_secure_password
COMMISSION_PER_HOUR = 10               # optional, defaults to 10 (PHP)
```

The super admin page is disabled until `SUPER_ADMIN_PASSWORD` is set. It lists every
booking transaction made in a month and the commission owed (PHP 10 per booked
hour for online bookings and admin-added walk-ins).

### 4. Deploy via Netlify CLI
```bash
npm install -g netlify-cli
netlify login
netlify deploy --prod
```

Or connect your GitHub repo to Netlify for automatic deploys.

### 5. Enable Netlify Blobs
Netlify Blobs is automatically available on all Netlify sites (no extra setup needed). Data persists across deploys.

---

## Project Structure

```
paddleground/
├── netlify.toml              # Netlify config
├── package.json
├── netlify/
│   └── functions/
│       └── bookings.mjs      # Serverless API (CRUD + auth + checkout locks)
└── public/
    ├── index.html            # Customer booking page
    ├── site-content.js       # Editable site text defaults
    ├── admin/
    │   └── index.html        # Admin dashboard
    └── super/
        └── index.html        # Owner's commission report
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/bookings?month=YYYY-MM` | List bookings |
| POST | `/api/bookings` | Create booking (`court` 1–3, optional `lockToken`) |
| GET | `/api/bookings/:id` | Get single booking |
| PUT | `/api/bookings/:id` | Update booking (admin) |
| DELETE | `/api/bookings/:id` | Cancel booking (admin) |
| POST | `/api/bookings/lock` | Hold slots for 10 minutes (`items: [{date, court, startHour, endHour}]`) |
| POST | `/api/bookings/lock/release` | Release a hold (`token`) |
| GET | `/api/bookings/locks?month=YYYY-MM` | Slots currently held by customers checking out |

## Notes
- Payment screenshots are stored as base64 in Netlify Blobs
- Booking conflicts are checked server-side, per court. Held slots count as taken for everyone
  except the customer holding them; if two customers tap Book Now at the same moment, the earlier one keeps the slot
- Bookings made without a court (e.g. imported old data) count as Court 1; a block without a court closes all courts
- Only the first letter of a booker's name is shown to other customers (privacy)
