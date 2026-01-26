# Kingfisher

A Caido plugin that integrates the [MongoDB Kingfisher](https://github.com/mongodb/kingfisher) secrets scanner. Port of [Burfisher](https://github.com/aleister1102/burfisher) from Burp Suite to Caido.

## Features

- **Context Menu Scanning**: Right-click on any request(s) in History to scan for secrets
- **Sidebar Dashboard**: View all findings in a dedicated panel
- **Batch Scanning**: Scan multiple requests at once
- **Export**: Download findings as JSON
- **Auto-install**: Automatically installs Kingfisher if not found

## Installation

### Prerequisites

- Caido 0.54.0 or newer
- Internet access (for Kingfisher auto-install on first use)

### Install Plugin

1. Download the latest `kingfisher-plugin.zip` from Releases
2. In Caido, go to **Settings → Plugins → Local**
3. Click **Install from file** and select the zip

Or build from source:

```bash
pnpm install
pnpm run build
```

## Usage

### Scanning Requests

1. Open **HTTP History** or any view with HTTP requests
2. Select one or more requests
3. Right-click and select **Scan with Kingfisher**
4. View results in the **Kingfisher** sidebar panel

### Dashboard

The sidebar dashboard shows:

- **Findings Table**: All detected secrets with confidence, rule name, URL, and timestamp
- **Stats Bar**: Total findings, requests scanned, and last scan time
- **Details Panel**: Click any finding to see full details

### Actions

- **Clear All**: Remove all findings
- **Export JSON**: Download findings as a JSON file
- **Refresh**: Reload findings from backend
- **Install/Upgrade Kingfisher**: Manually trigger Kingfisher binary setup

## Supported Secrets

Kingfisher detects 300+ secret types including:

- AWS Access Keys
- API tokens (Stripe, GitHub, OpenAI, etc.)
- Private keys (PEM, SSH)
- Database connection strings
- OAuth credentials
- And many more...

See the [Kingfisher rules](https://github.com/mongodb/kingfisher/tree/main/rules) for the full list.

## Configuration

Currently, the plugin uses Kingfisher's default settings. Future versions may include:

- Confidence threshold filtering
- Custom rules support
- Validation toggle
- Secret masking options

## Troubleshooting

### Kingfisher Binary Not Found

Kingfisher will attempt to auto-install on first use. If installation fails:

#### macOS / Linux
```bash
# Manual install
curl -sL https://raw.githubusercontent.com/mongodb/kingfisher/main/scripts/install-kingfisher.sh | bash
```

Ensure `~/.local/bin` is in your PATH.

#### Windows
Kingfisher will be downloaded and extracted to `%USERPROFILE%\.local\bin\kingfisher.exe`.

If auto-install fails, you can:
1. Download `kingfisher-windows-x64.zip` from [Kingfisher Releases](https://github.com/mongodb/kingfisher/releases)
2. Extract `kingfisher.exe` to a folder on your PATH (or to `%USERPROFILE%\.local\bin\`)

### Scan Timeout

Large requests or many files can cause timeouts. Try scanning fewer requests at once.

### No Findings

- Ensure the request/response contains detectable secrets
- Check that Kingfisher is installed correctly: `kingfisher --version`

## Development

```bash
# Install dependencies
pnpm install

# Development mode (hot reload)
pnpm run watch

# Build
pnpm run build
```

## License

MIT

## Credits

- [MongoDB Kingfisher](https://github.com/mongodb/kingfisher) - The secrets scanner engine
- [Burfisher](https://github.com/aleister1102/burfisher) - Inspiration for features
- [Caido](https://caido.io) - The best web security testing toolkit
