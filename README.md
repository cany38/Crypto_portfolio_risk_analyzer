# Instagram Usage Time Analyzer

Analyzes your Instagram data export ZIP file directly in your browser. Upload the archive, get interactive charts and detailed markdown export of your actual usage duration.

Built because there is no total usage time metric on Instagram settings. The export file you download from accounts.instagram.com has the data — this tool turns it into minutes, hours and days.

## What it shows

- **Total estimated time** in hours, converted to days
- **Counted sessions** — how many times you pressed buttons or liked posts inside the same session
- **Active days** — which calendar days you opened Instagram (not just installed)
- **Daily average** from first activity to last
- **Monthly breakdown** — months you lived on the platform vs months you barely touched it
- **Hourly distribution** — when you are active during the day
- **Device list** — which mobile model you used over the years
- **Location map** — where you pressed "login" based on IP geolocation
- **Markdown report** — download a clean .md file with all tables

## How to prepare

Download your data from Instagram:

```text
Accounts Center → Your information and permissions → Download your information
Format: JSON
Date range: All time
Request full export (10+ minutes if your account is old)
```

After it arrives via email, you have `instagram-yourusername-xxxx-xx-xx.zip` (about 1-2 GB).

## How to analyze

Extract the ZIP, open the tool, drag the ZIP onto the upload area. Wait a moment.

```text
Estimated Total: 2,487 hours ≈ 103 days
Counted Sessions: 1,9824
Active Days: 1,473 / 2,403 days = 61.3%
Top Month: May 2020 (135 hours)
```

## Status

Alpha. Works with large exports from 2015-present. Known limits:

- HTML export from Instagram is not JSON, tool requires JSON format
- Session estimates are empirical; actual screen-open time could be 10-25% higher
- First and last logins anchor the date range; entries outside those years are ignored

## License

MIT. Software provided as-is with no relation to Meta. Instagram is a trademark of Meta Platforms, Inc.
