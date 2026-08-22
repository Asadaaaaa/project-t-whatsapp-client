# ProjectT WhatsApp Client

Multi-session WhatsApp Web automation service built on `whatsapp-web.js` and Puppeteer.

## 🚀 Features

- **Multi-Client per User**: Isolated WhatsApp sessions per authenticated user (`session-user_<id>`).
- **On-Demand Date Range Scanner**: Injects internal WhatsApp Web collection extractors with historical pagination to pull messages for any target date on-demand.
- **Database-Synced Session Lifecycle**: Auto-restores valid active sessions and automatically purges orphan disk sessions after database resets.
- **Microservice Architecture**: Exposes lightweight REST endpoints (`/status`, `/qr`, `/connect`, `/disconnect`, `/sync/date`) for the main controller.

## 📦 Getting Started

### Prerequisites
- Node.js 18+
- Chromium / Chrome dependencies

### Installation
```bash
npm install
```

### Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

### Running
```bash
npm start
```
